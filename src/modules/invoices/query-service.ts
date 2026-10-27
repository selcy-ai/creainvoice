// src/modules/invoices/query-service.ts
// Feature 08 — the full-featured invoice list behind `/invoices`:
// server-side pagination + search + filters + sort, always org-scoped, with
// per-row action permissions computed on the SERVER (the client only renders
// the flags it is handed — no role strings outside modules/permissions).
//
//   • One `where` per query: org id first, then search (number / numberPreview /
//     customer), filters (customer, profile, status, invoice type, date range)
//     and an EFFECTIVE status clause — OVERDUE is a read-time status (feature
//     05), so filtering by it (and by the statuses it can shadow) must agree
//     with what the badge shows.
//   • Search deliberately includes `numberPreview`: in an invoice list a hit
//     on a preview points at the very draft that carries it (the payments list
//     excludes previews because a payment row would be misattributed — that
//     tradeoff does not apply here).
//   • Row actions are only flagged where the SERVICE behind them would accept
//     the call (status guards + permission matrix together), so the menu never
//     offers a button that would bounce.

import { AppError } from "@/lib/errors";
import { parseCalendarDate, toCalendarInput, todayInJakarta } from "@/lib/date";
import { roundMoney } from "@/lib/money";
import { assertCan, can, requireOrgScope } from "@/modules/workspace/permissions";
import {
  CANCELABLE_STATUSES,
  OVERDUE_ELIGIBLE_STATUSES,
  REVISABLE_STATUSES,
} from "@/modules/invoices/lifecycle-service";
import { isPayable, remainingAfterPayment } from "@/modules/payments/status";
import { db } from "@/server/db";
import { customers, invoiceProfiles, invoices, users } from "@/db/schema";
import { and, asc, count, desc, eq, gte, ilike, inArray, isNotNull, isNull, lt, lte, or, type SQL } from "drizzle-orm";
import type { InvoiceServiceContext } from "@/modules/invoices/service";
import type { InvoiceStatus, InvoiceType } from "@/db/enums";

/** Rows per page (client-safe module — never import page sizes from a
 * "use client" file into a server page, feature 07 lesson). */
export const INVOICES_PAGE_SIZE = 20;
/** Hard cap: a page is a screen, not a data dump. */
export const MAX_INVOICES_PAGE_SIZE = 100;
/** Quick search (Cmd+K palette) and filter dropdown ceilings. */
export const QUICK_SEARCH_LIMIT = 8;
export const FILTER_OPTION_LIMIT = 200;

/** Columns the list may sort by (whitelist — never interpolate raw input). */
export const INVOICE_SORT_FIELDS = [
  "invoiceDate",
  "dueDate",
  "number",
  "grandTotal",
  "customer",
] as const;
export type InvoiceSortField = (typeof INVOICE_SORT_FIELDS)[number];
export type SortDirection = "asc" | "desc";

/** Status filter values: every stored status plus the read-time OVERDUE. */
export const INVOICE_STATUS_FILTERS: readonly InvoiceStatus[] = [
  "DRAFT",
  "ISSUED",
  "SENT",
  "PARTIALLY_PAID",
  "PAID",
  "OVERDUE",
  "CANCELLED",
  "REVISED",
];

export type InvoiceStatusFilter = (typeof INVOICE_STATUS_FILTERS)[number];

export interface InvoiceListQuery {
  page?: number;
  pageSize?: number;
  /** Free text: invoice number / number preview / customer name. */
  search?: string;
  /** Customer id (must be one of the org's — foreign ids simply match 0 rows). */
  customer?: string;
  /** Invoice profile id. */
  profile?: string;
  /** Stored status or the read-time `OVERDUE`. */
  status?: string;
  /** Invoice type (FULL / DOWN_PAYMENT / …). */
  type?: string;
  /** Inclusive invoice-date range, "YYYY-MM-DD". */
  from?: string;
  to?: string;
  sort?: string;
  dir?: string;
}

