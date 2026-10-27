// src/lib/tokens.test.ts
// Feature 10 "Check When Done": token resolve covers EVERY token, the id-ID
// formats from the spec examples (Rp4.500.000 / 50% / Rp2.250.000), the
// unknown-token rule ({FOOBAR} stays literal and is reported), and the
// ratified empty-value rule (known token + no value → "").

import { describe, expect, it } from "vitest";
import {
  formatPercentToken,
  formatRupiahToken,
  resolveNotesTokens,
} from "@/lib/tokens";

describe("resolveNotesTokens — every token", () => {
  it("resolves all six tokens from invoice values (spec examples)", () => {
    const template =
      "Penagihan Down Payment {BILLING_PERCENT} dari nilai PO sebesar {WORK_VALUE}. " +
      "Mohon cantumkan nomor PO {REFERENCE_NUMBER} pada berita transfer ke {GRAND_TOTAL} " +
      "atas nama {CUSTOMER_NAME}, nomor invoice {INVOICE_NUMBER}.";
    const { text, unknownTokens } = resolveNotesTokens(template, {
      invoiceNumber: "INV/SB/VII/2026/001",
      referenceNumber: "5198021181",
      customerName: "PT Cipta Karya Nusantara",
      workValue: "4500000.00",
      billingPercent: "50.00",
      grandTotal: "2250000.00",
    });

    expect(text).toBe(
      "Penagihan Down Payment 50% dari nilai PO sebesar Rp4.500.000. " +
        "Mohon cantumkan nomor PO 5198021181 pada berita transfer ke Rp2.250.000 " +
        "atas nama PT Cipta Karya Nusantara, nomor invoice INV/SB/VII/2026/001.",
    );
    expect(unknownTokens).toEqual([]);
  });

  it("formats money id-ID without a trailing-zero tail", () => {
    const { text } = resolveNotesTokens("{WORK_VALUE} / {GRAND_TOTAL}", {
      workValue: "4500000",
      grandTotal: "10500000.00",
    });
    expect(text).toBe("Rp4.500.000 / Rp10.500.000");
  });

  it("formats percent like the document's percent row", () => {
    expect(resolveNotesTokens("{BILLING_PERCENT}", { billingPercent: "50" }).text).toBe("50%");
    expect(resolveNotesTokens("{BILLING_PERCENT}", { billingPercent: "50.00" }).text).toBe("50%");
    expect(resolveNotesTokens("{BILLING_PERCENT}", { billingPercent: "50.5" }).text).toBe("50,5%");
  });

  it("leaves text without placeholders untouched", () => {
    const { text, unknownTokens } = resolveNotesTokens(
      "Terima kasih atas kepercayaan Anda.",
      {},
    );
    expect(text).toBe("Terima kasih atas kepercayaan Anda.");
    expect(unknownTokens).toEqual([]);
  });

  it("handles null/empty templates without pretending a value exists", () => {
    expect(resolveNotesTokens(null, {})).toEqual({ text: "", unknownTokens: [] });
    expect(resolveNotesTokens(undefined, {})).toEqual({ text: "", unknownTokens: [] });
    expect(resolveNotesTokens("", {})).toEqual({ text: "", unknownTokens: [] });
  });
});

describe("unknown tokens (spec: dibiarkan literal + warning)", () => {
  it("keeps {FOOBAR} literal and reports it for the preview warning", () => {
    const { text, unknownTokens } = resolveNotesTokens(
      "Halo {FOOBAR}, nomor {INVOICE_NUMBER}",
      { invoiceNumber: "INV/1" },
    );
    expect(text).toBe("Halo {FOOBAR}, nomor INV/1");
    expect(unknownTokens).toEqual(["FOOBAR"]);
  });

  it("reports each unknown token once and does not touch similar names", () => {
    const { text, unknownTokens } = resolveNotesTokens(
      "{FOOBAR} {FOOBAR} {foobar} {CUSTOMER_NAME}",
      { customerName: "PT Uji" },
    );
    expect(text).toBe("{FOOBAR} {FOOBAR} {foobar} PT Uji");
    expect(unknownTokens).toEqual(["FOOBAR", "foobar"]);
  });

  it("does not match brace text that is not token-shaped", () => {
    const { text, unknownTokens } = resolveNotesTokens("batas { ini} dan {a b}", {});
    expect(text).toBe("batas { ini} dan {a b}");
    expect(unknownTokens).toEqual([]);
  });
});

describe("known token with no value (ratified: empty string)", () => {
  it("resolves to empty so a sent document never prints a literal {…}", () => {
    const { text, unknownTokens } = resolveNotesTokens(
      "Mohon cantumkan nomor PO {REFERENCE_NUMBER} pada berita transfer.",
      { referenceNumber: null },
    );
    expect(text).toBe("Mohon cantumkan nomor PO  pada berita transfer.");
    expect(unknownTokens).toEqual([]);
  });

  it("treats blank/whitespace values as absent", () => {
    const { text } = resolveNotesTokens(
      "{REFERENCE_NUMBER}|{CUSTOMER_NAME}|{INVOICE_NUMBER}",
      { referenceNumber: "  ", customerName: "", invoiceNumber: undefined },
    );
    expect(text).toBe("||");
  });

  it("resolves BILLING_PERCENT to empty for manual/custom billing (no percent)", () => {
    const { text } = resolveNotesTokens("Penagihan {BILLING_PERCENT} nilai.", {
      billingPercent: null,
    });
    expect(text).toBe("Penagihan  nilai.");
  });

  it("never prints GRAND_TOTAL/WORK_VALUE tokens even for zero-like input", () => {
    // A value exists → formatted; absence → empty. Never literal.
    expect(resolveNotesTokens("{GRAND_TOTAL}", { grandTotal: "0.00" }).text).toBe("Rp0");
    expect(resolveNotesTokens("{GRAND_TOTAL}", { grandTotal: null }).text).toBe("");
  });
});

describe("format helpers", () => {
  it("formatRupiahToken drops zero decimals and keeps real ones", () => {
    expect(formatRupiahToken("4500000.00")).toBe("Rp4.500.000");
    expect(formatRupiahToken("4500000")).toBe("Rp4.500.000");
    expect(formatRupiahToken("4500000.50")).toBe("Rp4.500.000,50");
    expect(formatRupiahToken("0")).toBe("Rp0");
    expect(formatRupiahToken("")).toBe("");
  });

  it("formatPercentToken strips only a zero-cents tail", () => {
    expect(formatPercentToken("50.00")).toBe("50%");
    expect(formatPercentToken("12.75")).toBe("12,75%");
    expect(formatPercentToken("")).toBe("");
  });
});
