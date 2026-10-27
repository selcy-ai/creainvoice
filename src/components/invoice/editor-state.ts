// src/components/invoice/editor-state.ts
// The editor's single form-value object — client-safe (no server imports).
// Everything is a plain string ("" = not filled) so one `values` object flows
// through: live preview (buildRendererPreviewData), client validation (the
// SAME zod schema the server re-runs), and the server action payload. Money
// never becomes a JS number anywhere in this file (architecture invariant 1).

import {
  isItemWorthSaving,
  type InvoiceDraftFormValues,
  type InvoiceTypeValue,
  type TaxModeValue,
  type StampModeValue,
  type BillingModeValue,
} from "@/modules/invoices/schema";
import { todayInJakarta } from "@/lib/date";
import type { InvoiceDraftView } from "@/modules/invoices/service";
import type { RendererFormValues } from "@/components/invoice/renderer-data";

/** One item row. `key` is stable UI identity (cuid from DB or a client uid) —
 * drag reorder and row-local inputs must never key on array index. */
export interface EditorItemRow {
  key: string;
  description: string;
  details: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  discountAmount: string;
}

export interface EditorFormValues {
  profileId: string;
  invoiceType: InvoiceTypeValue;
  customerId: string;
  customerContactId: string;
  projectReferenceId: string;
  projectTitle: string;

  billingMode: BillingModeValue;
  billingPercent: string;
  billingAmount: string;
  termName: string;
  termNumber: string;
  customLabel: string;
  customReason: string;

  workValueOverride: boolean;
  workValueOverrideAmount: string;
  workValueReason: string;

  invoiceDate: string;
  dueDate: string;
  referenceType: string;
  referenceNumber: string;
  referenceDate: string;
  paymentTerms: string;

  items: EditorItemRow[];

  discountAmount: string;
  additionalAmount: string;
  taxMode: TaxModeValue;
  taxPercent: string;
  taxAmountInput: string;
  roundingAmount: string;

  bankAccountId: string;
  stampMode: StampModeValue;
  signerId: string;
  notes: string;
  footerText: string;
}

export function newItemRow(): EditorItemRow {
  return {
    key: `item-${crypto.randomUUID()}`,
    description: "",
    details: "",
    quantity: "1",
    unit: "Unit",
    unitPrice: "",
    discountAmount: "",
  };
}

export function emptyEditorValues(): EditorFormValues {
  return {
    profileId: "",
    invoiceType: "FULL",
    customerId: "",
    customerContactId: "",
    projectReferenceId: "",
    projectTitle: "",
    billingMode: "PERCENT",
    billingPercent: "50",
    billingAmount: "",
    termName: "",
    termNumber: "1",
    customLabel: "",
    customReason: "",
    workValueOverride: false,
    workValueOverrideAmount: "",
    workValueReason: "",
    invoiceDate: todayInJakarta(),
    dueDate: "",
    referenceType: "PURCHASE_ORDER",
    referenceNumber: "",
    referenceDate: "",
    paymentTerms: "",
    items: [newItemRow()],
    discountAmount: "",
    additionalAmount: "",
    taxMode: "NONE",
    taxPercent: "11",
    taxAmountInput: "",
    roundingAmount: "",
    bankAccountId: "",
    stampMode: "NONE",
    signerId: "",
    notes: "",
    footerText: "",
  };
}

/** Persisted draft → editor values (edit page + ?draft= rehydration). */
export function editorValuesFromDraft(draft: InvoiceDraftView): EditorFormValues {
  return {
    profileId: draft.profile?.id ?? "",
    invoiceType: draft.invoiceType,
    customerId: draft.customer?.id ?? "",
    customerContactId: draft.customerContactId ?? "",
    projectReferenceId: draft.projectReferenceId ?? "",
    projectTitle: draft.projectTitle ?? "",
    billingMode: draft.billingMode,
    billingPercent: draft.billingPercent ?? "",
    billingAmount: draft.billingAmount ?? "",
    termName: draft.termName ?? "",
    termNumber: draft.termNumber ? String(draft.termNumber) : "",
    customLabel: draft.customLabel ?? "",
    customReason: draft.customReason ?? "",
    workValueOverride: draft.workValueOverride,
    workValueOverrideAmount: draft.workValueOverrideAmount ?? "",
    workValueReason: draft.workValueReason ?? "",
    invoiceDate: draft.invoiceDate,
    dueDate: draft.dueDate ?? "",
    referenceType: draft.referenceType ?? "",
    referenceNumber: draft.referenceNumber ?? "",
    referenceDate: draft.referenceDate ?? "",
    paymentTerms: draft.paymentTerms ?? "",
    items:
      draft.items.length > 0
        ? draft.items.map((item) => ({
            key: item.id,
            description: item.description,
            details: item.details ?? "",
            quantity: item.quantity,
            unit: item.unit,
            unitPrice: item.unitPrice,
            discountAmount: item.discountAmount,
          }))
        : [newItemRow()],
    discountAmount: draft.discountAmount,
    additionalAmount: draft.additionalAmount,
    taxMode: draft.taxMode,
    taxPercent: draft.taxPercent ?? "",
    taxAmountInput: draft.taxAmountInput ?? "",
    roundingAmount: draft.roundingAmount,
    bankAccountId: draft.bankAccountId ?? "",
    stampMode: (draft.stampMode as StampModeValue) ?? "NONE",
    signerId: draft.signerId ?? "",
    notes: draft.notes ?? "",
    footerText: draft.footerText ?? "",
  };
}