/** What the row action menu may render for THIS row (server-computed). */
export interface InvoiceRowPermissions {
  /** Open / preview the invoice detail. */
  view: boolean;
  /** Continue editing a draft. */
  edit: boolean;
  /** DRAFT → ISSUED. */
  issue: boolean;
  /** ISSUED → SENT. */
  markSent: boolean;
  /** Cancel (mandatory reason, OWNER/ADMIN). */
  cancel: boolean;
  /** Create a revision copy. */
  revise: boolean;
  /** Delete the draft. */
  remove: boolean;
  /** Duplicate a draft into a new draft. */
  duplicate: boolean;
  /** Download the official PDF (only once the file exists). */
  downloadPdf: boolean;
  /** Record a payment against this row. */
  recordPayment: boolean;
  /** Start a settlement invoice for this row's project. */
  createSettlement: boolean;
}

export interface InvoiceListRow {
  id: string;
  /** Final number, or the non-binding preview while still a draft. */
  label: string;
  number: string | null;
  numberPreview: string | null;
  /** Stored status. */
  status: InvoiceStatus;
  /** Status to DISPLAY — OVERDUE is computed on read (feature 05). */
  displayStatus: InvoiceStatus;
  invoiceType: InvoiceType;
  invoiceDate: string;
  dueDate: string | null;
  customerName: string;
  referenceNumber: string | null;
  grandTotal: string;
  amountPaid: string;
  profileId: string;
  profileName: string;
  createdByName: string;
  projectId: string | null;
  /** True when the official PDF file exists (download is a real link then). */
  pdfReady: boolean;
  /** Non-null when a payment may be recorded from this row (feature 07 dialog). */
  payment: {
    id: string;
    label: string;
    customerName: string;
    status: InvoiceStatus;
    grandTotal: string;
    amountPaid: string;
    remaining: string;
  } | null;
  permissions: InvoiceRowPermissions;
}

