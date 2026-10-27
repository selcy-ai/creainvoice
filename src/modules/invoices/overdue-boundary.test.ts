// src/modules/invoices/overdue-boundary.test.ts
// Pure unit tests for the on-read overdue boundary (feature 05).
//
// `isPastDue` compares a stored calendar day with "today in Jakarta", and
// `isOverdue`/`recomputeOverdue` layer the status gate on top. All three take
// an injectable `now` so the date logic is testable without freezing the clock
// or touching the database — this file has no db import and no beforeAll.
//
// Coverage gap: invoice-lifecycle.test.ts asserts the *displayed* badge
// through `getInvoiceDetail` (one case, one date, tied to the live clock);
// here every boundary is named.
//
// Note on dates: Jakarta is UTC+7, so a Jakarta wall-clock of H is stored as
// UTC H-7. Every case below states both to remove the ambiguity.

import { describe, expect, it } from "vitest";
import type { InvoiceStatus } from "@/db/enums";
import { isOverdue, isPastDue, recomputeOverdue } from "@/modules/invoices/lifecycle-service";

// Stored calendar days are UTC midnight of the business day.
function utcDay(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

// Exact Jakarta wall-clock time (Jakarta = UTC+7).
function jkt(day: string, hour: number): Date {
  const utcHour = hour - 7;
  if (utcHour >= 0) {
    return new Date(`${day}T${String(utcHour).padStart(2, "0")}:00:00.000Z`);
  }
  // Before 07:00 Jakarta rolls back into the previous UTC day.
  const prev = new Date(`${day}T00:00:00.000Z`);
  prev.setUTCHours(utcHour);
  return prev;
}

describe("isPastDue (strict calendar comparison)", () => {
  it("a due date equal to today in Jakarta is NOT overdue", () => {
    // Jakarta 2026-07-15 15:00 == UTC 2026-07-15 08:00.
    expect(isPastDue(utcDay("2026-07-15"), jkt("2026-07-15", 15))).toBe(false);
  });

  it("a due date one day after today in Jakarta is NOT overdue", () => {
    expect(isPastDue(utcDay("2026-07-16"), jkt("2026-07-15", 15))).toBe(false);
  });

  it("a due date one day before today in Jakarta IS overdue", () => {
    expect(isPastDue(utcDay("2026-07-14"), jkt("2026-07-15", 15))).toBe(true);
  });

  it("the comparison is strict: the same Jakarta day never crosses the boundary", () => {
    // Jakarta 2026-07-15 06:00 == UTC 2026-07-14 23:00 — still yesterday.
    expect(isPastDue(utcDay("2026-07-15"), jkt("2026-07-15", 6))).toBe(false);
    // Jakarta 2026-07-15 23:00 == UTC 2026-07-15 16:00 — still the due day.
    expect(isPastDue(utcDay("2026-07-15"), jkt("2026-07-15", 23))).toBe(false);
  });

  it("boundary: the last Jakarta instant of the due day is not overdue; the first instant of the next day is", () => {
    const due = utcDay("2026-07-15");
    // Jakarta 2026-07-15 23:59 == UTC 2026-07-15 16:59 — still the due day.
    expect(isPastDue(due, new Date("2026-07-15T16:59:00.000Z"))).toBe(false);
    // Jakarta 2026-07-16 00:00 == UTC 2026-07-15 17:00 — next day.
    expect(isPastDue(due, new Date("2026-07-15T17:00:00.000Z"))).toBe(true);
  });

  it("an absent due date is never overdue", () => {
    const now = jkt("2026-07-15", 15);
    expect(isPastDue(null, now)).toBe(false);
    // The dueDate column is null when absent, but a plain `undefined` from
    // an unmapped row must also read as "no due date".
    expect(isPastDue(undefined as unknown as Date | null, now)).toBe(false);
  });

  it("defaults to the real current time when `now` is omitted", () => {
    // Today in Jakarta is 2026-10-08 at the time of this run.
    expect(isPastDue(utcDay("2000-01-01"))).toBe(true);
    expect(isPastDue(utcDay("2100-01-01"))).toBe(false);
    expect(isPastDue(utcDay(todayInJakarta()))).toBe(false);
  });
});

describe("isOverdue (status gate + due date)", () => {
  const now = jkt("2026-07-15", 15);
  const past = utcDay("2026-07-14");
  const future = utcDay("2026-07-16");

  // The three statuses that can still become overdue.
  it.each<{ status: InvoiceStatus }>([
    { status: "ISSUED" },
    { status: "SENT" },
    { status: "PARTIALLY_PAID" },
  ])("$status is overdue when past due, not when future due", ({ status }) => {
    expect(isOverdue({ status, dueDate: past }, now)).toBe(true);
    expect(isOverdue({ status, dueDate: future }, now)).toBe(false);
  });

  // Settled, cancelled, superseded and unpublished invoices never display as
  // overdue, regardless of the date.
  it.each<InvoiceStatus>(["DRAFT", "PAID", "OVERDUE", "CANCELLED", "REVISED"])(
    "%s is never overdue, even with a past due date",
    (status) => {
      expect(isOverdue({ status, dueDate: past }, now)).toBe(false);
      expect(isOverdue({ status, dueDate: null }, now)).toBe(false);
    },
  );

  it("an eligible status without a due date is not overdue", () => {
    expect(isOverdue({ status: "ISSUED", dueDate: null }, now)).toBe(false);
  });

  it("defaults `now` to the real current time", () => {
    expect(isOverdue({ status: "ISSUED", dueDate: past })).toBe(true);
    expect(isOverdue({ status: "ISSUED", dueDate: utcDay("2100-01-01") })).toBe(false);
  });
});

describe("recomputeOverdue (the displayed status)", () => {
  const now = jkt("2026-07-15", 15);
  const past = utcDay("2026-07-14");
  const future = utcDay("2026-07-16");

  // On-read only: the stored status must not be rewritten here.
  it("returns OVERDUE for an eligible invoice past its due date", () => {
    expect(recomputeOverdue({ status: "ISSUED", dueDate: past }, now)).toBe("OVERDUE");
    expect(recomputeOverdue({ status: "SENT", dueDate: past }, now)).toBe("OVERDUE");
    expect(recomputeOverdue({ status: "PARTIALLY_PAID", dueDate: past }, now)).toBe("OVERDUE");
  });

  it("returns the stored status when the invoice is not overdue", () => {
    expect(recomputeOverdue({ status: "ISSUED", dueDate: future }, now)).toBe("ISSUED");
    expect(recomputeOverdue({ status: "SENT", dueDate: future }, now)).toBe("SENT");
    expect(recomputeOverdue({ status: "PARTIALLY_PAID", dueDate: future }, now)).toBe("PARTIALLY_PAID");
  });

  it("never invents OVERDUE for a settled/cancelled/superseded invoice", () => {
    for (const status of ["DRAFT", "PAID", "CANCELLED", "REVISED", "OVERDUE"] as const) {
      expect(recomputeOverdue({ status, dueDate: past }, now)).toBe(status);
    }
  });

  it("defaults `now` to the real current time", () => {
    expect(recomputeOverdue({ status: "ISSUED", dueDate: past })).toBe("OVERDUE");
    expect(recomputeOverdue({ status: "ISSUED", dueDate: utcDay("2100-01-01") })).toBe("ISSUED");
  });
});

/** "YYYY-MM-DD" of today in the business timezone, for the default-`now` cases. */
function todayInJakarta(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}