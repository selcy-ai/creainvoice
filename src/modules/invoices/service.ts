// src/modules/invoices/service.ts
// Invoice DRAFT domain (feature 04): createDraft / updateDraft (autosave) /
// getDraft / listDrafts / deleteDraft + prefill composition. The editor UI and
// the future issue flow (feature 05) share one truth:
//
//   • SERVER RECALCULATION (architecture invariant 2): every save recomputes
//     lineAmounts, itemsSubtotal, workValue, billingBase, tax and grandTotal
//     with `calculateInvoice` — the client's numbers are display-only and the
//     persisted Decimal columns always equal the calculation engine output.
//   • ORG SCOPING + IDOR: every read/write is scoped to the active
//     organization; a foreign id answers 404, never "exists elsewhere".
//   • DRAFT only: this module never allocates the final number (that is the
//     issue transaction, feature 05). Drafts carry a non-binding
//     `numberPreview` rendered from the profile pattern.
//   • previouslyBilled (SETTLEMENT) comes from the DATABASE: the sum of
//     ISSUED-and-later, non-CANCELLED/non-REVISED invoices linked to the same
//     project (invariant 6: drafts never count as billed). Feature 04 has no
//     issue flow yet, so this is honestly 0 — but the wiring is real.

import { log } from "@/modules/audit/service";
import Decimal from "decimal.js";
import { AppError } from "@/lib/errors";
import type { WorkspaceScope } from "@/modules/workspace/service";
import { parseCalendarDate, toCalendarInput, todayInJakarta } from "@/lib/date";
import { assertCan, requireOrgScope } from "@/modules/workspace/permissions";
import { buildNumberPreview, sequenceKeyFor } from "@/modules/invoices/numbering";
import {
  BILLED_STATUSES,
  sumBilledForProject,
} from "@/modules/invoices/billed";
import { calculateInvoice, type InvoiceCalcResult } from "@/modules/invoices/calculation";
import {
  MAX_INVOICE_ITEMS,
  isItemWorthSaving,
  type InvoiceDraftFormOutput,
  type InvoiceItemValues,
} from "@/modules/invoices/schema";
import { getCustomerForScope } from "@/modules/customers/service";
import { getProjectForScope } from "@/modules/projects/service";
import { listBankAccounts, type BankAccountView } from "@/modules/bank-accounts/service";
import { listSigners, type SignerView } from "@/modules/signers/service";
import {
  parseProfileSettings,
  type InvoiceProfileSettings,
} from "@/modules/profiles/settings";
import { logger } from "@/server/logger";
import { db, type Database } from "@/server/db";
import {
  bankAccounts,
  customerContacts,
  customers,
  invoiceItems,
  invoiceProfiles,
  invoiceSequences,
  invoices,
  projectReferences,
  signers,
} from "@/db/schema";
import { and, asc, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { InvoiceType, ReferenceType, SequenceResetPolicy, TaxMode } from "@/db/enums";

export { MAX_INVOICE_ITEMS } from "@/modules/invoices/schema";

// ─── Service context ──────────────────────────────────────────────────────

export interface InvoiceServiceContext {
  scope: WorkspaceScope;
  request?: Request | null;
}

// ─── Views (serializable — server action/page → client components) ────────

export interface DraftItemView {
  id: string;
  position: number;
  description: string;
  details: string | null;
  quantity: string;
  unit: string;
  unitPrice: string;
  discountAmount: string;
  lineAmount: string;
}

export interface DraftPartyView {
  id: string;
  companyName: string;
  address: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  country: string | null;
  phone: string | null;
  email: string | null;
  taxId: string | null;
}

export interface DraftProfileView {
  id: string;
  name: string;
  legalName: string | null;
  code: string;
  logoPath: string | null;
  primaryColor: string;
  address: string | null;
  phone: string | null;
  whatsapp: string | null;
  fax: string | null;
  email: string | null;
  website: string | null;
  taxId: string | null;
  numberPattern: string;
  numberPreview: string | null;
  /** Document settings (hide-zero rows, stamp label) — feature 06. */
  settings: InvoiceProfileSettings;
}

export interface InvoiceDraftView {
  id: string;
  status: "DRAFT";
  invoiceType: InvoiceType;
  number: string | null;
  numberPreview: string | null;
  profile: DraftProfileView | null;
  customer: DraftPartyView | null;
  customerContactId: string | null;
  contactName: string | null;
  projectReferenceId: string | null;
  projectTitle: string | null;

  invoiceDate: string;
  dueDate: string | null;
  referenceType: string | null;
  referenceNumber: string | null;
  referenceDate: string | null;
  paymentTerms: string | null;
  currency: string;

  billingMode: "PERCENT" | "MANUAL";
  billingPercent: string | null;
  billingAmount: string | null;
  termName: string | null;
  termNumber: number | null;
  customLabel: string | null;
  customReason: string | null;
  workValueOverride: boolean;
  workValueOverrideAmount: string | null;
  workValueReason: string | null;
  previouslyBilled: string;

  items: DraftItemView[];

  discountAmount: string;
  additionalAmount: string;
  taxMode: TaxMode;
  taxPercent: string | null;
  /** MANUAL tax mode: the stored nominal (taxAmount column). */
  taxAmountInput: string | null;
  roundingAmount: string;

  bankAccountId: string | null;
  stampMode: string;
  signerId: string | null;
  notes: string | null;
  footerText: string | null;

  /** Authoritative server calculation — the preview renders these numbers. */
  calc: InvoiceCalcResult;

  createdAt: string;
  updatedAt: string;
}

export interface InvoiceListItem {
  id: string;
  numberPreview: string | null;
  number: string | null;
  invoiceType: InvoiceType;
  customerName: string;
  grandTotal: string;
  currency: string;
  invoiceDate: string;
  updatedAt: string;
}

type InvoiceWithRelations = Invoice & {
  profile: typeof invoiceProfiles.$inferSelect | null;
  customer: typeof customers.$inferSelect | null;
  customerContact: { id: string; name: string; title: string | null; division: string | null } | null;
  projectReference: { id: string; title: string; referenceNumber: string } | null;
  items: InvoiceItem[];
};
export type { InvoiceWithRelations };

type Invoice = typeof invoices.$inferSelect;
type InvoiceItem = typeof invoiceItems.$inferSelect;

const draftInclude = {
  profile: true,
  customer: true,
  customerContact: { select: { id: true, name: true } },
  projectReference: { select: { id: true, title: true } },
  items: { orderBy: { position: "asc" as const } },
};

/** Re-run the calculation engine over persisted rows (Decimal → string).
 * `previouslyBilled` overrides the stored column — the issue flow passes the
 * freshly summed value (invariant 6) before it is persisted. */
export function calcFromRows(
  invoice: InvoiceWithRelations,
  previouslyBilled: string = invoice.previouslyBilled.toString(),
): InvoiceCalcResult {
  return calculateInvoice({
    invoiceType: invoice.invoiceType,
    items: invoice.items.map((item) => ({
      quantity: item.quantity.toString(),
      unitPrice: item.unitPrice.toString(),
      discountAmount: item.discountAmount.toString(),
    })),
    workValueOverride: invoice.workValueOverride,
    // When the override is on, the stored workValue IS the manual amount.
    workValueOverrideAmount: invoice.workValue.toString(),
    billingMode: invoice.billingMode,
    billingPercent: invoice.billingPercent?.toString(),
    billingAmount: invoice.billingAmount?.toString(),
    previouslyBilled,
    discountAmount: invoice.discountAmount.toString(),
    additionalAmount: invoice.additionalAmount.toString(),
    taxMode: invoice.taxMode,
    taxPercent: invoice.taxPercent?.toString(),
    taxAmountInput: invoice.taxMode === "MANUAL" ? invoice.taxAmount.toString() : null,
    roundingAmount: invoice.roundingAmount.toString(),
  });
}

export function toDraftView(invoice: InvoiceWithRelations): InvoiceDraftView {
  const workValueFromOverride = invoice.workValueOverride ? invoice.workValue.toString() : null;
  return {
    id: invoice.id,
    status: "DRAFT",
    invoiceType: invoice.invoiceType,
    number: invoice.number,
    numberPreview: invoice.numberPreview,
    profile: invoice.profile
      ? ({
          id: invoice.profile.id,
          name: invoice.profile.name,
          legalName: invoice.profile.legalName,
          code: invoice.profile.code,
          logoPath: invoice.profile.logoPath,
          primaryColor: invoice.profile.primaryColor,
          address: invoice.profile.address,
          phone: invoice.profile.phone,
          whatsapp: invoice.profile.whatsapp,
          fax: invoice.profile.fax,
          email: invoice.profile.email,
          website: invoice.profile.website,
          taxId: invoice.profile.taxId,
          numberPattern: invoice.profile.numberPattern,
          numberPreview: invoice.numberPreview,
          settings: parseProfileSettings(invoice.profile.settings),
        } as DraftProfileView)
      : null,
    customer: invoice.customer
      ? {
          id: invoice.customer.id,
          companyName: invoice.customer.companyName,
          address: invoice.customer.address,
          city: invoice.customer.city,
          province: invoice.customer.province,
          postalCode: invoice.customer.postalCode,
          country: invoice.customer.country,
          phone: invoice.customer.phone,
          email: invoice.customer.email,
          taxId: invoice.customer.taxId,
        }
      : null,
    customerContactId: invoice.customerContactId,
    contactName: invoice.customerContact?.name ?? null,
    projectReferenceId: invoice.projectReferenceId,
    projectTitle: invoice.projectReference?.title ?? null,
    invoiceDate: toCalendarInput(invoice.invoiceDate.toISOString()),
    dueDate: invoice.dueDate ? toCalendarInput(invoice.dueDate.toISOString()) : null,
    referenceType: invoice.referenceType,
    referenceNumber: invoice.referenceNumber,
    referenceDate: invoice.referenceDate ? toCalendarInput(invoice.referenceDate.toISOString()) : null,
    paymentTerms: invoice.paymentTerms,
    currency: invoice.currency,
    billingMode: invoice.billingMode,
    billingPercent: invoice.billingPercent?.toString() ?? null,
    billingAmount: invoice.billingAmount?.toString() ?? null,
    termName: invoice.termName,
    termNumber: invoice.termNumber,
    customLabel: invoice.customLabel,
    customReason: invoice.customReason,
    workValueOverride: invoice.workValueOverride,
    workValueOverrideAmount: workValueFromOverride,
    workValueReason: invoice.workValueReason,
    previouslyBilled: invoice.previouslyBilled.toString(),
    items: invoice.items.map((item) => ({
      id: item.id,
      position: item.position,
      description: item.description,
      details: item.details,
      quantity: item.quantity.toString(),
      unit: item.unit,
      unitPrice: item.unitPrice.toString(),
      discountAmount: item.discountAmount.toString(),
      lineAmount: item.lineAmount.toString(),
    })),
    discountAmount: invoice.discountAmount.toString(),
    additionalAmount: invoice.additionalAmount.toString(),
    taxMode: invoice.taxMode,
    taxPercent: invoice.taxPercent?.toString() ?? null,
    taxAmountInput: invoice.taxMode === "MANUAL" ? invoice.taxAmount.toString() : null,
    roundingAmount: invoice.roundingAmount.toString(),
    bankAccountId: invoice.bankAccountId,
    stampMode: invoice.stampMode,
    signerId: invoice.signerId,
    notes: invoice.notes,
    footerText: invoice.footerText,
    calc: calcFromRows(invoice),
    createdAt: invoice.createdAt.toISOString(),
    updatedAt: invoice.updatedAt.toISOString(),
  };
}

// ─── Guards ────────────────────────────────────────────────────────────────

async function getDraftRow(invoiceId: string, ctx: InvoiceServiceContext): Promise<Invoice> {
  const rows = await db.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
  const invoice = rows[0];
  if (!invoice || invoice.organizationId !== ctx.scope.organizationId) {
    // Same answer as a missing row — no cross-tenant existence leak (IDOR).
    throw new AppError("NOT_FOUND", "Invoice tidak ditemukan.");
  }
  return invoice;
}

function assertDraftEditable(invoice: Invoice): void {
  if (invoice.status !== "DRAFT") {
    // Invariant 5: issued invoices are locked (edit path = feature 05 revision).
    throw new AppError("LOCKED", "Invoice yang sudah terbit tidak dapat diedit.");
  }
}

/**
 * The four id references on a draft must exist AND belong to the caller's
 * organization (forged ids answer 404). customerContactId is additionally
 * checked against the chosen customer.
 */
async function resolveRelations(
  values: InvoiceDraftFormOutput,
  ctx: InvoiceServiceContext,
): Promise<void> {
  // Profile: must belong to the org (feature 02's service exposes getProfileForScope
  // through db reads; inline scoped read keeps the cross-module surface small).
  const profileRows = await db
    .select({ id: invoiceProfiles.id, organizationId: invoiceProfiles.organizationId })
    .from(invoiceProfiles)
    .where(eq(invoiceProfiles.id, values.profileId))
    .limit(1);
  const profile = profileRows[0];
  if (!profile || profile.organizationId !== ctx.scope.organizationId) {
    throw new AppError("NOT_FOUND", "Profil invoice tidak ditemukan.");
  }

  await getCustomerForScope(values.customerId, ctx);

  if (values.customerContactId) {
    const contactRows = await db
      .select({ customerId: customerContacts.customerId })
      .from(customerContacts)
      .where(eq(customerContacts.id, values.customerContactId))
      .limit(1);
    const contact = contactRows[0];
    if (!contact || contact.customerId !== values.customerId) {
      throw new AppError("NOT_FOUND", "PIC tidak ditemukan untuk customer ini.");
    }
  }

  if (values.projectReferenceId) {
    await getProjectForScope(values.projectReferenceId, ctx);
  }

  if (values.bankAccountId) {
    const bankRows = await db
      .select({ organizationId: bankAccounts.organizationId })
      .from(bankAccounts)
      .where(eq(bankAccounts.id, values.bankAccountId))
      .limit(1);
    const bank = bankRows[0];
    if (!bank || bank.organizationId !== ctx.scope.organizationId) {
      throw new AppError("NOT_FOUND", "Rekening tidak ditemukan.");
    }
  }

  if (values.signerId) {
    const signerRows = await db
      .select({ organizationId: signers.organizationId })
      .from(signers)
      .where(eq(signers.id, values.signerId))
      .limit(1);
    const signer = signerRows[0];
    if (!signer || signer.organizationId !== ctx.scope.organizationId) {
      throw new AppError("NOT_FOUND", "Penanda tangan tidak ditemukan.");
    }
  }
}

/**
 * previouslyBilled from the DATABASE (invariant 6): only ISSUED-and-later
 * invoices of the SAME project count; CANCELLED/REVISED never do. No project
 * link → 0 (there is nothing verifiable to bill against). The rule itself
 * lives in modules/invoices/billed.ts (shared with issue/lifecycle/projects).
 */
async function computePreviouslyBilled(
  ctx: InvoiceServiceContext,
  projectReferenceId: string | null,
  excludeInvoiceId?: string,
): Promise<string> {
  return sumBilledForProject(db, {
    organizationId: ctx.scope.organizationId,
    projectReferenceId,
    excludeInvoiceId,
  });
}

// ─── Save pipeline (shared by create + update) ────────────────────────────

type DraftScalarData = Partial<
  Omit<
    typeof invoices.$inferInsert,
    | "id"
    | "organizationId"
    | "createdById"
    | "status"
    | "currency"
    | "number"
    | "numberPreview"
    | "amountPaid"
  >
> &
  // normalizeValues always produces these — keep them required so the object
  // spreads into the insert without an `undefined` widening.
  Pick<
    typeof invoices.$inferInsert,
    "invoiceType" | "invoiceDate" | "workValue" | "itemsSubtotal" | "billingBase" | "grandTotal"
  >;

interface NormalizedDraft {
  /** Draft-owned scalar fields only, with plain value types (no relation
   * objects, no Prisma field-operation unions). The same object spreads
   * cleanly into both InvoiceUncheckedCreateInput (create) and
   * InvoiceUncheckedUpdateInput (autosave update). */
  data: DraftScalarData;
  items: Array<{
    description: string;
    details: string | null;
    quantity: string;
    unit: string;
    unitPrice: string;
    discountAmount: string;
    lineAmount: string;
    position: number;
  }>;
  calc: InvoiceCalcResult;
}

function normalizeValues(
  values: InvoiceDraftFormOutput,
  previouslyBilled: string,
): NormalizedDraft {
  const invoiceDate = parseCalendarDate(values.invoiceDate || todayInJakarta())!;
  const dueDate = parseCalendarDate(values.dueDate || null);
  const referenceDate = parseCalendarDate(values.referenceDate || null);

  const savedItems = values.items.filter(isItemWorthSaving);
  if (savedItems.length > MAX_INVOICE_ITEMS) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Maksimal ${MAX_INVOICE_ITEMS} item pekerjaan.`,
    );
  }

  // Server recalculation — item rows keep ORIGINAL qty/price even for DP
  // (spec: DP shows 5 × Rp900.000, only billingBase changes).
  const calc = calculateInvoice({
    invoiceType: values.invoiceType,
    items: savedItems.map((item) => ({
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      discountAmount: item.discountAmount,
    })),
    workValueOverride: values.workValueOverride,
    workValueOverrideAmount: values.workValueOverrideAmount,
    billingMode: values.billingMode,
    billingPercent: values.billingPercent,
    billingAmount: values.billingAmount,
    previouslyBilled,
    discountAmount: values.discountAmount,
    additionalAmount: values.additionalAmount,
    taxMode: values.taxMode,
    taxPercent: values.taxPercent,
    taxAmountInput: values.taxAmountInput,
    roundingAmount: values.roundingAmount,
  });

  const workValue = values.workValueOverride
    ? calc.workValue
    : calc.itemsSubtotal;

  const data: DraftScalarData = {
    invoiceType: values.invoiceType,
    invoiceDate,
    dueDate,
    referenceType: (values.referenceType || null) as ReferenceType | null,
    referenceNumber: values.referenceNumber?.trim() || null,
    referenceDate,
    paymentTerms: values.paymentTerms?.trim() || null,
    workValue,
    workValueOverride: values.workValueOverride,
    workValueReason: values.workValueReason?.trim() || null,
    itemsSubtotal: calc.itemsSubtotal,
    previouslyBilled,
    billingMode: values.billingMode,
    billingPercent:
      values.billingMode === "PERCENT" &&
      (values.invoiceType === "DOWN_PAYMENT" || values.invoiceType === "TERM")
        ? values.billingPercent || null
        : null,
    billingAmount:
      values.billingMode === "MANUAL" || values.invoiceType === "CUSTOM"
        ? values.billingAmount || null
        : null,
    termName: values.invoiceType === "TERM" ? values.termName?.trim() || null : null,
    termNumber:
      values.invoiceType === "TERM" && values.termNumber ? Number(values.termNumber) : null,
    customLabel: values.invoiceType === "CUSTOM" ? values.customLabel?.trim() || null : null,
    customReason: values.invoiceType === "CUSTOM" ? values.customReason?.trim() || null : null,
    billingBase: calc.billingBase,
    discountAmount: calc.discountAmount,
    additionalAmount: calc.additionalAmount,
    taxMode: values.taxMode,
    taxPercent:
      values.taxMode === "EXCLUSIVE" || values.taxMode === "INCLUSIVE"
        ? values.taxPercent || null
        : null,
    taxAmount: calc.taxAmount,
    roundingAmount: calc.roundingAmount,
    grandTotal: calc.grandTotal,
    notes: values.notes?.trim() || null,
    footerText: values.footerText?.trim() || null,
    stampMode: values.stampMode,
    // profile / customer / project / bank / signer relations: connect below
  };

  const items = savedItems.map((item: InvoiceItemValues, index: number) => ({
    description: item.description.trim(),
    details: item.details?.trim() || null,
    quantity: item.quantity,
    unit: item.unit.trim(),
    unitPrice: item.unitPrice,
    discountAmount: item.discountAmount?.trim() || "0",
    lineAmount: calc.lineAmounts[index] ?? "0.00",
    position: index + 1,
  }));

  return { data, items, calc };
}

/**
 * Relation fields as plain scalar FKs (Unchecked inputs). The same object is
 * valid in InvoiceUncheckedCreateInput and InvoiceUncheckedUpdateInput — no
 * relation connect objects, no field-operation unions (typecheck contract).
 */
function relationScalars(values: InvoiceDraftFormOutput): {
  profileId: string;
  customerId: string;
  customerContactId: string | null;
  projectReferenceId: string | null;
  bankAccountId: string | null;
  signerId: string | null;
} {
  return {
    profileId: values.profileId,
    customerId: values.customerId,
    customerContactId: values.customerContactId?.trim() || null,
    projectReferenceId: values.projectReferenceId?.trim() || null,
    bankAccountId: values.bankAccountId?.trim() || null,
    signerId: values.signerId?.trim() || null,
  };
}

/**
 * Manual value decisions are gated by the draft.create/draft.update permission
 * (asserted by the caller) + a mandatory reason — the spec deliberately does
 * NOT introduce a separate "invoice.value.override" permission (toggle +
 * reason only; open question in progress-tracker).
 */
function assertOverridePermissions(values: InvoiceDraftFormOutput): void {
  const needsReason =
    (values.workValueOverride && !values.workValueReason?.trim()) ||
    (values.invoiceType === "CUSTOM" && !values.customReason?.trim());
  if (needsReason) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Nilai manual wajib disertai alasan (toggle nilai pekerjaan / custom).",
    );
  }
}

async function loadDraftFull(invoiceId: string, ctx: InvoiceServiceContext): Promise<InvoiceDraftView> {
  // IDOR guard runs inside getDraftRow before the joined read is used.
  await getDraftRow(invoiceId, ctx);
  const joined = await db
    .select({
      invoice: invoices,
      profile: invoiceProfiles,
      customer: customers,
      customerContact: customerContacts,
      projectReference: projectReferences,
      items: invoiceItems,
    })
    .from(invoices)
    .leftJoin(invoiceProfiles, eq(invoiceProfiles.id, invoices.profileId))
    .leftJoin(customers, eq(customers.id, invoices.customerId))
    .leftJoin(customerContacts, eq(customerContacts.id, invoices.customerContactId))
    .leftJoin(projectReferences, eq(projectReferences.id, invoices.projectReferenceId))
    .leftJoin(
      invoiceItems,
      and(eq(invoiceItems.invoiceId, invoices.id)),
    )
    .where(eq(invoices.id, invoiceId))
    .orderBy(asc(invoiceItems.position));
  const first = joined[0];
  if (!first) throw new AppError("NOT_FOUND", "Invoice tidak ditemukan.");
  const items = joined
    .filter((row) => row.items !== null)
    .map((row) => row.items as NonNullable<typeof row.items>);
  const invoice = {
    ...first.invoice,
    profile: first.profile,
    customer: first.customer,
    customerContact: first.customerContact
      ? { id: first.customerContact.id, name: first.customerContact.name }
      : null,
    projectReference: first.projectReference
      ? { id: first.projectReference.id, title: first.projectReference.title }
      : null,
    items,
  } as unknown as InvoiceWithRelations;
  return toDraftView(invoice);
}

// ─── Public service API ────────────────────────────────────────────────────

export interface EditorInitialValues {
  invoiceDate: string;
  profileId: string | null;
  referenceType: string;
}

/** Sensible first-open defaults for /invoices/new (no DB writes). */
export function editorDefaults(): EditorInitialValues {
  return { invoiceDate: todayInJakarta(), profileId: null, referenceType: "PURCHASE_ORDER" };
}

export async function createDraft(
  values: InvoiceDraftFormOutput,
  ctx: InvoiceServiceContext,
): Promise<InvoiceDraftView> {
  assertCan("invoice.draft.create", ctx.scope);
  requireOrgScope(ctx.scope);
  assertOverridePermissions(values);
  await resolveRelations(values, ctx);

  const previouslyBilled = await computePreviouslyBilled(ctx, values.projectReferenceId || null);
  const normalized = normalizeValues(values, previouslyBilled);

  let createdId: string | null = null;
  await db.transaction(async (tx) => {
    const created = await tx
      .insert(invoices)
      .values({
        organizationId: ctx.scope.organizationId,
        createdById: ctx.scope.userId,
        status: "DRAFT",
        currency: "IDR",
        ...normalized.data,
        ...relationScalars(values),
      })
      .returning({ id: invoices.id });
    const rowId = created[0]?.id ?? null;
    if (!rowId) {
      throw new AppError("INTERNAL_ERROR", "Draft invoice gagal dibuat.");
    }
    if (normalized.items.length > 0) {
      await tx.insert(invoiceItems).values(
        normalized.items.map((item) => ({ invoiceId: rowId, ...item })),
      );
    }
    createdId = rowId;

    const profileRows = await tx
      .select({
        id: invoiceProfiles.id,
        code: invoiceProfiles.code,
        numberPattern: invoiceProfiles.numberPattern,
        sequenceResetPolicy: invoiceProfiles.sequenceResetPolicy,
      })
      .from(invoiceProfiles)
      .where(eq(invoiceProfiles.id, values.profileId))
      .limit(1);
    const profile = profileRows[0];
    if (!profile) {
      throw new AppError("NOT_FOUND", "Profil invoice tidak ditemukan.");
    }
    const numberPreview = await buildNumberPreview(profile, normalized.data.invoiceDate as Date, tx);
    await tx.update(invoices).set({ numberPreview }).where(eq(invoices.id, createdId));
  });
  if (!createdId) {
    throw new AppError("INTERNAL_ERROR", "Draft invoice gagal dibuat.");
  }
  await log({
    actorUserId: ctx.scope.userId,
    organizationId: ctx.scope.organizationId,
    action: "INVOICE_DRAFT_CREATED",
    entityType: "invoice",
    entityId: createdId,
    metadata: { invoiceType: values.invoiceType, itemCount: normalized.items.length },
    request: ctx.request ?? null,
  });

  return loadDraftFull(createdId, ctx);
}

export async function updateDraft(
  invoiceId: string,
  values: InvoiceDraftFormOutput,
  ctx: InvoiceServiceContext,
): Promise<InvoiceDraftView> {
  assertCan("invoice.draft.update", ctx.scope);
  requireOrgScope(ctx.scope);
  const existing = await getDraftRow(invoiceId, ctx);
  assertDraftEditable(existing);
  assertOverridePermissions(values);
  await resolveRelations(values, ctx);

  const previouslyBilled = await computePreviouslyBilled(
    ctx,
    values.projectReferenceId || null,
    invoiceId,
  );
  const normalized = normalizeValues(values, previouslyBilled);

  await db.transaction(async (tx) => {
    await tx
      .update(invoices)
      .set({
        ...normalized.data,
        ...relationScalars(values),
      })
      .where(eq(invoices.id, invoiceId));
    // Items are small and fully replaced on every autosave (position order
    // is the item array order — drag reorder is just an array move).
    await tx.delete(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceId));
    if (normalized.items.length > 0) {
      await tx.insert(invoiceItems).values(
        normalized.items.map((item) => ({ invoiceId, ...item })),
      );
    }

    const profileRows = await tx
      .select({
        id: invoiceProfiles.id,
        code: invoiceProfiles.code,
        numberPattern: invoiceProfiles.numberPattern,
        sequenceResetPolicy: invoiceProfiles.sequenceResetPolicy,
      })
      .from(invoiceProfiles)
      .where(eq(invoiceProfiles.id, values.profileId))
      .limit(1);
    const profile = profileRows[0];
    if (!profile) {
      throw new AppError("NOT_FOUND", "Profil invoice tidak ditemukan.");
    }
    const numberPreview = await buildNumberPreview(profile, normalized.data.invoiceDate as Date, tx);
    await tx.update(invoices).set({ numberPreview }).where(eq(invoices.id, invoiceId));
  });

  // Audit the FIELDS that changed (names only — no customer PII, no amounts).
  const changed = changedFields(existing, values, normalized);
  if (changed.length > 0) {
    await log({
      actorUserId: ctx.scope.userId,
      organizationId: ctx.scope.organizationId,
      action: "INVOICE_UPDATED",
      entityType: "invoice",
      entityId: invoiceId,
      metadata: { change: "updated", fields: changed },
      request: ctx.request ?? null,
    });
  }

  return loadDraftFull(invoiceId, ctx);
}

function changedFields(
  before: Invoice,
  values: InvoiceDraftFormOutput,
  normalized: NormalizedDraft,
): string[] {
  const next: Record<string, unknown> = {
    invoiceType: values.invoiceType,
    profileId: values.profileId,
    customerId: values.customerId,
    customerContactId: values.customerContactId || null,
    projectReferenceId: values.projectReferenceId || null,
    bankAccountId: values.bankAccountId || null,
    signerId: values.signerId || null,
    referenceType: values.referenceType || null,
    referenceNumber: values.referenceNumber?.trim() || null,
    paymentTerms: values.paymentTerms?.trim() || null,
    notes: values.notes?.trim() || null,
    footerText: values.footerText?.trim() || null,
    taxMode: values.taxMode,
    stampMode: values.stampMode,
    dueDate: (normalized.data.dueDate as Date | null)?.getTime() ?? null,
    invoiceDate: (normalized.data.invoiceDate as Date).getTime(),
    referenceDate: (normalized.data.referenceDate as Date | null)?.getTime() ?? null,
    itemCount: normalized.items.length,
  };
  const changed: string[] = [];
  for (const [key, value] of Object.entries(next)) {
    const current = (before as unknown as Record<string, unknown>)[key];
    const currentComparable = current instanceof Date ? current.getTime() : current;
    if (String(currentComparable ?? "") !== String(value ?? "")) changed.push(key);
  }
  return changed;
}

export async function getDraft(invoiceId: string, ctx: InvoiceServiceContext): Promise<InvoiceDraftView> {
  assertCan("invoice.draft.read", ctx.scope);
  requireOrgScope(ctx.scope);
  // Feature 05: an ISSUED invoice is immutable (invariant 5). The editor's
  // load path answers LOCKED, which /invoices/[id]/edit turns into a redirect
  // to the detail page — an issued document can only be revised, never edited.
  const row = await getDraftRow(invoiceId, ctx);
  assertDraftEditable(row);
  return loadDraftFull(invoiceId, ctx);
}

export async function deleteDraft(invoiceId: string, ctx: InvoiceServiceContext): Promise<void> {
  assertCan("invoice.draft.delete", ctx.scope);
  requireOrgScope(ctx.scope);
  const invoice = await getDraftRow(invoiceId, ctx);
  assertDraftEditable(invoice);

  await db.delete(invoices).where(eq(invoices.id, invoice.id));
  await log({
    actorUserId: ctx.scope.userId,
    organizationId: ctx.scope.organizationId,
    action: "INVOICE_UPDATED",
    entityType: "invoice",
    entityId: invoice.id,
    // AuditAction has no INVOICE_DELETED yet (list finalized in feature 11) —
    // recorded as INVOICE_UPDATED change=deleted (same precedent as feature 03).
    metadata: { change: "deleted", invoiceType: invoice.invoiceType },
    request: ctx.request ?? null,
  });
}

/** Minimal draft list for navigation (feature 08 owns the full-featured list). */
export async function listDrafts(
  ctx: InvoiceServiceContext,
  query: { page?: number; pageSize?: number } = {},
): Promise<{ rows: InvoiceListItem[]; total: number; page: number; pageSize: number; totalPages: number }> {
  assertCan("invoice.draft.read", ctx.scope);
  requireOrgScope(ctx.scope);
  const pageSize = Math.min(Math.max(query.pageSize ?? 20, 1), 100);

  const where = and(
    eq(invoices.organizationId, ctx.scope.organizationId),
    eq(invoices.status, "DRAFT"),
  );
  const totalRows = await db.select({ value: count() }).from(invoices).where(where);
  const total = Number(totalRows[0]?.value ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(query.page ?? 1, 1), totalPages);
  const rows = await db
    .select({
      id: invoices.id,
      numberPreview: invoices.numberPreview,
      number: invoices.number,
      invoiceType: invoices.invoiceType,
      grandTotal: invoices.grandTotal,
      currency: invoices.currency,
      invoiceDate: invoices.invoiceDate,
      updatedAt: invoices.updatedAt,
      customerCompany: customers.companyName,
    })
    .from(invoices)
    .leftJoin(customers, eq(customers.id, invoices.customerId))
    .where(where)
    .orderBy(desc(invoices.updatedAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return {
    rows: rows.map((row) => ({
      id: row.id,
      numberPreview: row.numberPreview,
      number: row.number,
      invoiceType: row.invoiceType,
      customerName: row.customerCompany ?? "—",
      grandTotal: row.grandTotal,
      currency: row.currency,
      invoiceDate: toCalendarInput(row.invoiceDate.toISOString()),
      updatedAt: row.updatedAt.toISOString(),
    })),
    total,
    page,
    pageSize,
    totalPages,
  };
}

// ─── Editor data bundle (one round-trip for the editor page) ───────────────

export interface EditorProfileOption {
  id: string;
  name: string;
  code: string;
  numberPattern: string;
  legalName: string | null;
  logoPath: string | null;
  primaryColor: string;
  address: string | null;
  phone: string | null;
  whatsapp: string | null;
  fax: string | null;
  email: string | null;
  website: string | null;
  taxId: string | null;
  /** Feature 02 defaults — applied by the editor when a profile is chosen. */
  defaultBankAccountId: string | null;
  defaultSignerId: string | null;
  defaultTaxMode: TaxMode;
  defaultTaxPercent: string | null;
  defaultStampMode: string;
  defaultNotes: string | null;
  /** Document settings (hide-zero rows, stamp label) — feature 06 preview. */
  settings: InvoiceProfileSettings;
}

export interface EditorProjectOption {
  id: string;
  title: string;
  referenceType: string;
  referenceNumber: string;
  referenceDate: string | null;
  customerId: string;
  customerName: string;
  workValue: string;
  currency: string;
  /** Sum of ISSUED-and-later (non-CANCELLED/REVISED) invoices linked to the
   * project — the settlement view's "sudah ditagihkan" (invariant 6). */
  previouslyBilled: string;
}

export interface EditorOptions {
  profiles: EditorProfileOption[];
  banks: BankAccountView[];
  signers: SignerView[];
  projects: EditorProjectOption[];
  /** Customers of the org — the editor's customer dropdown. */
  customers: Array<{ id: string; companyName: string }>;
}

/** Current bucket value for a profile/date (non-allocating read; the draft
 * preview number is always currentValue + 1). Shared by getEditorOptions and
 * its action so client and server derive the same preview sequence. */
export async function nextSequenceHint(
  profile: { id: string; sequenceResetPolicy: SequenceResetPolicy },
  invoiceDate: Date,
): Promise<number> {
  const key = sequenceKeyFor(profile.sequenceResetPolicy, invoiceDate);
  const bucketRows = await db
    .select({ currentValue: invoiceSequences.currentValue })
    .from(invoiceSequences)
    .where(
      and(
        eq(invoiceSequences.invoiceProfileId, profile.id),
        eq(invoiceSequences.sequenceKey, key),
      ),
    )
    .limit(1);
  return (bucketRows[0]?.currentValue ?? 0) + 1;
}

export async function getEditorOptions(ctx: InvoiceServiceContext): Promise<EditorOptions> {
  requireOrgScope(ctx.scope);
  const profileRows = await db
    .select()
    .from(invoiceProfiles)
    .where(
      and(
        eq(invoiceProfiles.organizationId, ctx.scope.organizationId),
        eq(invoiceProfiles.isActive, true),
      ),
    )
    .orderBy(asc(invoiceProfiles.createdAt));
  const banks = await listBankAccounts(ctx.scope.organizationId);
  const signers = await listSigners(ctx.scope.organizationId);
  // Customer dropdown: active customers only (soft-deleted rows are hidden from
  // every read path — a draft can never point at a deleted customer).
  const customerRows = await db
    .select({ id: customers.id, companyName: customers.companyName })
    .from(customers)
    .where(
      and(
        eq(customers.organizationId, ctx.scope.organizationId),
        isNull(customers.deletedAt),
      ),
    )
    .orderBy(asc(customers.companyName))
    .limit(200);
  // Project dropdown + settlement context: every project of the org with the
  // sum of its ISSUED-and-later invoices (the settlement view's "sudah
  // ditagihkan", invariant 6).
  const projectRows = await db
    .select({
      project: projectReferences,
      customerCompany: customers.companyName,
      invoiceTotals: invoices.grandTotal,
    })
    .from(projectReferences)
    .leftJoin(customers, eq(customers.id, projectReferences.customerId))
    .leftJoin(
      invoices,
      and(
        eq(invoices.projectReferenceId, projectReferences.id),
        inArray(invoices.status, [...BILLED_STATUSES]),
      ),
    )
    .where(eq(projectReferences.organizationId, ctx.scope.organizationId))
    .orderBy(desc(projectReferences.updatedAt))
    .limit(200);
  const profiles = profileRows;
  const projectGroups = new Map<string, Decimal>();
  for (const row of projectRows) {
    const key = row.project.id;
    const current = projectGroups.get(key) ?? new Decimal(0);
    projectGroups.set(key, row.invoiceTotals === null ? current : current.plus(row.invoiceTotals));
  }
  // Default bank/signer ride along from the active profile (feature 02) —
  // the editor applies them when the user picks a profile.
  return {
    profiles: profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      code: profile.code,
      numberPattern: profile.numberPattern,
      legalName: profile.legalName,
      logoPath: profile.logoPath,
      primaryColor: profile.primaryColor,
      address: profile.address,
      phone: profile.phone,
      whatsapp: profile.whatsapp,
      fax: profile.fax,
      email: profile.email,
      website: profile.website,
      taxId: profile.taxId,
      settings: parseProfileSettings(profile.settings),
      defaultBankAccountId: profile.defaultBankAccountId,
      defaultSignerId: profile.defaultSignerId,
      defaultTaxMode: profile.defaultTaxMode,
      defaultTaxPercent:
        profile.defaultTaxPercent === null ? null : profile.defaultTaxPercent.toString(),
      defaultStampMode: profile.defaultStampMode,
      defaultNotes: profile.defaultNotes,
    })),
    banks,
    signers,
    customers: customerRows.map((customer) => ({
      id: customer.id,
      companyName: customer.companyName,
    })),
    projects: projectRows.map((row) => ({
      id: row.project.id,
      title: row.project.title,
      referenceType: row.project.referenceType,
      referenceNumber: row.project.referenceNumber,
      referenceDate: row.project.referenceDate
        ? toCalendarInput(row.project.referenceDate.toISOString())
        : null,
      customerId: row.project.customerId,
      customerName: row.customerCompany ?? "",
      workValue: row.project.workValue,
      currency: row.project.currency,
      previouslyBilled: (projectGroups.get(row.project.id) ?? new Decimal(0)).toFixed(2),
    })),
  };
}

/**
 * Non-binding draft preview number for the editor's live preview (feature 04):
 * the value `updateDraft` would persist for profile + invoice date — the active
 * bucket's currentValue + 1, never allocated, never written. Foreign or
 * missing profile answers 404 (IDOR guard), like every other scoped read.
 */
export async function getDraftNumberPreview(
  profileId: string,
  invoiceDate: string,
  ctx: InvoiceServiceContext,
): Promise<string | null> {
  assertCan("invoice.draft.read", ctx.scope);
  requireOrgScope(ctx.scope);
  const profileRows = await db
    .select({
      id: invoiceProfiles.id,
      organizationId: invoiceProfiles.organizationId,
      code: invoiceProfiles.code,
      numberPattern: invoiceProfiles.numberPattern,
      sequenceResetPolicy: invoiceProfiles.sequenceResetPolicy,
    })
    .from(invoiceProfiles)
    .where(eq(invoiceProfiles.id, profileId))
    .limit(1);
  const profile = profileRows[0];
  if (!profile || profile.organizationId !== ctx.scope.organizationId) {
    throw new AppError("NOT_FOUND", "Profil invoice tidak ditemukan.");
  }
  const date = parseCalendarDate(invoiceDate) ?? parseCalendarDate(todayInJakarta()) ?? new Date();
  return buildNumberPreview(profile, date);
}

/** PIC options for the chosen customer (editor dropdown). */
export async function listCustomerContacts(
  customerId: string,
  ctx: InvoiceServiceContext,
): Promise<Array<{ id: string; name: string; title: string | null; isPrimary: boolean }>> {
  requireOrgScope(ctx.scope);
  const customer = await getCustomerForScope(customerId, ctx);
  return customer.contacts.map((contact) => ({
    id: contact.id,
    name: contact.name,
    title: contact.title,
    isPrimary: contact.isPrimary,
  }));
}

/** Prefill composition for /invoices/new?project=<id> — feature 03's contract
 * (prefillFromProject: customer, reference, workValue, items copy) lifted into
 * editor form values. workValue rides in as an override (items arrive empty
 * because feature 03 stores no work items — honest, never fabricated). */
export async function prefillEditorFromProject(
  projectId: string,
  ctx: InvoiceServiceContext,
): Promise<{
  customerId: string;
  customerName: string;
  referenceType: string;
  referenceNumber: string;
  referenceDate: string;
  workValueOverrideAmount: string;
  workValueReason: string;
  items: InvoiceItemValues[];
}> {
  const project = await getProjectForScope(projectId, ctx);
  const customer = await getCustomerForScope(project.customerId, ctx);
  return {
    customerId: project.customerId,
    customerName: customer.companyName,
    referenceType: project.referenceType,
    referenceNumber: project.referenceNumber,
    referenceDate: toCalendarInput(project.referenceDate?.toISOString() ?? ""),
    workValueOverrideAmount: project.workValue.toString(),
    workValueReason: `Nilai pekerjaan dari project/PO ${project.referenceNumber}.`,
    // items copy — empty until feature 03's project carries work items.
    items: [],
  };
}

export function logPrefillFailure(error: unknown): void {
  logger.warn(
    { module: "invoices", err: error instanceof Error ? error.message : String(error) },
    "prefill project gagal — editor dibuka kosong",
  );
}
