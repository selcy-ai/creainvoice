// src/modules/dashboard/service.ts
// Feature 08 — dashboard reads: summary cards, the 12-month tagihan-vs-bayar
// series, and the recent-activity timeline. Everything is org-scoped and gated
// by `invoice.view` (every role has it — the dashboard is the app's home);
// per-metric cards never recompute money client-side (invariant 1/2: sums come
// from the database as decimal strings).
//
// Note on "overdue" in the timeline: OVERDUE is a READ-TIME status (feature
// 05) and writes no audit row — it is surfaced as a card count instead of a
// fabricated timeline entry.

import { todayInJakarta } from "@/lib/date";
import { roundMoney } from "@/lib/money";
import Decimal from "decimal.js";
import { assertCan, can, requireOrgScope } from "@/modules/workspace/permissions";
import { BILLED_STATUSES } from "@/modules/invoices/billed";
import { OVERDUE_ELIGIBLE_STATUSES } from "@/modules/invoices/lifecycle-service";
import {
  buildMonthlySeries,
  monthKeysBack,
  seriesIsEmpty,
  type MonthlySeriesPoint,
} from "@/modules/dashboard/series";
import { db } from "@/server/db";
import { auditLogs, customers, invoices, payments, users } from "@/db/schema";
import type { AuditAction } from "@/db/enums";
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, sql, sum } from "drizzle-orm";
import type { PermissionContext } from "@/modules/workspace/permissions";

export type DashboardContext = { scope: PermissionContext };

/** Chart window (spec: 12 bulan terakhir). */
export const DASHBOARD_MONTHS = 12;
/** Recent activity depth (spec: 5 event terbaru). */
export const DASHBOARD_ACTIVITY_LIMIT = 5;

// ─── Cards ────────────────────────────────────────────────────────────────

export interface DashboardCards {
  /** Invoice (any status) dated in the current calendar month. */
  invoicesThisMonth: number;
  /** Σ grandTotal of billed (issued-and-later) invoices. */
  totalBilled: string;
  /** Σ amountPaid of billed invoices. */
  totalPaid: string;
  /** Σ remainingAfter (floored at 0) of billed invoices. */
  outstanding: string;
  /** Read-time overdue count (eligible status, due date before today). */
  overdueCount: number;
  draftCount: number;
  /** Active (non soft-deleted) customers. */
  customerCount: number;
}

/**
 * One round of aggregate queries for the dashboard cards. Sums come straight
 * from Prisma `_sum` (Decimal) — never from numbers the browser touched.
 */
export async function getDashboardCards(ctx: DashboardContext): Promise<DashboardCards> {
  assertCan("invoice.view", ctx.scope);
  requireOrgScope(ctx.scope);
  const organizationId = ctx.scope.organizationId;

  const now = new Date();
  const [year = now.getUTCFullYear(), month = 1] = todayInJakarta(now)
    .split("-")
    .map(Number);
  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  const monthEnd = new Date(Date.UTC(year, month, 1));
  const startOfToday = new Date(`${todayInJakarta(now)}T00:00:00.000Z`);

  const billedWhere = and(
    eq(invoices.organizationId, organizationId),
    inArray(invoices.status, [...BILLED_STATUSES]),
  );
  const overdueWhere = and(
    eq(invoices.organizationId, organizationId),
    inArray(invoices.status, [...OVERDUE_ELIGIBLE_STATUSES, "OVERDUE"]),
    isNotNull(invoices.dueDate),
    lt(invoices.dueDate, startOfToday),
  );

  const [
    monthRows,
    billedRows,
    overdueRows,
    draftRows,
    customerRows,
  ] = await Promise.all([
    db
      .select({ value: sql<number>`count(*)::int` })
      .from(invoices)
      .where(
        and(
          eq(invoices.organizationId, organizationId),
          gte(invoices.invoiceDate, monthStart),
          lt(invoices.invoiceDate, monthEnd),
        ),
      ),
    db
      .select({
        grandTotal: sum(invoices.grandTotal),
        amountPaid: sum(invoices.amountPaid),
        remainingAfter: sum(invoices.remainingAfter),
      })
      .from(invoices)
      .where(billedWhere),
    db
      .select({ value: sql<number>`count(*)::int` })
      .from(invoices)
      .where(overdueWhere),
    db
      .select({ value: sql<number>`count(*)::int` })
      .from(invoices)
      .where(and(eq(invoices.organizationId, organizationId), eq(invoices.status, "DRAFT"))),
    db
      .select({ value: sql<number>`count(*)::int` })
      .from(customers)
      .where(and(eq(customers.organizationId, organizationId), isNotNull(customers.deletedAt))),
  ]);

  const money = (value: string | null): string =>
    value ? roundMoney(new Decimal(value).toFixed(2)) : "0.00";

  const billedSums = billedRows[0];
  return {
    invoicesThisMonth: Number(monthRows[0]?.value ?? 0),
    totalBilled: money(billedSums?.grandTotal ?? null),
    totalPaid: money(billedSums?.amountPaid ?? null),
    outstanding: money(billedSums?.remainingAfter ?? null),
    overdueCount: Number(overdueRows[0]?.value ?? 0),
    draftCount: Number(draftRows[0]?.value ?? 0),
    customerCount: Number(customerRows[0]?.value ?? 0),
  };
}

