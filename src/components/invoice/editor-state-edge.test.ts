// src/components/invoice/editor-state-edge.test.ts
// Independent regression pass over the editor's form-state module (feature 04)
// — the BUG-1 family (blank template row killing the first autosave) plus the
// surrounding blank/optional-field normalization that the original regression
// file does not reach:
//
//   • the template row (qty "1", price "") survives worthSavingRows AND the
//     server schema (price "" → "0")
//   • a FULLY blank template row is dropped (never persisted, never rejected)
//   • autosave gates on profile + customer only — a blank row must not block it
//   • toDraftPayload normalizes every optional blank to undefined so the
//     schema defaults apply (stampMode/referenceType/enums are NOT blanked)
//   • dirty detection must change when only an ORDER swaps, and must NOT
//     change when an item key changes (keys are identity, not content)
//   • editorValuesFromDraft hydrates the same shape back (round-trip)

import { describe, expect, it } from "vitest";
import { invoiceDraftFormSchema } from "@/modules/invoices/schema";
import {
  canAutosave,
  dirtyFingerprint,
  editorValuesFromDraft,
  emptyEditorValues,
  newItemRow,
  toDraftPayload,
  worthSavingRows,
  type EditorFormValues,
} from "@/components/invoice/editor-state";
import type { InvoiceDraftView } from "@/modules/invoices/service";

/** A fresh editor with the minimum a first save needs (profile + customer). */
function freshEditorValues(): EditorFormValues {
  const values = emptyEditorValues();
  values.profileId = "profile-1";
  values.customerId = "customer-1";
  return values;
}

function parsePayload(values: EditorFormValues) {
  return invoiceDraftFormSchema.safeParse(toDraftPayload(values));
}

/** A minimal persisted draft view for the hydration round-trip. */
function draftView(overrides: Partial<InvoiceDraftView> = {}): InvoiceDraftView {
  return {
    id: "invoice-1",
    status: "DRAFT",
    invoiceType: "DOWN_PAYMENT",
    number: null,
    numberPreview: "INV/SB/VII/2026/001",
    profile: {
      id: "profile-1",
      name: "CreaInvoice Studio",
      legalName: null,
      code: "SB",
      logoPath: null,
      primaryColor: "#2563eb",
      address: null,
      phone: null,
      whatsapp: null,
      fax: null,
      email: null,
      website: null,
      taxId: null,
      numberPattern: "INV/{CODE}/{ROMAN_MONTH}/{YYYY}/{SEQ:3}",
      numberPreview: "INV/SB/VII/2026/001",
      settings: { hideZeroRows: true, hideStampLabel: false },
    },
    customer: null,
    customerContactId: null,
    contactName: null,
    projectReferenceId: null,
    projectTitle: null,
    invoiceDate: "2026-07-15",
    dueDate: null,
    referenceType: "PURCHASE_ORDER",
    referenceNumber: null,
    referenceDate: null,
    paymentTerms: null,
    currency: "IDR",
    billingMode: "PERCENT",
    billingPercent: "50",
    billingAmount: null,
    termName: null,
    termNumber: null,
    customLabel: null,
    customReason: null,
    workValueOverride: false,
    workValueOverrideAmount: null,
    workValueReason: null,
    previouslyBilled: "0.00",
    items: [
      {
        id: "item-1",
        position: 1,
        description: "Pemasangan bracket frame",
        details: null,
        quantity: "5",
        unit: "Unit",
        unitPrice: "900000",
        discountAmount: "0",
        lineAmount: "4500000.00",
      },
    ],
    discountAmount: "0.00",
    additionalAmount: "0.00",
    taxMode: "NONE",
    taxPercent: null,
    taxAmountInput: null,
    roundingAmount: "0.00",
    bankAccountId: null,
    stampMode: "NONE",
    signerId: null,
    notes: null,
    footerText: null,
    calc: {
      lineAmounts: ["4500000.00"],
      itemsSubtotal: "4500000.00",
      workValue: "4500000.00",
      previouslyBilled: "0.00",
      billingBase: "2250000.00",
      remainingAfter: "2250000.00",
      discountAmount: "0.00",
      additionalAmount: "0.00",
      taxMode: "NONE",
      taxPercent: "0.00",
      taxIncludedInTotal: "0.00",
      taxAmount: "0.00",
      roundingAmount: "0.00",
      grandTotal: "2250000.00",
    },
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    ...overrides,
  };
}