/** Rows the editor feeds preview + payload (blank template rows excluded —
 * the exact same rule the server applies before persisting). */
export function worthSavingRows(values: EditorFormValues): EditorItemRow[] {
  return values.items.filter((row) =>
    isItemWorthSaving({
      description: row.description,
      quantity: row.quantity,
      unitPrice: row.unitPrice,
      unit: row.unit,
    }),
  );
}

/** Subset consumed by the live preview (renderer contract). */
export function rendererValuesOf(values: EditorFormValues): RendererFormValues {
  return {
    invoiceType: values.invoiceType,
    billingMode: values.billingMode,
    billingPercent: values.billingPercent,
    billingAmount: values.billingAmount,
    termName: values.termName,
    termNumber: values.termNumber,
    customLabel: values.customLabel,
    workValueOverride: values.workValueOverride,
    workValueOverrideAmount: values.workValueOverrideAmount,
    invoiceDate: values.invoiceDate,
    dueDate: values.dueDate,
    referenceType: values.referenceType,
    referenceNumber: values.referenceNumber,
    referenceDate: values.referenceDate,
    paymentTerms: values.paymentTerms,
    items: values.items,
    discountAmount: values.discountAmount,
    additionalAmount: values.additionalAmount,
    taxMode: values.taxMode,
    taxPercent: values.taxPercent,
    taxAmountInput: values.taxAmountInput,
    roundingAmount: values.roundingAmount,
    stampMode: values.stampMode,
    notes: values.notes,
    footerText: values.footerText,
  };
}

/** Editor values → the exact payload shape the server action validates.
 * Blank optional strings are stripped so zod defaults apply. */
export function toDraftPayload(
  values: EditorFormValues,
  invoiceId?: string,
): InvoiceDraftFormValues {
  const optional = (value: string): string | undefined =>
    value.trim() === "" ? undefined : value.trim();
  return {
    profileId: values.profileId,
    invoiceType: values.invoiceType,
    customerId: values.customerId,
    customerContactId: optional(values.customerContactId),
    projectReferenceId: optional(values.projectReferenceId),
    billingMode: values.billingMode,
    billingPercent: values.billingPercent,
    billingAmount: values.billingAmount,
    termName: optional(values.termName),
    termNumber: optional(values.termNumber),
    customLabel: optional(values.customLabel),
    customReason: optional(values.customReason),
    workValueOverride: values.workValueOverride,
    workValueOverrideAmount: values.workValueOverrideAmount,
    workValueReason: optional(values.workValueReason),
    invoiceDate: values.invoiceDate,
    dueDate: optional(values.dueDate),
    referenceType: values.referenceType as InvoiceDraftFormValues["referenceType"],
    referenceNumber: optional(values.referenceNumber),
    referenceDate: optional(values.referenceDate),
    paymentTerms: optional(values.paymentTerms),
    items: worthSavingRows(values).map((row) => ({
      description: row.description,
      details: optional(row.details),
      quantity: row.quantity,
      unit: row.unit,
      unitPrice: row.unitPrice,
      discountAmount: optional(row.discountAmount),
    })),
    discountAmount: optional(values.discountAmount),
    additionalAmount: optional(values.additionalAmount),
    taxMode: values.taxMode,
    taxPercent: values.taxPercent,
    taxAmountInput: values.taxAmountInput,
    roundingAmount: values.roundingAmount,
    bankAccountId: optional(values.bankAccountId),
    stampMode: values.stampMode,
    signerId: optional(values.signerId),
    notes: optional(values.notes),
    footerText: optional(values.footerText),
    ...(invoiceId ? { invoiceId } : {}),
  } as InvoiceDraftFormValues & { invoiceId: string };
}

/** The minimum a draft needs before the FIRST save can exist server-side
 * (create validates the whole schema — an empty shell is not saveable). */
export function canAutosave(values: EditorFormValues): boolean {
  return values.profileId !== "" && values.customerId !== "";
}

/** Stable snapshot for dirty detection (item keys excluded — reordering
 * changes order, keys stay; a plain JSON of the payload covers it). */
export function dirtyFingerprint(values: EditorFormValues): string {
  return JSON.stringify(toDraftPayload(values));
}