// ─── Chart: tagihan vs pembayaran per bulan ───────────────────────────────

export interface DashboardSeries {
  points: MonthlySeriesPoint[];
  /** True when nothing happened in the window — render the empty state. */
  empty: boolean;
}

export async function getMonthlySeries(
  ctx: DashboardContext,
  months: number = DASHBOARD_MONTHS,
): Promise<DashboardSeries> {
  assertCan("invoice.view", ctx.scope);
  requireOrgScope(ctx.scope);
  const organizationId = ctx.scope.organizationId;

  const keys = monthKeysBack(new Date(), months);
  const windowStart = new Date(`${keys[0]}-01T00:00:00.000Z`);

  const [invoiceRows, paymentRows] = await Promise.all([
    db
      .select({ invoiceDate: invoices.invoiceDate, grandTotal: invoices.grandTotal })
      .from(invoices)
      .where(
        and(
          eq(invoices.organizationId, organizationId),
          gte(invoices.invoiceDate, windowStart),
          inArray(invoices.status, [...BILLED_STATUSES]),
        ),
      ),
    db
      .select({ paymentDate: payments.paymentDate, amount: payments.amount })
      .from(payments)
      .where(
        and(
          eq(payments.organizationId, organizationId),
          gte(payments.paymentDate, windowStart),
        ),
      ),
  ]);

  const points = buildMonthlySeries({
    months: keys,
    invoices: invoiceRows.map((row) => ({
      date: row.invoiceDate,
      grandTotal: row.grandTotal,
    })),
    payments: paymentRows.map((row) => ({
      date: row.paymentDate,
      amount: row.amount,
    })),
  });

  return { points, empty: seriesIsEmpty(points) };
}

// ─── Recent activity timeline ─────────────────────────────────────────────

/** Timeline copy per audit action. Actions absent here (INVOICE_UPDATED —
 * autosave noise; PDF_* — technical) are deliberately not surfaced. */
export const ACTIVITY_LABELS: Partial<Record<AuditAction, string>> = {
  INVOICE_DRAFT_CREATED: "Invoice baru dibuat",
  INVOICE_ISSUED: "Invoice diterbitkan",
  INVOICE_SENT: "Invoice ditandai terkirim",
  INVOICE_CANCELLED: "Invoice dibatalkan",
  INVOICE_REVISED: "Invoice direvisi",
  PAYMENT_RECORDED: "Pembayaran dicatat",
};

export const DASHBOARD_ACTIVITY_ACTIONS = Object.keys(
  ACTIVITY_LABELS,
) as AuditAction[];

export interface DashboardActivity {
  id: string;
  action: AuditAction;
  label: string;
  entityType: string;
  /** Actor display name, or "Sistem" when the row has no user. */
  actorName: string;
  createdAt: string;
}

/**
 * The newest `limit` invoice/payment events of the org (spec: timeline
 * invoice baru / issued / pembayaran / revisi). Reads AuditLog directly —
 * writes already go through `modules/audit` (feature 01 invariant).
 */
export async function getRecentActivity(
  ctx: DashboardContext,
  limit: number = DASHBOARD_ACTIVITY_LIMIT,
): Promise<DashboardActivity[]> {
  assertCan("invoice.view", ctx.scope);
  requireOrgScope(ctx.scope);

  const take = Math.min(Math.max(limit, 1), DASHBOARD_ACTIVITY_LIMIT);
  const rows = await db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      entityType: auditLogs.entityType,
      metadata: auditLogs.metadata,
      createdAt: auditLogs.createdAt,
      actorName: users.name,
      actorUsername: users.username,
    })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.actorUserId))
    .where(
      and(
        eq(auditLogs.organizationId, ctx.scope.organizationId),
        inArray(auditLogs.action, DASHBOARD_ACTIVITY_ACTIONS),
      ),
    )
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(take);

  return rows.map((row) => {
    const base = ACTIVITY_LABELS[row.action] ?? row.action;
    const isReversal =
      row.action === "PAYMENT_RECORDED" &&
      typeof row.metadata === "object" &&
      row.metadata !== null &&
      (row.metadata as Record<string, unknown>).reversed === true;
    return {
      id: row.id,
      action: row.action,
      label: isReversal ? "Pembayaran dibatalkan (reversal)" : base,
      entityType: row.entityType,
      actorName: row.actorName || row.actorUsername || "Sistem",
      createdAt: row.createdAt.toISOString(),
    };
  });
}