describe("BUG-1 regression — blank template row on the first autosave", () => {
  it("a brand-new editor autosaves: template row sent, price '' normalized to 0", () => {
    const values = freshEditorValues();
    expect(canAutosave(values)).toBe(true);
    expect(worthSavingRows(values)).toHaveLength(1);

    const payload = toDraftPayload(values);
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]?.unitPrice).toBe("");
    expect(payload.items[0]?.quantity).toBe("1");

    const parsed = parsePayload(values);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.items[0]?.unitPrice).toBe("0");
      expect(parsed.data.items[0]?.quantity).toBe("1");
    }
  });

  it("a fully blank template row is dropped, not persisted and not rejected", () => {
    const values = freshEditorValues();
    values.items = [
      { key: "blank", description: "", details: "", quantity: "", unit: "Unit", unitPrice: "", discountAmount: "" },
    ];

    expect(worthSavingRows(values)).toHaveLength(0);
    expect(toDraftPayload(values).items).toHaveLength(0);
    expect(parsePayload(values).success).toBe(true);
  });

  it("a priced row with a blank description still counts (user typed a price)", () => {
    const values = freshEditorValues();
    values.items = [
      {
        key: "priced",
        description: "",
        details: "",
        quantity: "2",
        unit: "Unit",
        unitPrice: "100000",
        discountAmount: "",
      },
    ];

    expect(worthSavingRows(values)).toHaveLength(1);
    const parsed = parsePayload(values);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.items[0]?.unitPrice).toBe("100000");
      expect(parsed.data.items[0]?.discountAmount).toBeUndefined();
    }
  });

  it("autosave is NOT blocked by a blank row — only profile + customer gate it", () => {
    const blank = emptyEditorValues();
    blank.items = [
      { key: "b", description: "", details: "", quantity: "", unit: "", unitPrice: "", discountAmount: "" },
    ];
    // No profile/customer selected yet → cannot save.
    expect(canAutosave(blank)).toBe(false);
    blank.profileId = "p";
    // Customer still missing → still cannot save.
    expect(canAutosave(blank)).toBe(false);
    blank.customerId = "c";
    expect(canAutosave(blank)).toBe(true);
  });

  it("the metadata: blank template rows survive a re-parse round trip", () => {
    // The bug's shape: the server stores unitPrice "0"; reopening the editor
    // must show the same row the user had.
    const parsed = parsePayload(freshEditorValues());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const draft = draftView({
      items: [
        {
          id: "item-template",
          position: 1,
          description: "",
          details: null,
          quantity: "1",
          unit: "Unit",
          unitPrice: "0",
          discountAmount: "0",
          lineAmount: "0.00",
        },
      ],
    });
    const hydrated = editorValuesFromDraft(draft);
    expect(hydrated.items).toHaveLength(1);
    expect(hydrated.items[0]?.unitPrice).toBe("0");
    expect(hydrated.items[0]?.quantity).toBe("1");
    // A persisted draft always carries a customer — the payload validates.
    hydrated.customerId = "customer-1";
    // Re-sending the hydrated values must still validate.
    const reParsed = parsePayload(hydrated);
    expect(reParsed.success).toBe(true);
  });
});

describe("toDraftPayload — blank optional normalization", () => {
  it("strips blank optionals so zod defaults apply", () => {
    const values = freshEditorValues();
    const payload = toDraftPayload(values);
    expect(payload.customerContactId).toBeUndefined();
    expect(payload.projectReferenceId).toBeUndefined();
    expect(payload.dueDate).toBeUndefined();
    expect(payload.referenceNumber).toBeUndefined();
    expect(payload.notes).toBeUndefined();
    expect(payload.items[0]?.details).toBeUndefined();
  });

  it("keeps the enum/text fields that must never be blanked", () => {
    const values = freshEditorValues();
    const payload = toDraftPayload(values);
    // taxMode/billingMode/stampMode/referenceType are enums — no default is
    // applied by the schema for referenceType (it is optional), but the rest
    // must always travel.
    expect(payload.billingMode).toBe("PERCENT");
    expect(payload.taxMode).toBe("NONE");
    expect(payload.stampMode).toBe("NONE");
    expect(payload.workValueOverride).toBe(false);
  });

  it("keeps item text as typed — trimming belongs to the server mapper", () => {
    // toDraftPayload only trims the optional text fields it blanks to
    // undefined; item rows travel verbatim and normalizeValues trims them on
    // the server (so the live preview shows exactly what the user typed).
    const values = freshEditorValues();
    values.notes = "  Mohon kirim 2 salinan  ";
    values.items = [
      { ...values.items[0]!, description: "  Jasa pengawasan  " },
    ];
    const payload = toDraftPayload(values);
    expect(payload.notes).toBe("Mohon kirim 2 salinan");
    expect(payload.items[0]?.description).toBe("  Jasa pengawasan  ");
    // The schema trims, so the untrimmed row still validates.
    const parsed = parsePayload(values);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.items[0]?.description).toBe("Jasa pengawasan");
    }
  });

  it("attaches the invoice id only for the update path", () => {
    const values = freshEditorValues();
    // The declared return type is InvoiceDraftFormValues; the update path adds
    // invoiceId on top (the service takes it as a separate parameter), so the
    // runtime shape carries it while the type does not.
    const withoutId = { ...(toDraftPayload(values) as Record<string, unknown>) };
    const withId = toDraftPayload(values, "invoice-42") as Record<string, unknown>;
    expect(withoutId.invoiceId).toBeUndefined();
    expect(withId.invoiceId).toBe("invoice-42");
    // Everything else is identical — the id is purely additive.
    delete withId.invoiceId;
    expect(withoutId).toEqual(withId);
  });
});

