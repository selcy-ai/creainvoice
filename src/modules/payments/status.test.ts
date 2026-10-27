// Unit tests: recomputePaymentStatus — the pure status function feature 07
// builds on (spec: 0 / partial / full / overpayment / draft reject /
// cancelled reject), plus the remainingAfter floor.

import { describe, expect, it } from "vitest";
import { isAppError, type AppError } from "@/lib/errors";
import {
  PAYABLE_STATUSES,
  assertPayable,
  isPayable,
  recomputePaymentStatus,
  remainingAfterPayment,
} from "@/modules/payments/status";
import type { InvoiceStatus } from "@/db/enums";

function expectLocked(run: () => unknown): AppError {
  let caught: unknown = null;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(isAppError(caught)).toBe(true);
  const appError = caught as AppError;
  expect(appError.code).toBe("LOCKED");
  return appError;
}

describe("PAYABLE_STATUSES", () => {
  it("is the issued family plus OVERDUE (11A sweep persists OVERDUE; a late invoice stays payable)", () => {
    expect([...PAYABLE_STATUSES]).toEqual(["ISSUED", "SENT", "PARTIALLY_PAID", "PAID", "OVERDUE"]);
    expect(isPayable("DRAFT")).toBe(false);
    expect(isPayable("CANCELLED")).toBe(false);
    expect(isPayable("REVISED")).toBe(false);
    expect(isPayable("OVERDUE")).toBe(true);
  });
});

describe("recomputePaymentStatus", () => {
  it("keeps the stored status when nothing is paid (0)", () => {
    expect(
      recomputePaymentStatus({ status: "ISSUED", grandTotal: "2250000.00", amountPaid: "0" }),
    ).toBe("ISSUED");
    expect(
      recomputePaymentStatus({ status: "SENT", grandTotal: "2250000.00", amountPaid: "0.00" }),
    ).toBe("SENT");
  });

  it("collapses a payment-derived status back to ISSUED at zero (full reversal)", () => {
    expect(
      recomputePaymentStatus({
        status: "PARTIALLY_PAID",
        grandTotal: "2250000.00",
        amountPaid: "0.00",
      }),
    ).toBe("ISSUED");
    expect(
      recomputePaymentStatus({ status: "PAID", grandTotal: "2250000.00", amountPaid: "0" }),
    ).toBe("ISSUED");
  });

  it("returns PARTIALLY_PAID for 0 < paid < grandTotal", () => {
    expect(
      recomputePaymentStatus({
        status: "ISSUED",
        grandTotal: "2250000.00",
        amountPaid: "1000000.00",
      }),
    ).toBe("PARTIALLY_PAID");
    // From SENT as well — the payment dimension wins over the delivery state.
    expect(
      recomputePaymentStatus({
        status: "SENT",
        grandTotal: "2250000.00",
        amountPaid: "1000000",
      }),
    ).toBe("PARTIALLY_PAID");
    // A cent below the total is still partial.
    expect(
      recomputePaymentStatus({
        status: "PARTIALLY_PAID",
        grandTotal: "2250000.00",
        amountPaid: "2249999.99",
      }),
    ).toBe("PARTIALLY_PAID");
  });

  it("returns PAID at exactly grandTotal", () => {
    expect(
      recomputePaymentStatus({
        status: "PARTIALLY_PAID",
        grandTotal: "2250000.00",
        amountPaid: "2250000.00",
      }),
    ).toBe("PAID");
    // Prisma's Decimal.toString() trims trailing zeros — both spellings count.
    expect(
      recomputePaymentStatus({
        status: "ISSUED",
        grandTotal: "2250000",
        amountPaid: "2250000",
      }),
    ).toBe("PAID");
  });

  it("returns PAID for an overpayment (paid > grandTotal)", () => {
    expect(
      recomputePaymentStatus({
        status: "ISSUED",
        grandTotal: "2250000.00",
        amountPaid: "3000000.00",
      }),
    ).toBe("PAID");
    expect(
      recomputePaymentStatus({
        status: "PARTIALLY_PAID",
        grandTotal: "2250000.00",
        amountPaid: "2250000.01",
      }),
    ).toBe("PAID");
  });

  it("rejects a DRAFT invoice (LOCKED)", () => {
    const error = expectLocked(() =>
      recomputePaymentStatus({ status: "DRAFT", grandTotal: "2250000.00", amountPaid: "1000" }),
    );
    expect(error.message).toMatch(/draft/i);
  });

  it("rejects a CANCELLED invoice (LOCKED)", () => {
    const error = expectLocked(() =>
      recomputePaymentStatus({
        status: "CANCELLED",
        grandTotal: "2250000.00",
        amountPaid: "1000",
      }),
    );
    expect(error.message).toMatch(/dibatalkan/i);
  });

  it("rejects REVISED invoices (LOCKED) but recomputes an OVERDUE invoice (11A)", () => {
    expectLocked(() =>
      recomputePaymentStatus({ status: "REVISED", grandTotal: "1", amountPaid: "1" }),
    );
    // The sweep persists OVERDUE; a payment on a late invoice must still move
    // it to PAID, and a full reversal keeps it OVERDUE (still past due).
    expect(
      recomputePaymentStatus({ status: "OVERDUE", grandTotal: "1", amountPaid: "1" }),
    ).toBe("PAID");
    expect(
      recomputePaymentStatus({ status: "OVERDUE", grandTotal: "1", amountPaid: "0.5" }),
    ).toBe("PARTIALLY_PAID");
    expect(
      recomputePaymentStatus({ status: "OVERDUE", grandTotal: "1", amountPaid: "0" }),
    ).toBe("OVERDUE");
  });

  it("assertPayable agrees with isPayable for every status", () => {
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
      if (isPayable(status)) {
        expect(() => assertPayable(status)).not.toThrow();
      } else {
        expectLocked(() => assertPayable(status));
      }
    }
  });
});

describe("remainingAfterPayment", () => {
  it("is grandTotal − amountPaid with 2 decimals", () => {
    expect(remainingAfterPayment("2250000.00", "1000000.00")).toBe("1250000.00");
    expect(remainingAfterPayment("2250000", "2250000")).toBe("0.00");
  });

  it("never goes negative — an overpayment shows in amountPaid instead", () => {
    expect(remainingAfterPayment("2250000.00", "3000000.00")).toBe("0.00");
  });
});
