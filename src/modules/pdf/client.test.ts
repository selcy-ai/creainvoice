// src/modules/pdf/client.test.ts
// Feature 06 unit: pure helpers of the pdf-service client — the download
// filename contract (`INV/SB/VII/2026/001` → `INV-SB-VII-2026-001.pdf`, the
// acceptance example) and the reference footer line pdf-service draws under
// every page.

import { describe, expect, it } from "vitest";
import { invoicePdfFooter, safePdfFilename } from "@/modules/pdf/client";

describe("safePdfFilename", () => {
  it("turns the invoice number into the acceptance filename", () => {
    expect(safePdfFilename("inv_1", "INV/SB/VII/2026/001")).toBe("INV-SB-VII-2026-001.pdf");
  });

  it("keeps a simple number as-is", () => {
    expect(safePdfFilename("inv_1", "INV-2026-001")).toBe("INV-2026-001.pdf");
  });

  it("strips traversal and shell-hostile characters", () => {
    const name = safePdfFilename("inv_1", "../../etc/pass wd;rm -rf");
    expect(name).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*\.pdf$/);
    expect(name).not.toContain("/");
    expect(name).not.toContain("..");
    expect(name).not.toContain(" ");
  });

  it("bounds the length and never starts with a dot", () => {
    const name = safePdfFilename("inv_1", `${"A".repeat(200)}.pdf`);
    expect(name.length).toBeLessThanOrEqual(84);
    expect(name.startsWith(".")).toBe(false);
  });

  it("falls back to the invoice id when the number is missing", () => {
    expect(safePdfFilename("clxyz123", null)).toBe("invoice-clxyz123.pdf");
    expect(safePdfFilename("clxyz123", "///")).toBe("invoice-clxyz123.pdf");
  });
});

describe("invoicePdfFooter", () => {
  it("uses the Purchase Order line when the reference is a PO", () => {
    expect(
      invoicePdfFooter({
        referenceType: "PURCHASE_ORDER",
        referenceNumber: "5198021181",
        customerName: "PT Cipta Karya Nusantara",
        issuerName: "CreaInvoice Studio",
      }),
    ).toBe(
      "Invoice ini dibuat berdasarkan Purchase Order PT Cipta Karya Nusantara Nomor 5198021181.",
    );
  });

  it("falls back to the issuer line without a PO reference", () => {
    expect(
      invoicePdfFooter({
        referenceType: null,
        referenceNumber: null,
        customerName: "PT Cipta Karya Nusantara",
        issuerName: "CreaInvoice Studio",
      }),
    ).toBe("Invoice ini diterbitkan oleh CreaInvoice Studio.");
  });

  it("falls back to the issuer line for non-PO reference types", () => {
    expect(
      invoicePdfFooter({
        referenceType: "CONTRACT",
        referenceNumber: "KW-001",
        customerName: "PT Cipta Karya Nusantara",
        issuerName: "CreaInvoice Studio",
      }),
    ).toBe("Invoice ini diterbitkan oleh CreaInvoice Studio.");
  });

  it("falls back to the issuer line when the customer name is absent", () => {
    expect(
      invoicePdfFooter({
        referenceType: "PURCHASE_ORDER",
        referenceNumber: "5198021181",
        customerName: null,
        issuerName: "CreaInvoice Studio",
      }),
    ).toBe("Invoice ini diterbitkan oleh CreaInvoice Studio.");
  });
});