describe("worthSavingRows — the row rule", () => {
  it("keeps any row with description OR quantity OR price, drops the rest", () => {
    const values = freshEditorValues();
    values.items = [
      { key: "a", description: "Barang", details: "", quantity: "1", unit: "Unit", unitPrice: "1000", discountAmount: "" },
      { key: "b", description: "", details: "", quantity: "", unit: "Unit", unitPrice: "", discountAmount: "" },
      { key: "c", description: "", details: "", quantity: "3", unit: "Unit", unitPrice: "", discountAmount: "" },
      { key: "d", description: "", details: "", quantity: "", unit: "Unit", unitPrice: "7000", discountAmount: "" },
    ];
    expect(worthSavingRows(values).map((row) => row.key)).toEqual(["a", "c", "d"]);
  });

  it("a row with only whitespace is blank", () => {
    const values = freshEditorValues();
    values.items = [
      { key: "ws", description: "   ", details: "", quantity: "  ", unit: "Unit", unitPrice: "  ", discountAmount: "" },
    ];
    expect(worthSavingRows(values)).toHaveLength(0);
  });
});

describe("dirtyFingerprint — unsaved-change detection", () => {
  it("changes when a value changes", () => {
    const values = freshEditorValues();
    const before = dirtyFingerprint(values);
    values.notes = "catatan baru";
    expect(dirtyFingerprint(values)).not.toBe(before);
  });

  it("changes when only the item ORDER swaps (drag reorder)", () => {
    const values = freshEditorValues();
    values.items = [
      { key: "a", description: "A", details: "", quantity: "1", unit: "Unit", unitPrice: "1000", discountAmount: "" },
      { key: "b", description: "B", details: "", quantity: "1", unit: "Unit", unitPrice: "2000", discountAmount: "" },
    ];
    const before = dirtyFingerprint(values);
    values.items = [values.items[1]!, values.items[0]!];
    expect(dirtyFingerprint(values)).not.toBe(before);
  });

  it("does NOT change when only item keys change (keys are UI identity)", () => {
    const values = freshEditorValues();
    values.items = [
      { key: "uuid-1", description: "A", details: "", quantity: "1", unit: "Unit", unitPrice: "1000", discountAmount: "" },
    ];
    const before = dirtyFingerprint(values);
    values.items = [
      { key: "uuid-2", description: "A", details: "", quantity: "1", unit: "Unit", unitPrice: "1000", discountAmount: "" },
    ];
    expect(dirtyFingerprint(values)).toBe(before);
  });

  it("is stable for an identical values object (no false dirty on reload)", () => {
    const a = freshEditorValues();
    const b = freshEditorValues();
    expect(dirtyFingerprint(a)).toBe(dirtyFingerprint(b));
  });
});

describe("newItemRow — template defaults", () => {
  it("opens with qty 1, empty price and an empty description", () => {
    const row = newItemRow();
    expect(row.quantity).toBe("1");
    expect(row.unitPrice).toBe("");
    expect(row.description).toBe("");
    expect(row.discountAmount).toBe("");
    expect(row.unit).toBe("Unit");
    // Every row needs a unique UI key for drag reorder.
    expect(row.key).not.toBe(newItemRow().key);
  });
});

describe("editorValuesFromDraft — hydration", () => {
  it("maps the persisted draft back into editor values", () => {
    const hydrated = editorValuesFromDraft(draftView());
    expect(hydrated.profileId).toBe("profile-1");
    expect(hydrated.customerId).toBe("");
    expect(hydrated.invoiceType).toBe("DOWN_PAYMENT");
    expect(hydrated.billingPercent).toBe("50");
    expect(hydrated.items).toHaveLength(1);
    expect(hydrated.items[0]?.description).toBe("Pemasangan bracket frame");
    expect(hydrated.items[0]?.key).toBe("item-1");
    expect(hydrated.taxPercent).toBe("");
  });

  it("falls back to one template row when the draft has no items", () => {
    const hydrated = editorValuesFromDraft(draftView({ items: [] }));
    expect(hydrated.items).toHaveLength(1);
    expect(hydrated.items[0]?.quantity).toBe("1");
  });

  it("nulls become empty strings (never 'null' text in the form)", () => {
    const hydrated = editorValuesFromDraft(draftView());
    expect(hydrated.dueDate).toBe("");
    expect(hydrated.notes).toBe("");
    expect(hydrated.projectReferenceId).toBe("");
    expect(hydrated.signerId).toBe("");
  });
});
