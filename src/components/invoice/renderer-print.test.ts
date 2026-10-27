// src/components/invoice/renderer-print.test.ts
// Feature 06 unit: the print-specific document rules of the SHARED
// InvoiceRenderer — meterai slots (spec shapes + label toggle), document
// settings (hide-zero rows), spec column headers, and the signature block.
// Rendered with renderToStaticMarkup: exactly the markup the print route
// serves and pdf-service prints, so these assertions hold for preview AND
// PDF (one component — the whole point of the feature).

import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { InvoiceRenderer } from "@/components/invoice/InvoiceRenderer";
import { calculateInvoice } from "@/modules/invoices/calculation";
import type { InvoiceRendererData } from "@/components/invoice/renderer-data";

function makeData(overrides: Partial<InvoiceRendererData> = {}): InvoiceRendererData {
  const calc = calculateInvoice({
    invoiceType: "DOWN_PAYMENT",
    items: [{ quantity: "5", unitPrice: "900000" }],
    billingMode: "PERCENT",
    billingPercent: "50",
    taxMode: "NONE",
  });
  return {
    number: "INV/SB/VII/2026/001",
    numberPreview: "INV/SB/VII/2026/001",
    status: "ISSUED",
    invoiceType: "DOWN_PAYMENT",
    billingMode: "PERCENT",
    billingPercent: "50",
    invoiceDate: "2026-07-01",
    dueDate: "2026-07-31",
    referenceType: "PURCHASE_ORDER",
    referenceNumber: "5198021181",
    issuer: { name: "CreaInvoice Studio", legalName: "PT CreaInvoice Studio" },
    customer: { name: "PT Cipta Karya Nusantara" },
    contactName: "Andi Wijaya",
    contactTitle: "Procurement",
    contactDivision: "Purchasing",
    items: [
      {
        position: 1,
        description: "Pemasangan bracket frame",
        quantity: "5",
        unit: "Unit",
        unitPrice: "900000",
        lineAmount: "4500000.00",
      },
    ],
    calc,
    taxIncludedInTotal: calc.taxIncludedInTotal,
    bank: null,
    signer: { name: "Andi", title: "Direktur", location: "Yogyakarta", signaturePath: null },
    stampMode: "NONE",
    settings: { hideZeroRows: true, hideStampLabel: false },
    primaryColor: "#2563eb",
    currency: "IDR",
    ...overrides,
  };
}

function render(overrides: Partial<InvoiceRendererData> = {}): string {
  // createElement keeps this file JSX-free so it can stay a `.ts` test
  // (vitest collects `*.test.ts`); the output markup is identical.
  return renderToStaticMarkup(createElement(InvoiceRenderer, { data: makeData(overrides) }));
}

describe("spec column headers", () => {
  it("uses the feature 06 column names", () => {
    const html = render();
    for (const header of ["No", "Deskripsi", "Qty", "Unit", "Harga Satuan", "Jumlah"]) {
      expect(html).toContain(`>${header}<`);
    }
  });

  it("shows the kind badge next to the number", () => {
    expect(render()).toContain("DOWN PAYMENT 50%");
  });
});

describe("meterai slots", () => {
  it("E_METERAI draws a compact dashed slot labelled 'Slot E-Meterai' left of the signature", () => {
    const html = render({ stampMode: "E_METERAI" });
    expect(html).toContain("Slot E-Meterai");
    expect(html).toContain("border-dashed");
    expect(html).toContain('aria-label="Slot e-meterai"');
    // Left of the signature block: the slot markup appears before the name.
    expect(html.indexOf("Slot E-Meterai")).toBeLessThan(html.indexOf(">Andi</p>"));
  });

  it("the E_METERAI label can be switched off while the slot stays", () => {
    const html = render({
      stampMode: "E_METERAI",
      settings: { hideZeroRows: true, hideStampLabel: true },
    });
    expect(html).not.toContain("Slot E-Meterai");
    expect(html).toContain('aria-label="Slot e-meterai"');
  });

  it("PHYSICAL draws a printed guide (no dashed fake stamp)", () => {
    const html = render({ stampMode: "PHYSICAL" });
    expect(html).toContain('aria-label="Area meterai fisik"');
    expect(html).not.toContain("border-dashed");
    expect(html).not.toContain("Slot E-Meterai");
  });

  it("BLANK_SPACE reserves a neat space with nothing drawn", () => {
    const html = render({ stampMode: "BLANK_SPACE" });
    expect(html).not.toContain('aria-label="Slot e-meterai"');
    expect(html).not.toContain('aria-label="Area meterai fisik"');
    expect(html).not.toContain("Slot E-Meterai");
    expect(html).toContain("Hormat kami,");
  });

  it("NONE keeps the signature block clean (no slot at all)", () => {
    const html = render({ stampMode: "NONE" });
    expect(html).not.toContain('aria-label="Slot e-meterai"');
    expect(html).not.toContain('aria-label="Area meterai fisik"');
    expect(html).toContain(">Andi</p>");
    expect(html).toContain("Direktur");
  });

  it("never draws a stamp image (slot placeholder only)", () => {
    for (const mode of ["NONE", "E_METERAI", "PHYSICAL", "BLANK_SPACE"]) {
      expect(render({ stampMode: mode })).not.toMatch(/meterai.*\.(png|jpg|svg)/i);
    }
  });
});

describe("signature block", () => {
  it("carries location + date, name and title", () => {
    const html = render();
    expect(html).toContain("Yogyakarta, 01 Juli 2026");
    expect(html).toContain(">Andi</p>");
    expect(html).toContain("Direktur");
  });

  it("renders the bill-to PIC with jabatan/divisi", () => {
    const html = render();
    expect(html).toContain("Andi Wijaya — Purchasing");
  });
});

describe("document settings (hide-zero rows)", () => {
  it("hides zero-value summary rows by default", () => {
    expect(render()).not.toContain(">Diskon<");
  });

  it("shows zero-value rows when the profile opts out of hiding", () => {
    const html = render({ settings: { hideZeroRows: false, hideStampLabel: false } });
    expect(html).toContain(">Diskon<");
    expect(html).toContain("Rp 0");
  });

  it("renders the terbilang and total for the billed amount", () => {
    const html = render();
    expect(html).toContain("Dua juta dua ratus lima puluh ribu rupiah");
    expect(html).toContain("Rp 2.250.000");
    expect(html).toContain("Nilai pekerjaan");
    expect(html).toContain("Rp 4.500.000");
  });
});
