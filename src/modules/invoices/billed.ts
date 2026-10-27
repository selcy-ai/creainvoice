// src/modules/invoices/billed.ts
// The one rule for "does this invoice count as billed?" (architecture
// invariant 6): ONLY issued-and-later invoices count — a DRAFT is not a bill,
// a CANCELLED invoice is not an active bill, and a REVISED invoice is
// superseded by its replacement (counting both would double-bill the work).
//
// Pure status rule + one DB sum helper, shared by:
//   • invoices/service.ts          (draft settlement context)
//   • invoices/issue-service.ts    (previouslyBilled at issue)
//   • invoices/lifecycle-service.ts (recompute after cancel/revise)
//   • projects/service.ts          (billedToDate on the project detail page)

import Decimal from "decimal.js";
import { invoices } from "@/db/schema";
import type { InvoiceStatus } from "@/db/enums";
import { and, eq, inArray, isNotNull, ne, sum } from "drizzle-orm";
import type { Database } from "@/server/db";

/** Statuses that count toward previouslyBilled (invariant 6). */
export const BILLED_STATUSES: readonly InvoiceStatus[] = [
  "ISSUED",
  "SENT",
  "PARTIALLY_PAID",
  "PAID",
  "OVERDUE",
];

/** DRAFT / CANCELLED / REVISED never count (invariant 6). */
export function countsTowardPreviouslyBilled(status: InvoiceStatus): boolean {
  return BILLED_STATUSES.includes(status);
}

export interface BilledSumScope {
  organizationId: string;
  /** No project link → nothing verifiable to bill against → "0.00". */
  projectReferenceId: string | null;
  /** Exclude one invoice (its own row while editing/issuing it). */
  excludeInvoiceId?: string;
}

type DbClient = Pick<Database, "select">;

/**
 * Σ grandTotal of the invoices of one project that count as billed. Decimal
 * string out ("4500000.00") — a float never crosses the boundary.
 */
export async function sumBilledForProject(
  client: DbClient,
  scope: BilledSumScope,
): Promise<string> {
  if (!scope.projectReferenceId) return "0.00";
  const rows = await client
    .select({ total: sum(invoices.grandTotal) })
    .from(invoices)
    .where(
      and(
        eq(invoices.organizationId, scope.organizationId),
        eq(invoices.projectReferenceId, scope.projectReferenceId),
        inArray(invoices.status, [...BILLED_STATUSES]),
        scope.excludeInvoiceId
          ? ne(invoices.id, scope.excludeInvoiceId)
          : isNotNull(invoices.id),
      ),
    );
  const value = rows[0]?.total ?? "0";
  return new Decimal(String(value)).toFixed(2);
}
