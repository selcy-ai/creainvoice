// src/modules/payments/status.ts
// Pure status math for payments (feature 07 spec step 3): no I/O, no Prisma,
// no scope — the unit test drives it straight from a table of inputs.
//
//   totalPaid == 0                  → the stored status as it was
//   0 < totalPaid < grandTotal      → PARTIALLY_PAID
//   totalPaid >= grandTotal         → PAID
//
// Only ISSUED / SENT / PARTIALLY_PAID / PAID may be recomputed; DRAFT,
// CANCELLED and REVISED are rejected (spec) — a payment can never resurrect
// or rewrite a document that is not an open bill.

import { AppError } from "@/lib/errors";
import Decimal from "decimal.js";
import type { InvoiceStatus } from "@/db/enums";

/**
 * Statuses a payment may be recorded against (spec: ISSUED/SENT/
 * PARTIALLY_PAID/PAID). Everything else answers LOCKED.
 *
 * Feature 11A adds OVERDUE: the maintenance sweep now persists it, and an
 * invoice that slips past its due date mid-repayment must still accept the
 * remaining installments — freezing it would make the app unable to settle
 * the exact invoices it exists to chase.
 */
export const PAYABLE_STATUSES: readonly InvoiceStatus[] = [
  "ISSUED",
  "SENT",
  "PARTIALLY_PAID",
  "PAID",
  "OVERDUE",
];

export function isPayable(status: InvoiceStatus): boolean {
  return PAYABLE_STATUSES.includes(status);
}

/** Throwing guard for the record-payment entry point (spec: DRAFT/CANCELLED/
 * REVISED are rejected with a clear Indonesian message). */
export function assertPayable(status: InvoiceStatus): void {
  if (isPayable(status)) return;
  if (status === "DRAFT") {
    throw new AppError(
      "LOCKED",
      "Invoice masih draft — terbitkan invoice dulu sebelum mencatat pembayaran.",
    );
  }
  if (status === "CANCELLED") {
    throw new AppError("LOCKED", "Invoice sudah dibatalkan — pembayaran tidak bisa dicatat.");
  }
  if (status === "REVISED") {
    throw new AppError(
      "LOCKED",
      "Invoice sudah digantikan revisi — pembayaran dicatat di invoice penggantinya.",
    );
  }
  throw new AppError("LOCKED", "Status invoice tidak mengizinkan pencatatan pembayaran.");
}

export interface PaymentStatusSubject {
  /** Stored status of the invoice. */
  status: InvoiceStatus;
  /** Decimal string of invoice.grandTotal — never a float. */
  grandTotal: string;
  /** Decimal string of the SUM of the invoice's payments AFTER this change. */
  amountPaid: string;
}

/**
 * recomputePaymentStatus — the one place that decides an invoice's payment
 * status (spec step 3; pure, unit-tested). `amountPaid` is expected to be the
 * recomputed sum of the payment rows, never a client-supplied total.
 *
 * Reversal to zero: ISSUED/SENT keep their stored state, while PARTIALLY_PAID
 * and PAID only ever existed because payments did — they collapse back to
 * ISSUED (the neutral open state; the riwayat keeps the audit trail).
 *
 * Feature 11A: OVERDUE is also recompute-eligible. The maintenance sweep
 * persists it, so an invoice can legitimately be OVERDUE when a payment
 * arrives; the recompute then moves it to PAID/PARTIALLY_PAID like any other
 * open bill. A reversal to zero on an OVERDUE row keeps it OVERDUE (it is
 * still past due) rather than collapsing to ISSUED.
 */
export function recomputePaymentStatus(invoice: PaymentStatusSubject): InvoiceStatus {
  assertPayable(invoice.status);

  const paid = new Decimal(invoice.amountPaid || "0");
  const total = new Decimal(invoice.grandTotal || "0");

  if (paid.lte(0)) {
    return invoice.status === "PARTIALLY_PAID" || invoice.status === "PAID"
      ? "ISSUED"
      : invoice.status;
  }
  if (paid.gte(total)) return "PAID";
  return "PARTIALLY_PAID";
}

/**
 * Invoice.remainingAfter after a payment change: how much of the grand total
 * is still open. Floored at 0 — an overpayment shows up as amountPaid above
 * grandTotal, never as a negative "sisa tagihan".
 */
export function remainingAfterPayment(grandTotal: string, amountPaid: string): string {
  const remaining = new Decimal(grandTotal || "0").minus(amountPaid || "0");
  return (remaining.isNegative() ? new Decimal(0) : remaining).toFixed(2);
}
