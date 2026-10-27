// src/modules/payments/service.ts
// Payment domain (feature 07): record a manual payment against an open
// invoice, reverse one (OWNER/ADMIN), and read the riwayat — org-scoped,
// permission-checked in the service, every money move inside ONE transaction
// that also recomputes the LIVE payment columns and writes the audit row.
//
//   • amountPaid        = SUM of the payment rows (recomputed server-side,
//                         never taken from the client — invariant 2)
//   • remainingAfter    = max(0, grandTotal − amountPaid)
//   • status            = recomputePaymentStatus(...) — PARTIALLY_PAID / PAID
//
// The seven snapshots are NEVER touched: payments are not part of the
// document (invariant 4/5), so the issued/PDF data stays frozen while
// amountPaid + remainingAfter move on the live row.

import Decimal from "decimal.js";
import { AppError } from "@/lib/errors";
import type { WorkspaceScope } from "@/modules/workspace/service";
import { db } from "@/server/db";
import { customers, invoices, payments, users } from "@/db/schema";
import { and, count, desc, eq, gte, ilike, inArray, lte, or, sql, sum, type SQL } from "drizzle-orm";
import { logger } from "@/server/logger";
import { firstZodMessage } from "@/lib/validation";
import { parseCalendarDate, toCalendarInput } from "@/lib/date";
import { log } from "@/modules/audit/service";
import { assertCan, can, requireOrgScope } from "@/modules/workspace/permissions";
import { getStorageService } from "@/modules/storage";
import {
  PAYABLE_STATUSES,
  assertPayable,
  isPayable,
  recomputePaymentStatus,
  remainingAfterPayment,
} from "@/modules/payments/status";
import {
  recordPaymentPayloadSchema,
  type PaymentMethodValue,
  type RecordPaymentPayload,
} from "@/modules/payments/schema";
import type { InvoiceStatus } from "@/db/enums";
// Change 6: dropped OrganizationRole, Prisma (role tiers removed)

/** Storage sub-directory for payment proofs (architecture-context storage
 * model: uploads/organizations/{orgId}/payment-proofs/{uuid}.{ext}). */
export const PROOF_KIND = "payment-proofs";

/** Proof content types — decided by magic-byte sniffing in validateUpload,
 * never by the filename or the declared type. */
export const PROOF_MIME_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

/** Hard cap for the /payments + payable-invoice lists (pagination limit —
 * never an unbounded read). */
export const MAX_LIST_PAGE_SIZE = 100;
const PAYABLE_INVOICE_LIMIT = 100;

export interface PaymentServiceContext {
  scope: WorkspaceScope;
  request?: Request | null;
}

// ─── Views (serializable — server action → client components) ─────────────

export interface PaymentRowView {
  id: string;
  invoiceId: string;
  /** Invoice number (or the draft preview / honest fallback). */
  invoiceLabel: string;
  customerId: string;
  customerName: string;
  /** "YYYY-MM-DD" (calendar day, displayed in Asia/Jakarta). */
  paymentDate: string;
  /** Decimal string. */
  amount: string;
  method: PaymentMethodValue;
  referenceNumber: string | null;
  notes: string | null;
  overpaymentReason: string | null;
  proofPath: string | null;
  recordedByName: string;
  createdAt: string;
}

