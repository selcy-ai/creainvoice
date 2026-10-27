// tests/integration/dashboard.test.ts
// Feature 08 dashboard reads (Check When Done):
//   - cards menampilkan angka benar untuk ORG SESSION: total ditagihkan /
//     dibayar / outstanding dihitung dari invoice terbit saja (draft dan
//     dibatalkan tidak ikut), overdue & draft dihitung apa adanya, jumlah
//     customer hanya organisasi ini
//   - grafik 12 bulan: bucket sesuai kalender bisnis, empty state bila nihil
//   - recent activity: maksimum 5 event terbaru milik organisasi ini
//   - org isolation + fail closed tanpa role

import { beforeAll, describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import { isAppError, type AppError } from "@/lib/errors";
import { todayInJakarta } from "@/lib/date";
import { createCustomer, type CustomerFormInput } from "@/modules/customers/service";
import { createProfile } from "@/modules/profiles/service";
import { createDraft } from "@/modules/invoices/service";
import { issueInvoice } from "@/modules/invoices/issue-service";
import { cancelInvoice } from "@/modules/invoices/lifecycle-service";
import { recordPayment } from "@/modules/payments/service";
import type { InvoiceDraftFormOutput } from "@/modules/invoices/schema";
import {
  DASHBOARD_ACTIVITY_LIMIT,
  getDashboardCards,
  getMonthlySeries,
  getRecentActivity,
} from "@/modules/dashboard/service";
import { monthKeyOf } from "@/modules/dashboard/series";
import { db } from "@/tests/helpers/test-db";
import {
  addMembership,
  createOrganization,
  createUser,
  resetDatabase,
  type TestUser,
} from "../factories";
import { ctxFor } from "@/tests/helpers/context";

let owner: TestUser;
let viewer: TestUser;
let org: { id: string };
let otherOrg: { id: string };
let emptyOrg: { id: string };
let profileId: string;
let customerId: string;

const ids = {} as Record<
  "draft1" | "draft2" | "issued1" | "overdue1" | "partial1" | "paid1" | "cancelled1",
  string
>;
/** invoiceDate (YYYY-MM-DD) per fixture invoice — the test's own expectations. */
const invoiceDates = {} as Record<keyof typeof ids, string>;
/** paymentDate per payment recorded in the fixture. */
const paymentDates: string[] = [];

function shift(days: number): string {
  const [year = 2026, month = 1, day = 1] = todayInJakarta().split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}
const daysAgo = (days: number): string => shift(-days);
const daysFromNow = (days: number): string => shift(days);

const ownerCtx = (organizationId?: string) =>
  ctxFor(organizationId ?? org.id, owner.id);
const viewerCtx = () => ctxFor(org.id, viewer.id);

function customerInput(name: string): CustomerFormInput {
  return {
    companyName: name,
    legalName: name,
    businessType: "Dagang",
    isActive: true,
  } as CustomerFormInput;
}

async function sumColumn(keys: Array<keyof typeof ids>, column: "grandTotal" | "amountPaid" | "remainingAfter"): Promise<string> {
  const rows = await db.invoice.findMany({ where: { id: { in: keys.map((key) => ids[key]) } } });
  return rows
    .reduce((sum, row) => sum.plus(row[column].toString()), new Decimal(0))
    .toFixed(2);
}

async function make(
  key: keyof typeof ids,
  options: { issue?: boolean; cancel?: boolean; invoiceDate: string; dueDate?: string; unitPrice?: string; customerId?: string; fullPayment?: boolean; halfPayment?: boolean } = { invoiceDate: daysAgo(1) },
): Promise<void> {
  const draft = await createDraft(
    {
      profileId,
      invoiceType: "FULL",
      customerId: options.customerId ?? customerId,
      billingMode: "PERCENT",
      billingPercent: "100",
      invoiceDate: options.invoiceDate,
      dueDate: options.dueDate ?? daysFromNow(30),
      items: [
        {
          description: "Pekerjaan uji",
          quantity: "1",
          unit: "Paket",
          unitPrice: options.unitPrice ?? "1000000",
        },
      ],
    } as InvoiceDraftFormOutput,
    ownerCtx(),
  );
  ids[key] = draft.id;
  invoiceDates[key] = options.invoiceDate;

  if (options.issue === false) return;
  await issueInvoice(draft.id, ownerCtx());
  if (options.cancel) {
    await cancelInvoice(draft.id, "PO dibatalkan customer.", ownerCtx());
    return;
  }

  const row = await db.invoice.findUnique({ where: { id: draft.id } });
  const total = row!.grandTotal.toString();
  if (options.fullPayment || options.halfPayment) {
    const amount = options.fullPayment
      ? total
      : new Decimal(total).div(2).toFixed(2);
    const paymentDate = daysAgo(2);
    await recordPayment(
      draft.id,
      { paymentDate, amount, method: "BANK_TRANSFER", referenceNumber: "TRF-DASH" },
      ownerCtx(),
    );
    paymentDates.push(paymentDate);
  }
}

const billedKeys: Array<keyof typeof ids> = ["issued1", "overdue1", "partial1", "paid1"];

beforeAll(async () => {
  await resetDatabase();
  owner = await createUser({ username: "dash.owner" });
  viewer = await createUser({ username: "dash.viewer" });
  org = await createOrganization("CreaInvoice Studio");
  otherOrg = await createOrganization("Organisasi Lain");
  emptyOrg = await createOrganization("Organisasi Kosong");
  await addMembership(owner.id, org.id, "OWNER");
  await addMembership(viewer.id, org.id, "VIEWER");
  await addMembership(owner.id, otherOrg.id, "OWNER");
  await addMembership(owner.id, emptyOrg.id, "OWNER");

  profileId = (await createProfile(ownerCtx(), { name: "CreaInvoice Studio", code: "SB" })).id;
  customerId = (await createCustomer(customerInput("PT Cipta Dashboard"), ownerCtx())).id;

  await make("draft1", { issue: false, invoiceDate: daysAgo(4) });
  await make("draft2", { issue: false, invoiceDate: daysAgo(5), unitPrice: "2500000" });
  await make("issued1", { invoiceDate: daysAgo(6), unitPrice: "4000000" });
  await make("overdue1", {
    invoiceDate: daysAgo(40),
    dueDate: daysAgo(10),
    unitPrice: "3000000",
  });
  await make("partial1", { invoiceDate: daysAgo(3), unitPrice: "2000000", halfPayment: true });
  await make("paid1", { invoiceDate: daysAgo(2), unitPrice: "1500000", fullPayment: true });
  await make("cancelled1", {
    invoiceDate: daysAgo(30),
    unitPrice: "9000000",
    cancel: true,
  });

  // Foreign organization: one issued invoice (isolated from every card).
  const foreignProfile = await createProfile(ownerCtx(otherOrg.id), {
    name: "Lain Lain",
    code: "LL",
  });
  const foreignCustomer = await createCustomer(
    customerInput("PT Luar Negeri"),
    ownerCtx(otherOrg.id),
  );
  const draft = await createDraft(
    {
      profileId: foreignProfile.id,
      invoiceType: "FULL",
      customerId: foreignCustomer.id,
      billingMode: "PERCENT",
      billingPercent: "100",
      invoiceDate: daysAgo(1),
      dueDate: daysFromNow(30),
      items: [{ description: "Luar", quantity: "1", unit: "Paket", unitPrice: "777777" }],
    } as InvoiceDraftFormOutput,
    ownerCtx(otherOrg.id),
  );
  await issueInvoice(draft.id, ownerCtx(otherOrg.id));
}, 180_000);

// ─── Cards ────────────────────────────────────────────────────────────────

describe("dashboard cards (Check When Done)", () => {
  it("sums billed invoices only — draft and cancelled never count", async () => {
    const cards = await getDashboardCards(ownerCtx());

    expect(cards.totalBilled).toBe(await sumColumn(billedKeys, "grandTotal"));
    expect(cards.totalPaid).toBe(await sumColumn(billedKeys, "amountPaid"));
    expect(cards.outstanding).toBe(await sumColumn(billedKeys, "remainingAfter"));

    // Sanity: the excluded rows really are excluded.
    const everything = await sumColumn(Object.keys(ids) as Array<keyof typeof ids>, "grandTotal");
    expect(new Decimal(cards.totalBilled).lt(new Decimal(everything))).toBe(true);

    expect(cards.draftCount).toBe(2);
    expect(cards.overdueCount).toBe(1);
    expect(cards.customerCount).toBe(1);

    const currentKey = monthKeyOf(new Date());
    const expectedThisMonth = Object.values(invoiceDates).filter(
      (date) => monthKeyOf(`${date}T00:00:00.000Z`) === currentKey,
    ).length;
    expect(cards.invoicesThisMonth).toBe(expectedThisMonth);
  });

  it("is readable by VIEWER and fails closed without a role", async () => {
    const cards = await getDashboardCards(viewerCtx());
    expect(cards.draftCount).toBe(2);

    let caught: unknown = null;
    try {
      await getDashboardCards({
        scope: { organizationId: org.id },
      });
    } catch (error) {
      caught = error;
    }
    expect(isAppError(caught)).toBe(true);
    expect((caught as AppError).code).toBe("FORBIDDEN");
  });

  it("never leaks another organization's numbers", async () => {
    const cards = await getDashboardCards(ownerCtx(otherOrg.id));
    expect(cards.draftCount).toBe(0);
    expect(cards.overdueCount).toBe(0);
    expect(cards.customerCount).toBe(1);
    expect(cards.totalBilled).toBe("777777.00");

    const empty = await getDashboardCards(ownerCtx(emptyOrg.id));
    expect(empty).toMatchObject({
      totalBilled: "0.00",
      totalPaid: "0.00",
      outstanding: "0.00",
      overdueCount: 0,
      draftCount: 0,
      customerCount: 0,
      invoicesThisMonth: 0,
    });
  });
});

// ─── Chart ────────────────────────────────────────────────────────────────

describe("chart data (Check When Done)", () => {
  it("returns 12 monthly buckets with tagihan and pembayaran for this month", async () => {
    const series = await getMonthlySeries(ownerCtx());
    expect(series.points).toHaveLength(12);
    expect(series.empty).toBe(false);

    const currentKey = monthKeyOf(new Date());
    const current = series.points.at(-1)!;
    expect(current.month).toBe(currentKey);

    const expectedBilled = await sumColumn(
      billedKeys.filter((key) => monthKeyOf(`${invoiceDates[key]}T00:00:00.000Z`) === currentKey),
      "grandTotal",
    );
    expect(current.billed).toBe(expectedBilled);

    const expectedPaid = await sumColumn(
      billedKeys.filter((key) => monthKeyOf(`${invoiceDates[key]}T00:00:00.000Z`) === currentKey),
      "amountPaid",
    );
    const paidThisMonth = paymentDates.filter(
      (date) => monthKeyOf(`${date}T00:00:00.000Z`) === currentKey,
    );
    if (paidThisMonth.length > 0) {
      expect(current.paid).toBe(expectedPaid);
    }

    // Buckets are strictly ascending.
    const months = series.points.map((point) => point.month);
    expect([...months]).toEqual([...months].sort());
  });

  it("reports an empty series for an organization without invoices", async () => {
    const series = await getMonthlySeries(ownerCtx(emptyOrg.id));
    expect(series.empty).toBe(true);
    expect(series.points).toHaveLength(12);
    expect(series.points.every((point) => point.billed === "0.00")).toBe(true);
  });
});

// ─── Recent activity ──────────────────────────────────────────────────────

describe("recent activity (Check When Done)", () => {
  it("shows at most 5 newest events of THIS organization", async () => {
    const items = await getRecentActivity(ownerCtx());
    expect(items.length).toBe(DASHBOARD_ACTIVITY_LIMIT);

    const ownAuditIds = new Set(
      (
        await db.auditLog.findMany({
          where: { organizationId: org.id },
          select: { id: true },
        })
      ).map((row) => row.id),
    );
    expect(items.every((item) => ownAuditIds.has(item.id))).toBe(true);
    expect(items.every((item) => item.actorName.length > 0)).toBe(true);

    // Newest first (createdAt desc).
    const stamps = items.map((item) => new Date(item.createdAt).getTime());
    expect([...stamps]).toEqual([...stamps].sort((a, b) => b - a));

    const allowed = new Set([
      "Invoice baru dibuat",
      "Invoice diterbitkan",
      "Invoice ditandai terkirim",
      "Invoice dibatalkan",
      "Invoice direvisi",
      "Pembayaran dicatat",
      "Pembayaran dibatalkan (reversal)",
    ]);
    expect(items.every((item) => allowed.has(item.label))).toBe(true);

    // The foreign org's events are never part of this timeline.
    const foreignAuditIds = new Set(
      (
        await db.auditLog.findMany({
          where: { organizationId: otherOrg.id },
          select: { id: true },
        })
      ).map((row) => row.id),
    );
    expect(items.some((item) => foreignAuditIds.has(item.id))).toBe(false);
  });

  it("returns an empty timeline for an organization without activity", async () => {
    const items = await getRecentActivity(ownerCtx(emptyOrg.id));
    expect(items).toEqual([]);
  });
});
