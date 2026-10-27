// src/modules/invoices/billed.test.ts
// Unit tests for the ONE rule behind previouslyBilled / billedToDate
// (architecture invariant 6), feature 05 Check When Done:
//   - "previouslyBilled excludes draft/cancelled/revised"
//   - "revision exclusion" — a REVISED invoice never counts (its replacement
//     does), so a revision can never double-bill the same work.

import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import {
  BILLED_STATUSES,
  countsTowardPreviouslyBilled,
  sumBilledForProject,
} from "@/modules/invoices/billed";
import type { InvoiceStatus } from "@/db/enums";

describe("BILLED_STATUSES", () => {
  it("is exactly the issued-and-later set (invariant 6)", () => {
    expect([...BILLED_STATUSES].sort()).toEqual(
      ["ISSUED", "OVERDUE", "PAID", "PARTIALLY_PAID", "SENT"].sort(),
    );
  });
});

describe("countsTowardPreviouslyBilled — per status", () => {
  const billed: InvoiceStatus[] = ["ISSUED", "SENT", "PARTIALLY_PAID", "PAID", "OVERDUE"];
  const notBilled: InvoiceStatus[] = ["DRAFT", "CANCELLED", "REVISED"];

  it("counts issued-and-later invoices", () => {
    for (const status of billed) {
      expect(countsTowardPreviouslyBilled(status), status).toBe(true);
    }
  });

  it("never counts draft, cancelled or revised invoices", () => {
    for (const status of notBilled) {
      expect(countsTowardPreviouslyBilled(status), status).toBe(false);
    }
  });
});

describe("previouslyBilled rules (Check When Done)", () => {
  /** Same predicate the DB where-clause is built from — one source of truth. */
  function billedSum(rows: Array<{ status: InvoiceStatus; grandTotal: string }>): string {
    return rows
      .filter((row) => countsTowardPreviouslyBilled(row.status))
      .reduce((sum, row) => sum.plus(row.grandTotal), new Decimal(0))
      .toFixed(2);
  }

  it("excludes DRAFT and CANCELLED — only issued invoices are billed", () => {
    const total = billedSum([
      { status: "DRAFT", grandTotal: "1000.00" },
      { status: "CANCELLED", grandTotal: "2000.00" },
      { status: "ISSUED", grandTotal: "3000.00" },
    ]);
    expect(total).toBe("3000.00");
  });

  it("excludes REVISED — the revision pair is counted exactly once", () => {
    // Original issued 4.500.000, then revised: original → REVISED, replacement
    // draft → later issued at 4.400.000. Only the replacement counts.
    const original = { status: "REVISED" as const, grandTotal: "4500000.00" };
    const replacement = { status: "ISSUED" as const, grandTotal: "4400000.00" };
    expect(billedSum([original, replacement])).toBe("4400000.00");
    // Before the replacement is issued, the revised original counts for
    // nothing — the work is temporarily "not billed", never double-billed.
    expect(billedSum([original])).toBe("0.00");
  });

  it("sums decimal strings exactly (no float drift)", () => {
    const total = billedSum([
      { status: "ISSUED", grandTotal: "3333333.33" },
      { status: "PARTIALLY_PAID", grandTotal: "3333333.33" },
      { status: "OVERDUE", grandTotal: "3333333.34" },
    ]);
    // 3.333.333,33 + 3.333.333,33 + 3.333.333,34 = 10.000.000,00 exactly —
    // a float reduction of the same numbers drifts below it.
    expect(total).toBe("10000000.00");
  });
});

describe("sumBilledForProject", () => {
  it("answers 0.00 without touching the database when there is no project", async () => {
    const noClient = {} as Parameters<typeof sumBilledForProject>[0];
    await expect(
      sumBilledForProject(noClient, {
        organizationId: "org_x",
        projectReferenceId: null,
      }),
    ).resolves.toBe("0.00");
  });
});