export interface PaymentListResult {
  rows: PaymentRowView[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface PaymentListQuery {
  page?: number;
  pageSize?: number;
  /** Invoice number / numberPreview fragment. */
  invoice?: string;
  /** Customer company-name fragment. */
  customer?: string;
  /** "YYYY-MM-DD" range on paymentDate (inclusive). */
  from?: string;
  to?: string;
}

export interface PaymentOutcome {
  paymentId: string;
  invoiceId: string;
  status: InvoiceStatus;
  /** Decimal string — recomputed SUM of the invoice's payments. */
  amountPaid: string;
  /** Decimal string — max(0, grandTotal − amountPaid). */
  remainingAfter: string;
}

export interface PaymentPanelPermissions {
  /** Record Payment button — STAFF+ and only where the service accepts it. */
  record: boolean;
  /** Reversal (delete) — OWNER/ADMIN only. */
  reverse: boolean;
  /** Overpayment override with a reason (else a plain confirmation). */
  override: boolean;
}

/** The invoice detail read model for the "Riwayat pembayaran" card. */
export interface InvoicePaymentPanel {
  invoiceId: string;
  invoiceLabel: string;
  customerName: string;
  status: InvoiceStatus;
  grandTotal: string;
  amountPaid: string;
  remainingAfter: string;
  rows: PaymentRowView[];
  /** True when more payments exist than the display cap returns. */
  truncated: boolean;
  permissions: PaymentPanelPermissions;
}

/** A payable invoice in the record-payment picker (/payments page). */
export interface PayableInvoiceOption {
  id: string;
  label: string;
  customerName: string;
  status: InvoiceStatus;
  grandTotal: string;
  amountPaid: string;
  /** max(0, grandTotal − amountPaid) — decimal string. */
  remaining: string;
}


/** Newest first, with `id` as the final tiebreaker so pagination is stable. */
async function loadRows(where: SQL | undefined, page?: { offset: number; limit: number }) {
  return db
    .select({
      payment: payments,
      invoiceId: invoices.id,
      invoiceNumber: invoices.number,
      invoiceNumberPreview: invoices.numberPreview,
      invoiceCustomerId: invoices.customerId,
      invoiceStatus: invoices.status,
      invoiceGrandTotal: invoices.grandTotal,
      invoiceAmountPaid: invoices.amountPaid,
      invoiceRemainingAfter: invoices.remainingAfter,
      invoiceCustomerCompany: customers.companyName,
      createdByName: users.name,
      createdByUsername: users.username,
    })
    .from(payments)
    .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
    .leftJoin(customers, eq(customers.id, invoices.customerId))
    .leftJoin(users, eq(users.id, payments.createdById))
    .where(where)
    .orderBy(desc(payments.paymentDate), desc(payments.createdAt), desc(payments.id))
    .limit(page?.limit ?? 100)
    .offset(page?.offset ?? 0);
}

function invoiceLabel(row: {
  number: string | null;
  numberPreview: string | null;
}): string {
  return row.number ?? row.numberPreview ?? "Draft";
}

type PaymentJoinedRow = Awaited<ReturnType<typeof loadRows>>[number];

function toPaymentRow(row: PaymentJoinedRow): PaymentRowView {
  const invoice = {
    id: row.invoiceId,
    number: row.invoiceNumber,
    numberPreview: row.invoiceNumberPreview,
    customerId: row.invoiceCustomerId,
    status: row.invoiceStatus,
    grandTotal: row.invoiceGrandTotal,
    amountPaid: row.invoiceAmountPaid,
    remainingAfter: row.invoiceRemainingAfter,
    customer: { companyName: row.invoiceCustomerCompany },
  };
  const payment = row.payment;
  return {
    id: payment.id,
    invoiceId: invoice.id,
    invoiceLabel: invoiceLabel(invoice),
    customerId: invoice.customerId,
    customerName: invoice.customer.companyName ?? "—",
    paymentDate: toCalendarInput(payment.paymentDate.toISOString()),
    amount: payment.amount,
    method: payment.method,
    referenceNumber: payment.referenceNumber,
    notes: payment.notes,
    overpaymentReason: payment.overpaymentReason,
    proofPath: payment.proofPath,
    recordedByName: row.createdByName ?? row.createdByUsername ?? payment.createdById,
    createdAt: payment.createdAt.toISOString(),
  };
}

function money(value: Decimal | string): string {
  return new Decimal(value).toFixed(2);
}

// ─── Record payment (STAFF+, transactional) ──────────────────────────────

export async function recordPayment(
  invoiceId: string,
  input: RecordPaymentPayload,
  ctx: PaymentServiceContext,
  options: { proof?: File | null } = {},
): Promise<PaymentOutcome> {
  assertCan("payment.record", ctx.scope);
  requireOrgScope(ctx.scope);

  if (!invoiceId) {
    throw new AppError("VALIDATION_ERROR", "Invoice wajib dipilih.");
  }
  const parsed = recordPaymentPayloadSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError("VALIDATION_ERROR", firstZodMessage(parsed.error));
  }
  const values = parsed.data;
  const amount = new Decimal(values.amount);
  if (amount.lte(0)) {
    throw new AppError("VALIDATION_ERROR", "Nominal harus lebih dari 0.");
  }
  const paymentDate = parseCalendarDate(values.paymentDate);
  if (!paymentDate || Number.isNaN(paymentDate.getTime())) {
    throw new AppError("VALIDATION_ERROR", "Tanggal pembayaran tidak valid.");
  }

  // Proof upload BEFORE the transaction: a validation error (over 2 MB, fake
  // MIME) never opens a transaction, and a failed transaction cleans the
  // already-written file up below (best-effort — storage is not transactional).
  const proof = options.proof ?? null;
  const storedProof =
    proof && proof.size > 0
      ? await getStorageService().upload(proof, {
          orgId: ctx.scope.organizationId,
          kind: PROOF_KIND,
          allowedMimeTypes: PROOF_MIME_TYPES,
        })
      : null;

  try {
    return await db.transaction(
      async (tx) => {
        // Row lock: two concurrent recordings on the same invoice serialize
        // here, so the SUM + status recompute can never race.
        await tx.execute(sql`SELECT id FROM "invoice" WHERE id = ${invoiceId} FOR UPDATE`);
        const invoiceRows = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
        const invoice = invoiceRows[0];
        if (!invoice || invoice.organizationId !== ctx.scope.organizationId) {
          // IDOR guard: a foreign invoice id answers 404, never 403.
          throw new AppError("NOT_FOUND", "Invoice tidak ditemukan.");
        }
        // DRAFT / CANCELLED / REVISED are rejected (spec) — checked on the
        // FRESH row inside the lock, not on a stale read from the page.
        assertPayable(invoice.status);

        const grandTotal = new Decimal(invoice.grandTotal.toString());
        const paidBefore = new Decimal(invoice.amountPaid.toString());
        const remaining = grandTotal.minus(paidBefore);
        const overpayment = amount.gt(remaining);
        if (overpayment) {
          // Spec: STAFF needs a confirmation, OWNER/ADMIN override with a
          // reason. Both are re-validated HERE — the client's checkbox or
          // textarea is never trusted on its own.
          const reason = (values.overpaymentReason ?? "").trim();
          if (can("payment.override", ctx.scope)) {
            if (reason.length === 0) {
              throw new AppError(
                "VALIDATION_ERROR",
                `Nominal melebihi sisa tagihan ${money(remaining)} — alasan override wajib diisi.`,
                { remaining: money(remaining) },
              );
            }
          } else if (!values.confirmOverpayment) {
            throw new AppError(
              "VALIDATION_ERROR",
              `Nominal melebihi sisa tagihan ${money(remaining)} — konfirmasi untuk melanjutkan.`,
              { remaining: money(remaining) },
            );
          }
        }

        const createdPayment = await tx
          .insert(payments)
          .values({
            organizationId: ctx.scope.organizationId,
            invoiceId,
            paymentDate,
            amount: money(amount),
            method: values.method,
            referenceNumber: values.referenceNumber?.trim() || null,
            notes: values.notes?.trim() || null,
            proofPath: storedProof?.path ?? null,
            overpaymentReason: overpayment ? (values.overpaymentReason ?? "").trim() || null : null,
            createdById: ctx.scope.userId,
          })
          .returning();
        const payment = createdPayment[0];
        if (!payment) throw new AppError("INTERNAL_ERROR", "Pembayaran gagal dicatat.");

        // The invoice's money comes from the ROWS, always.
        const sumRows = await tx
          .select({ total: sum(payments.amount) })
          .from(payments)
          .where(eq(payments.invoiceId, invoiceId));
        const amountPaid = new Decimal(sumRows[0]?.total ?? "0");
        const status = recomputePaymentStatus({
          status: invoice.status,
          grandTotal: money(grandTotal),
          amountPaid: money(amountPaid),
        });

        await tx
          .update(invoices)
          .set({
            amountPaid: money(amountPaid),
            remainingAfter: remainingAfterPayment(money(grandTotal), money(amountPaid)),
            status,
          })
          .where(eq(invoices.id, invoiceId));

        // Metadata: ids, money and flags only — no free text beyond the
        // reason LENGTH, and never an account number (security-standards).
        await log(
          {
            actorUserId: ctx.scope.userId,
            organizationId: ctx.scope.organizationId,
            action: "PAYMENT_RECORDED",
            entityType: "payment",
            entityId: payment.id,
            metadata: {
              invoiceId,
              invoiceNumber: invoice.number ?? invoice.numberPreview ?? null,
              amount: money(amount),
              method: values.method,
              status,
              overpayment,
              ...(overpayment
                ? { reasonLength: (values.overpaymentReason ?? "").trim().length }
                : {}),
              hasProof: storedProof !== null,
            },
            request: ctx.request ?? null,
          },
          tx,
        );

        return {
          paymentId: payment.id,
          invoiceId,
          status,
          amountPaid: money(amountPaid),
          remainingAfter: remainingAfterPayment(money(grandTotal), money(amountPaid)),
        };
      },
    );
  } catch (error) {
    if (storedProof) {
      await getStorageService()
        .delete(storedProof.path)
        .catch((err: unknown) =>
          logger.warn(
            { module: "payments", err: err instanceof Error ? err.message : String(err) },
            "bukti pembayaran gagal dibersihkan setelah transaksi gagal",
          ),
        );
    }
    throw error;
  }
}

// ─── Delete payment / reversal (OWNER/ADMIN) ─────────────────────────────

/**
 * Reversal: the row (and its proof file) is removed, the invoice's payment
 * columns are recomputed from the remaining rows, and the audit keeps the
 * fact with `metadata.reversed = true` (spec step 6). A CANCELLED/REVISED
 * invoice keeps its status — a reversal never resurrects a closed document.
 */
export async function deletePayment(
  paymentId: string,
  ctx: PaymentServiceContext,
): Promise<PaymentOutcome> {
  assertCan("payment.delete", ctx.scope);
  requireOrgScope(ctx.scope);

  if (!paymentId) {
    throw new AppError("VALIDATION_ERROR", "Pembayaran tidak valid.");
  }
  const existingRows = await db.select().from(payments).where(eq(payments.id, paymentId)).limit(1);
  const existing = existingRows[0];
  if (!existing || existing.organizationId !== ctx.scope.organizationId) {
    // IDOR guard: a foreign payment id answers 404.
    throw new AppError("NOT_FOUND", "Pembayaran tidak ditemukan.");
  }

  const outcome = await db.transaction(
    async (tx) => {
      await tx.execute(sql`SELECT id FROM "invoice" WHERE id = ${existing.invoiceId} FOR UPDATE`);
      const invoiceRows = await tx
        .select()
        .from(invoices)
        .where(eq(invoices.id, existing.invoiceId))
        .limit(1);
      const invoice = invoiceRows[0];
      if (!invoice || invoice.organizationId !== ctx.scope.organizationId) {
        throw new AppError("NOT_FOUND", "Invoice tidak ditemukan.");
      }

      const deletedRows = await tx
        .delete(payments)
        .where(eq(payments.id, paymentId))
        .returning();
      const deleted = deletedRows[0];
      if (!deleted) throw new AppError("NOT_FOUND", "Pembayaran tidak ditemukan.");

      const sumRows = await tx
        .select({ total: sum(payments.amount) })
        .from(payments)
        .where(eq(payments.invoiceId, invoice.id));
      const amountPaid = new Decimal(sumRows[0]?.total ?? "0");
      const grandTotal = new Decimal(invoice.grandTotal);
      const status = isPayable(invoice.status)
        ? recomputePaymentStatus({
            status: invoice.status,
            grandTotal: money(grandTotal),
            amountPaid: money(amountPaid),
          })
        : invoice.status;

      await tx
        .update(invoices)
        .set({
          amountPaid: money(amountPaid),
          remainingAfter: remainingAfterPayment(money(grandTotal), money(amountPaid)),
          status,
        })
        .where(eq(invoices.id, invoice.id));

      await log(
        {
          actorUserId: ctx.scope.userId,
          organizationId: ctx.scope.organizationId,
          action: "PAYMENT_RECORDED",
          entityType: "payment",
          entityId: paymentId,
          metadata: {
            reversed: true,
            invoiceId: invoice.id,
            invoiceNumber: invoice.number ?? invoice.numberPreview ?? null,
            amount: money(deleted.amount),
            method: deleted.method,
            status,
            hadProof: deleted.proofPath !== null,
          },
          request: ctx.request ?? null,
        },
        tx,
      );

      return {
        paymentId,
        invoiceId: invoice.id,
        status,
        amountPaid: money(amountPaid),
        remainingAfter: remainingAfterPayment(money(grandTotal), money(amountPaid)),
      };
    },
  );

  // Proof file cleanup AFTER commit — best-effort, the row is already gone.
  if (existing.proofPath) {
    await getStorageService()
      .delete(existing.proofPath)
      .catch((err: unknown) =>
        logger.warn(
          { module: "payments", err: err instanceof Error ? err.message : String(err) },
          "bukti pembayaran gagal dihapus dari storage",
        ),
      );
  }

  return outcome;
}

// ─── Reads ───────────────────────────────────────────────────────────────

/** "YYYY-MM-DD" → Date range bounds; a present-but-malformed value is an
 * error (server validation — never silently ignored). */
function dateRange(
  from: string | undefined,
  to: string | undefined,
): { gte?: Date; lte?: Date } | null {
  const rawFrom = (from ?? "").trim();
  const rawTo = (to ?? "").trim();
  if (!rawFrom && !rawTo) return null;

  const parse = (value: string, label: string): Date => {
    const parsed = parseCalendarDate(value);
    if (!parsed || Number.isNaN(parsed.getTime()) || toCalendarInput(parsed.toISOString()) !== value) {
      throw new AppError("VALIDATION_ERROR", `Format tanggal ${label} tidak valid.`);
    }
    return parsed;
  };

  const range: { gte?: Date; lte?: Date } = {};
  if (rawFrom) range.gte = parse(rawFrom, "mulai");
  if (rawTo) {
    const end = parse(rawTo, "akhir");
    // paymentDate is stored as UTC midnight — include the whole "to" day.
    range.lte = new Date(end.getTime() + 24 * 60 * 60 * 1000 - 1);
  }
  if (range.gte && range.lte && range.gte.getTime() > range.lte.getTime()) {
    throw new AppError("VALIDATION_ERROR", "Rentang tanggal tidak valid.");
  }
  return range;
}

/**
 * Server-side list of an organization's payments: pagination + invoice /
 * customer / date filters, always org-scoped, pageSize capped (spec: halaman
 * `/payments`).
 */
export async function listPayments(
  ctx: PaymentServiceContext,
  query: PaymentListQuery = {},
): Promise<PaymentListResult> {
  assertCan("payment.view", ctx.scope);
  requireOrgScope(ctx.scope);

  const pageSize = Math.min(Math.max(query.pageSize ?? 20, 1), MAX_LIST_PAGE_SIZE);
  const invoice = (query.invoice ?? "").trim().slice(0, 100);
  const customer = (query.customer ?? "").trim().slice(0, 100);
  const range = dateRange(query.from, query.to);

  const filters: SQL[] = [eq(payments.organizationId, ctx.scope.organizationId)];
  if (invoice) {
    // Payments only exist on issued invoices — always a final number. The
    // draft numberPreview is deliberately NOT searched: previews collide
    // between neighbours (invoice N's preview is invoice N+1's number).
    filters.push(ilike(invoices.number, `%${invoice}%`));
  }
  if (customer) {
    filters.push(ilike(customers.companyName, `%${customer}%`));
  }
  if (range) {
    if (range.gte) filters.push(gte(payments.paymentDate, range.gte));
    if (range.lte) filters.push(lte(payments.paymentDate, range.lte));
  }
  const where = and(...filters);

  const totalRows = await db.select({ value: count() }).from(payments).where(where);
  const total = Number(totalRows[0]?.value ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(query.page ?? 1, 1), totalPages);
  const rows = await loadRows(where, { offset: (page - 1) * pageSize, limit: pageSize });

  return {
    rows: rows.map(toPaymentRow),
    total,
    page,
    pageSize,
    totalPages,
  };
}

/**
 * "Riwayat pembayaran" for one invoice (detail page). Org-scoped: a foreign
 * invoice id answers 404. VIEWER reads (payment.view), STAFF+ gets the
 * Record Payment flag, OWNER/ADMIN the reversal flag.
 */
export async function getInvoicePaymentPanel(
  invoiceId: string,
  ctx: PaymentServiceContext,
): Promise<InvoicePaymentPanel> {
  assertCan("payment.view", ctx.scope);
  requireOrgScope(ctx.scope);

  const invoiceRows = await db
    .select({
      id: invoices.id,
      organizationId: invoices.organizationId,
      number: invoices.number,
      numberPreview: invoices.numberPreview,
      status: invoices.status,
      grandTotal: invoices.grandTotal,
      amountPaid: invoices.amountPaid,
      remainingAfter: invoices.remainingAfter,
      customerCompany: customers.companyName,
    })
    .from(invoices)
    .leftJoin(customers, eq(customers.id, invoices.customerId))
    .where(eq(invoices.id, invoiceId))
    .limit(1);
  const invoice = invoiceRows[0];
  if (!invoice || invoice.organizationId !== ctx.scope.organizationId) {
    throw new AppError("NOT_FOUND", "Invoice tidak ditemukan.");
  }

  const [rows, totalRows] = await Promise.all([
    loadRows(eq(payments.invoiceId, invoiceId), { offset: 0, limit: MAX_LIST_PAGE_SIZE }),
    db
      .select({ value: count() })
      .from(payments)
      .where(eq(payments.invoiceId, invoiceId)),
  ]);
  const total = Number(totalRows[0]?.value ?? 0);
  return {
    invoiceId: invoice.id,
    invoiceLabel: invoiceLabel(invoice),
    customerName: invoice.customerCompany ?? "—",
    status: invoice.status,
    grandTotal: money(invoice.grandTotal),
    amountPaid: money(invoice.amountPaid),
    remainingAfter: money(invoice.remainingAfter),
    rows: rows.map(toPaymentRow),
    /** True when the riwayat hit the display cap (the sum still counts all rows). */
    truncated: total > rows.length,
    permissions: {
      // Buttons only exist where the SERVICE would accept the action
      // (non-negotiables: no fake buttons).
      record: can("payment.record", ctx.scope) && isPayable(invoice.status),
      reverse: can("payment.delete", ctx.scope),
      override: can("payment.override", ctx.scope),
    },
  };
}

/**
 * Payable invoices for the record-payment picker on `/payments` — capped,
 * org-scoped, permission-gated by payment.record (nobody else needs it).
 */
export async function listPayableInvoices(
  ctx: PaymentServiceContext,
): Promise<PayableInvoiceOption[]> {
  assertCan("payment.record", ctx.scope);
  requireOrgScope(ctx.scope);

  const rows = await db
    .select({
      id: invoices.id,
      number: invoices.number,
      numberPreview: invoices.numberPreview,
      status: invoices.status,
      grandTotal: invoices.grandTotal,
      amountPaid: invoices.amountPaid,
      createdAt: invoices.createdAt,
      customerCompany: customers.companyName,
    })
    .from(invoices)
    .leftJoin(customers, eq(customers.id, invoices.customerId))
    .where(
      and(
        eq(invoices.organizationId, ctx.scope.organizationId),
        inArray(invoices.status, [...PAYABLE_STATUSES]),
      ),
    )
    .orderBy(desc(invoices.invoiceDate), desc(invoices.createdAt))
    .limit(PAYABLE_INVOICE_LIMIT);

  return rows.map((row) => {
    const grandTotal = money(row.grandTotal);
    const amountPaid = money(row.amountPaid);
    return {
      id: row.id,
      label: invoiceLabel(row),
      customerName: row.customerCompany ?? "—",
      status: row.status,
      grandTotal,
      amountPaid,
      remaining: remainingAfterPayment(grandTotal, amountPaid),
    };
  });
}