export interface InvoiceListResult {
  rows: InvoiceListRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface InvoiceFilterOptions {
  customers: Array<{ id: string; companyName: string }>;
  profiles: Array<{ id: string; name: string }>;
}

// ─── Query normalization (server-side validation) ─────────────────────────

function first(value: string | undefined): string {
  return (value ?? "").trim();
}

/** "YYYY-MM-DD" → Date range; a present-but-malformed value is an ERROR
 * (never silently dropped), and the whole "to" day is included. */
function invoiceDateRange(
  from: string | undefined,
  to: string | undefined,
): { gte?: Date; lte?: Date } | null {
  const rawFrom = first(from);
  const rawTo = first(to);
  if (!rawFrom && !rawTo) return null;

  const parse = (value: string, label: string): Date => {
    const parsed = parseCalendarDate(value);
    if (
      !parsed ||
      Number.isNaN(parsed.getTime()) ||
      toCalendarInput(parsed.toISOString()) !== value
    ) {
      throw new AppError("VALIDATION_ERROR", `Format tanggal ${label} tidak valid.`);
    }
    return parsed;
  };

  const range: { gte?: Date; lte?: Date } = {};
  if (rawFrom) range.gte = parse(rawFrom, "mulai");
  if (rawTo) {
    const end = parse(rawTo, "akhir");
    // invoiceDate is stored as UTC midnight — include the whole "to" day.
    range.lte = new Date(end.getTime() + 24 * 60 * 60 * 1000 - 1);
  }
  if (range.gte && range.lte && range.gte.getTime() > range.lte.getTime()) {
    throw new AppError("VALIDATION_ERROR", "Rentang tanggal tidak valid.");
  }
  return range;
}

function statusFilter(value: string | undefined): InvoiceStatusFilter | null {
  const raw = first(value);
  if (!raw) return null;
  if ((INVOICE_STATUS_FILTERS as readonly string[]).includes(raw)) {
    return raw as InvoiceStatusFilter;
  }
  throw new AppError("VALIDATION_ERROR", "Status filter tidak valid.");
}

function typeFilter(value: string | undefined): InvoiceType | null {
  const raw = first(value);
  if (!raw) return null;
  const known: readonly string[] = [
    "DOWN_PAYMENT",
    "SETTLEMENT",
    "FULL",
    "TERM",
    "CUSTOM",
  ];
  if (!known.includes(raw)) {
    throw new AppError("VALIDATION_ERROR", "Jenis invoice tidak valid.");
  }
  return raw as InvoiceType;
}

function sortSpec(
  sort: string | undefined,
  dir: string | undefined,
): { field: InvoiceSortField; direction: SortDirection } {
  const field = first(sort);
  const rawDir = first(dir);
  const direction: SortDirection = rawDir === "asc" ? "asc" : "desc";
  if (!field) return { field: "invoiceDate", direction };
  if (!(INVOICE_SORT_FIELDS as readonly string[]).includes(field)) {
    // Unknown column from a hand-edited URL: fall back to the default order
    // rather than failing the page (validation by normalization).
    return { field: "invoiceDate", direction };
  }
  return { field: field as InvoiceSortField, direction };
}

/**
 * Effective-status clause. The badge shows OVERDUE for an eligible status past
 * its due date, so:
 *   OVERDUE → eligible AND dueDate before today (Jakarta)
 *   ISSUED/SENT/PARTIALLY_PAID → stored status, minus the rows the badge
 *                                already reports as OVERDUE
 *   everything else → the stored status
 */
function statusWhere(status: InvoiceStatusFilter, now: Date): SQL | undefined {
  const startOfToday = new Date(`${todayInJakarta(now)}T00:00:00.000Z`);
  if (status === "OVERDUE") {
    // Feature 11A: the maintenance sweep now PERSISTS OVERDUE, so a stored
    // OVERDUE row must match the filter too (it cannot fall through the `in`
    // clause — otherwise the "chase late payments" list comes back empty).
    return or(
      and(
        inArray(invoices.status, [...OVERDUE_ELIGIBLE_STATUSES]),
        isNotNull(invoices.dueDate),
        lt(invoices.dueDate, startOfToday),
      ),
      eq(invoices.status, "OVERDUE"),
    );
  }
  if (OVERDUE_ELIGIBLE_STATUSES.includes(status)) {
    return and(
      eq(invoices.status, status),
      or(isNull(invoices.dueDate), gte(invoices.dueDate, startOfToday)),
    );
  }
  return eq(invoices.status, status);
}

type OrderByExpr = SQL;

function orderBy(
  spec: { field: InvoiceSortField; direction: SortDirection },
): OrderByExpr[] {
  const dir = (column: Parameters<typeof asc>[0]) =>
    spec.direction === "asc" ? asc(column) : desc(column);
  const primary: OrderByExpr =
    spec.field === "number"
      ? dir(invoices.number)
      : spec.field === "grandTotal"
        ? dir(invoices.grandTotal)
        : spec.field === "dueDate"
          ? dir(invoices.dueDate)
          : spec.field === "customer"
            ? dir(customers.companyName)
            : dir(invoices.invoiceDate);
  // Stable pagination: every sort ends in invoiceDate + id tiebreakers.
  return [
    primary,
    dir(invoices.invoiceDate),
    dir(invoices.id),
  ];
}


// ─── The list ─────────────────────────────────────────────────────────────

/**
 * Server-side invoice list (spec feature 08). `invoice.view` is the gate —
 * VIEWER, STAFF and OWNER/ADMIN all read the same org-scoped rows; only the
 * per-row ACTION flags differ.
 */
export async function listInvoices(
  ctx: InvoiceServiceContext,
  query: InvoiceListQuery = {},
): Promise<InvoiceListResult> {
  assertCan("invoice.view", ctx.scope);
  requireOrgScope(ctx.scope);

  const now = new Date();
  const pageSize = Math.min(
    Math.max(query.pageSize ?? INVOICES_PAGE_SIZE, 1),
    MAX_INVOICES_PAGE_SIZE,
  );
  const search = first(query.search).slice(0, 100);
  const customer = first(query.customer);
  const profile = first(query.profile);
  const status = statusFilter(query.status);
  const invoiceType = typeFilter(query.type);
  const range = invoiceDateRange(query.from, query.to);
  const sort = sortSpec(query.sort, query.dir);

  const org = eq(invoices.organizationId, ctx.scope.organizationId);
  const filters: SQL[] = [org];
  if (search) {
    filters.push(
      or(
        ilike(invoices.number, `%${search}%`),
        ilike(invoices.numberPreview, `%${search}%`),
        ilike(customers.companyName, `%${search}%`),
      )!,
    );
  }
  if (customer) filters.push(eq(invoices.customerId, customer));
  if (profile) filters.push(eq(invoices.profileId, profile));
  if (invoiceType) filters.push(eq(invoices.invoiceType, invoiceType));
  const statusClause = status ? statusWhere(status, now) : undefined;
  if (status && statusClause) filters.push(statusClause);
  if (range) {
    if (range.gte) filters.push(gte(invoices.invoiceDate, range.gte));
    if (range.lte) filters.push(lte(invoices.invoiceDate, range.lte));
  }
  const where = and(...filters);

  const totalRows = await db
    .select({ value: count() })
    .from(invoices)
    .leftJoin(customers, eq(customers.id, invoices.customerId))
    .where(where);
  const total = Number(totalRows[0]?.value ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(query.page ?? 1, 1), totalPages);

  const rows = await db
    .select({
      id: invoices.id,
      number: invoices.number,
      numberPreview: invoices.numberPreview,
      status: invoices.status,
      dueDate: invoices.dueDate,
      invoiceType: invoices.invoiceType,
      invoiceDate: invoices.invoiceDate,
      grandTotal: invoices.grandTotal,
      amountPaid: invoices.amountPaid,
      referenceNumber: invoices.referenceNumber,
      pdfPath: invoices.pdfPath,
      profileId: invoices.profileId,
      projectReferenceId: invoices.projectReferenceId,
      customerCompany: customers.companyName,
      profileName: invoiceProfiles.name,
      createdByName: users.name,
      createdByUsername: users.username,
    })
    .from(invoices)
    .leftJoin(customers, eq(customers.id, invoices.customerId))
    .leftJoin(invoiceProfiles, eq(invoiceProfiles.id, invoices.profileId))
    .leftJoin(users, eq(users.id, invoices.createdById))
    .where(where)
    .orderBy(...orderBy(sort))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return {
    rows: rows.map((row) => toListRow(row, ctx, now)),
    total,
    page,
    pageSize,
    totalPages,
  };
}

interface ListRowPayload {
  id: string;
  number: string | null;
  numberPreview: string | null;
  status: InvoiceStatus;
  dueDate: Date | null;
  invoiceType: InvoiceType;
  invoiceDate: Date;
  grandTotal: string;
  amountPaid: string;
  referenceNumber: string | null;
  pdfPath: string | null;
  profileId: string;
  projectReferenceId: string | null;
  customerCompany: string | null;
  profileName: string | null;
  createdByName: string | null;
  createdByUsername: string | null;
}

function toListRow(
  row: ListRowPayload,
  ctx: InvoiceServiceContext,
  now: Date,
): InvoiceListRow {
  const { scope } = ctx;
  const label = row.number ?? row.numberPreview ?? "—";
  const grandTotal = roundMoney(row.grandTotal.toString());
  const amountPaid = roundMoney(row.amountPaid.toString());

  // Permission (role) ∧ status guard — mirrors what each service would accept.
  const isDraft = row.status === "DRAFT";
  const permissions: InvoiceRowPermissions = {
    view: can("invoice.view", scope),
    edit: can("invoice.draft.update", scope) && isDraft,
    issue: can("invoice.issue", scope) && isDraft,
    markSent: can("invoice.markSent", scope) && row.status === "ISSUED",
    cancel: can("invoice.cancel", scope) && CANCELABLE_STATUSES.includes(row.status),
    revise: can("invoice.revise", scope) && REVISABLE_STATUSES.includes(row.status),
    remove: can("invoice.draft.delete", scope) && isDraft,
    duplicate: can("invoice.draft.create", scope) && isDraft,
    downloadPdf: can("invoice.download", scope) && row.pdfPath !== null,
    recordPayment: can("payment.record", scope) && isPayable(row.status),
    createSettlement:
      can("invoice.draft.create", scope) && row.projectReferenceId !== null,
  };

  return {
    id: row.id,
    label,
    number: row.number,
    numberPreview: row.numberPreview,
    status: row.status,
    displayStatus:
      OVERDUE_ELIGIBLE_STATUSES.includes(row.status) &&
      row.dueDate !== null &&
      toCalendarInput(row.dueDate.toISOString()) < todayInJakarta(now)
        ? "OVERDUE"
        : row.status,
    invoiceType: row.invoiceType,
    invoiceDate: toCalendarInput(row.invoiceDate.toISOString()),
    dueDate: row.dueDate ? toCalendarInput(row.dueDate.toISOString()) : null,
    customerName: row.customerCompany ?? "—",
    referenceNumber: row.referenceNumber,
    grandTotal,
    amountPaid,
    profileId: row.profileId,
    profileName: row.profileName ?? "—",
    createdByName: row.createdByName || row.createdByUsername || "—",
    projectId: row.projectReferenceId,
    pdfReady: row.pdfPath !== null,
    payment: permissions.recordPayment
      ? {
          id: row.id,
          label,
          customerName: row.customerCompany ?? "—",
          status: row.status,
          grandTotal,
          amountPaid,
          remaining: remainingAfterPayment(grandTotal, amountPaid),
        }
      : null,
    permissions,
  };
}

/**
 * Dropdown data for the filter bar (customer + profile of THIS org), gated by
 * `invoice.view` — VIEWERs filter too. Capped: this is a picker, not an export.
 */
export async function listInvoiceFilterOptions(
  ctx: InvoiceServiceContext,
): Promise<InvoiceFilterOptions> {
  assertCan("invoice.view", ctx.scope);
  requireOrgScope(ctx.scope);

  const [customerRows, profileRows] = await Promise.all([
    db
      .select({ id: customers.id, companyName: customers.companyName })
      .from(customers)
      .where(
        and(
          eq(customers.organizationId, ctx.scope.organizationId),
          isNull(customers.deletedAt),
        ),
      )
      .orderBy(asc(customers.companyName))
      .limit(FILTER_OPTION_LIMIT),
    db
      .select({ id: invoiceProfiles.id, name: invoiceProfiles.name })
      .from(invoiceProfiles)
      .where(eq(invoiceProfiles.organizationId, ctx.scope.organizationId))
      .orderBy(asc(invoiceProfiles.name))
      .limit(FILTER_OPTION_LIMIT),
  ]);

  return { customers: customerRows, profiles: profileRows };
}

export interface InvoiceQuickMatch {
  id: string;
  label: string;
  customerName: string;
  status: InvoiceStatus;
  displayStatus: InvoiceStatus;
  invoiceDate: string;
  grandTotal: string;
}

/**
 * Cmd+K lookup: invoices whose number / preview / customer match `q`, newest
 * first, org-scoped, capped (spec: "command search … cari invoice by nomor").
 */
export async function quickSearchInvoices(
  ctx: InvoiceServiceContext,
  query: { q?: string; limit?: number } = {},
): Promise<InvoiceQuickMatch[]> {
  assertCan("invoice.view", ctx.scope);
  requireOrgScope(ctx.scope);

  const q = first(query.q).slice(0, 100);
  if (q.length === 0) return [];
  const limit = Math.min(Math.max(query.limit ?? QUICK_SEARCH_LIMIT, 1), QUICK_SEARCH_LIMIT);

  const rows = await db
    .select({
      id: invoices.id,
      number: invoices.number,
      numberPreview: invoices.numberPreview,
      status: invoices.status,
      dueDate: invoices.dueDate,
      invoiceDate: invoices.invoiceDate,
      grandTotal: invoices.grandTotal,
      customerCompany: customers.companyName,
    })
    .from(invoices)
    .leftJoin(customers, eq(customers.id, invoices.customerId))
    .where(
      and(
        eq(invoices.organizationId, ctx.scope.organizationId),
        or(
          ilike(invoices.number, `%${q}%`),
          ilike(invoices.numberPreview, `%${q}%`),
          ilike(customers.companyName, `%${q}%`),
        )!,
      ),
    )
    .orderBy(desc(invoices.invoiceDate), desc(invoices.id))
    .limit(limit);

  const now = new Date();
  return rows.map((row) => ({
    id: row.id,
    label: row.number ?? row.numberPreview ?? "—",
    customerName: row.customerCompany ?? "—",
    status: row.status,
    displayStatus:
      OVERDUE_ELIGIBLE_STATUSES.includes(row.status) &&
      row.dueDate !== null &&
      toCalendarInput(row.dueDate.toISOString()) < todayInJakarta(now)
        ? "OVERDUE"
        : row.status,
    invoiceDate: toCalendarInput(row.invoiceDate.toISOString()),
    grandTotal: roundMoney(row.grandTotal.toString()),
  }));
}
