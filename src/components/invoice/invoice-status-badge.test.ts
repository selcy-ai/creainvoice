// Unit tests: the invoice status badge contract the feature-07 Check When
// Done leans on ("Status PAID/PARTIALLY_PAID ... tampil benar (badge)") —
// ui-context demands text + colour + icon, never colour alone, so both
// payment statuses must carry a label and a distinct style.

import { describe, expect, it } from "vitest";
import { INVOICE_STATUS_LABELS, InvoiceStatusBadge } from "@/components/invoice/invoice-status-badge";
import type { InvoiceStatus } from "@/db/enums";

describe("INVOICE_STATUS_LABELS", () => {
  it("labels every status in Indonesian, including the payment statuses", () => {
    expect(INVOICE_STATUS_LABELS.PARTIALLY_PAID).toBe("Dibayar sebagian");
    expect(INVOICE_STATUS_LABELS.PAID).toBe("Lunas");
    const statuses: InvoiceStatus[] = [
      "DRAFT",
      "ISSUED",
      "SENT",
      "PARTIALLY_PAID",
      "PAID",
      "OVERDUE",
      "CANCELLED",
      "REVISED",
    ];
    for (const status of statuses) {
      expect(INVOICE_STATUS_LABELS[status], status).toBeTruthy();
    }
  });
});

describe("InvoiceStatusBadge", () => {
  it("renders text + an inline icon for the payment statuses (never colour alone)", () => {
    for (const status of ["PARTIALLY_PAID", "PAID"] as const) {
      const element = InvoiceStatusBadge({ status });
      const json = JSON.stringify(element);
      expect(json).toContain(INVOICE_STATUS_LABELS[status]);
      expect(json).toContain("data-icon");
    }
  });
});
