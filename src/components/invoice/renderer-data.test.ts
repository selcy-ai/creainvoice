// src/components/invoice/renderer-data.test.ts
// Feature 10: the LIVE editor preview resolves notes with the same rule the
// server uses — known tokens formatted id-ID, unknown tokens left literal and
// reported in `notesUnknownTokens` (the field the preview warning renders),
// and the draft bank block stays MASKED (the full number only exists on the
// issued snapshot path).

import { describe, expect, it } from "vitest";
import {
  buildRendererPreviewData,
  type RendererFormValues,
  type RendererPreviewInput,
} from "@/components/invoice/renderer-data";

function formValues(overrides: Partial<RendererFormValues> = {}): RendererFormValues {
  return {
    invoiceType: "DOWN_PAYMENT",
    billingMode: "PERCENT",
    billingPercent: "50",
    billingAmount: "",
    termName: "",
    termNumber: "",
    customLabel: "",
    workValueOverride: false,
    workValueOverrideAmount: "",
    invoiceDate: "2026-07-01",
    dueDate: "",
    referenceType: "PURCHASE_ORDER",
    referenceNumber: "5198021181",
    referenceDate: "",
    paymentTerms: "",
    items: [
      { description: "Pemasangan", details: "", quantity: "5", unit: "Unit", unitPrice: "900000", discountAmount: "" },
    ],
    discountAmount: "",
    additionalAmount: "",
    taxMode: "NONE",
    taxPercent: "",
    taxAmountInput: "",
    roundingAmount: "",
    stampMode: "NONE",
    notes: "",
    footerText: "",
    ...overrides,
  };
}

function previewInput(overrides: Partial<RendererPreviewInput> = {}): RendererPreviewInput {
  return {
    values: formValues(),
    numberPreview: "INV/SB/VII/2026/001",
    profile: {
      name: "CreaInvoice Studio",
      legalName: null,
      logoPath: null,
      primaryColor: "#2563eb",
      address: null,
      phone: null,
      whatsapp: null,
      fax: null,
      email: null,
      website: null,
      taxId: null,
    },
    customer: { name: "PT Token Nusantara" },
    contactName: null,
    projectTitle: null,
    bank: null,
    signer: null,
    previouslyBilled: "0",
    currency: "IDR",
    ...overrides,
  };
}

describe("buildRendererPreviewData — token notes in the live preview", () => {
  it("resolves every known token with the spec's id-ID formats", () => {
    const data = buildRendererPreviewData(
      previewInput({
        values: formValues({
          notes:
            "Penagihan Down Payment {BILLING_PERCENT} dari nilai PO sebesar {WORK_VALUE}. " +
            "PO {REFERENCE_NUMBER}, total {GRAND_TOTAL}, {CUSTOMER_NAME} — {INVOICE_NUMBER}.",
        }),
      }),
    );

    // Preview === print: the same values the detail/print path produces.
    expect(data.notes).toBe(
      "Penagihan Down Payment 50% dari nilai PO sebesar Rp4.500.000. " +
        "PO 5198021181, total Rp2.250.000, PT Token Nusantara — INV/SB/VII/2026/001.",
    );
    expect(data.notesUnknownTokens).toEqual([]);
    expect(data.numberPreview).toBe("INV/SB/VII/2026/001");
  });

  it("keeps unknown tokens literal and reports them for the preview warning", () => {
    const data = buildRendererPreviewData(
      previewInput({
        values: formValues({ notes: "Halo {FOOBAR} dan {BAR_BAZ}." }),
      }),
    );
    expect(data.notes).toBe("Halo {FOOBAR} dan {BAR_BAZ}.");
    expect(data.notesUnknownTokens).toEqual(["FOOBAR", "BAR_BAZ"]);
  });

  it("resolves a known token with no value to an empty string", () => {
    const data = buildRendererPreviewData(
      previewInput({
        values: formValues({
          referenceNumber: "",
          billingMode: "MANUAL",
          billingPercent: "",
          notes: "PO {REFERENCE_NUMBER} / termin {BILLING_PERCENT}.",
        }),
      }),
    );
    expect(data.notes).toBe("PO  / termin .");
    expect(data.notesUnknownTokens).toEqual([]);
  });

  it("leaves token-free notes untouched", () => {
    const data = buildRendererPreviewData(
      previewInput({ values: formValues({ notes: "Terima kasih." }) }),
    );
    expect(data.notes).toBe("Terima kasih.");
    expect(data.notesUnknownTokens).toEqual([]);
  });
});

describe("buildRendererPreviewData — draft bank block stays masked", () => {
  it("never carries a full account number into the client preview", () => {
    const data = buildRendererPreviewData(
      previewInput({
        bank: {
          bankName: "Bank Uji",
          accountHolder: "PT CreaInvoice Studio",
          maskedNumber: "**** **** 3449",
          branch: null,
        },
      }),
    );
    expect(data.bank?.maskedNumber).toBe("**** **** 3449");
    // The full number is a snapshot-only value (spec: nomor lengkap hanya di
    // invoice (snapshot)) — the draft path must not receive one at all.
    expect(data.bank?.accountNumber).toBeUndefined();
  });
});
