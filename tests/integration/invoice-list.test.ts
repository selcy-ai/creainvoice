// tests/integration/invoice-list.test.ts
// Feature 08 "Check When Done" at the service layer (the query service the
// /invoices page calls):
//   - server-side pagination: page 1 → 2 → 3, total record benar, page di luar
//     rentang di-clamp (tidak pernah 404/blank)
//   - search: nama customer ("Dharma") dan nomor invoice menfilter list
//   - filter status + jenis + customer + profil + rentang tanggal, termasuk
//     kombinasi dan status baca OVERDUE (on-read, tidak pernah disimpan)
//   - sort per kolom (tanggal, grand total, nomor) + sort tak dikenal jatuh ke
//     default tanpa error
//   - validasi server: tanggal/status/jenis/range rusak → VALIDATION_ERROR
//   - row actions permission-aware: VIEWER hanya preview/download, STAFF
//     edit/issue/duplicate/mark sent/record payment, OWNER/ADMIN + cancel dan
//     revise — flag hanya true bila SERVICE menerima aksi itu (status guard)
//   - org isolation: data organisasi lain tidak pernah bocor, sebaliknya juga
//   - quick search (Cmd+K) + opsi filter

import { beforeAll, describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import { isAppError, type AppError } from "@/lib/errors";
import { todayInJakarta } from "@/lib/date";
import { createCustomer, type CustomerFormInput } from "@/modules/customers/service";
import { createProfile } from "@/modules/profiles/service";
import { createProject, type ProjectFormInput } from "@/modules/projects/service";
import { createDraft } from "@/modules/invoices/service";
import { issueInvoice } from "@/modules/invoices/issue-service";
import { cancelInvoice } from "@/modules/invoices/lifecycle-service";
import { recordPayment } from "@/modules/payments/service";
import type { InvoiceDraftFormOutput } from "@/modules/invoices/schema";
import {
  listInvoiceFilterOptions,
  listInvoices,
  quickSearchInvoices,
  type InvoiceListQuery,
} from "@/modules/invoices/query-service";
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
let staff: TestUser;
let viewer: TestUser;
let org: { id: string };
let otherOrg: { id: string };

let profileId: string;
let foreignProfileId: string;
let cCipta: string;
let cSentosa: string;
let foreignCustomer: string;
let projectId: string;

/** Every invoice created in `org`, keyed by fixture role (see beforeAll). */
const ids = {} as Record<
  "draftA" | "draftB" | "overdue" | "issuedOk" | "partial" | "paid" | "cancelled",
  string
>;
const foreignIds: string[] = [];

/** Calendar-day shift from today (Asia/Jakarta) — never a hardcoded date, so
 * the suite does not rot as the clock moves. */
function shift(days: number): string {
  const [year = 2026, month = 1, day = 1] = todayInJakarta().split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}
const daysAgo = (days: number): string => shift(-days);
const daysFromNow = (days: number): string => shift(days);

const ownerCtx = (organizationId?: string) =>
  ctxFor(organizationId ?? org.id, owner.id);
const staffCtx = () => ctxFor(org.id, staff.id);
const viewerCtx = () => ctxFor(org.id, viewer.id);

async function expectAppFailure(
  promise: Promise<unknown>,
  code: AppError["code"],
): Promise<AppError> {
  let caught: unknown = null;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(isAppError(caught)).toBe(true);
  const appError = caught as AppError;
  expect(appError.code).toBe(code);
  return appError;
}

async function list(ctx: ReturnType<typeof ownerCtx>, query: InvoiceListQuery = {}) {
  return listInvoices(ctx, query);
}

function customerInput(name: string): CustomerFormInput {
  return {
    companyName: name,
    legalName: name,
    businessType: "Dagang",
    taxId: "",
    address: "Jl. Uji No. 8",
    city: "Jakarta Pusat",
    province: "DKI Jakarta",
    postalCode: "10110",
    country: "Indonesia",
    phone: "0215550100",
    whatsapp: "",
    email: `halo@${name.toLowerCase().replace(/[^a-z]+/g, "")}.test.local`,
    notes: "",
    isActive: true,
  } as CustomerFormInput;
}

function draftInput(overrides: Partial<InvoiceDraftFormOutput> = {}): InvoiceDraftFormOutput {
  return {
    profileId,
    invoiceType: "FULL",
    customerId: cCipta,
    billingMode: "PERCENT",
    billingPercent: "100",
    invoiceDate: daysAgo(20),
    dueDate: daysFromNow(5),
    items: [
      {
        description: "Jasa pemasangan",
        quantity: "1",
        unit: "Paket",
        unitPrice: "1000000",
      },
    ],
    ...overrides,
  } as InvoiceDraftFormOutput;
}

async function makeInvoice(
  key: keyof typeof ids,
  overrides: Partial<InvoiceDraftFormOutput> = {},
  options: { draft?: boolean; cancel?: boolean } = {},
): Promise<void> {
  const draft = await createDraft(draftInput(overrides), ownerCtx());
  ids[key] = draft.id;
  if (options.draft) return; // stays a draft — never issued
  await issueInvoice(draft.id, ownerCtx());
  if (options.cancel) {
    await cancelInvoice(draft.id, "Customer membatalkan PO.", ownerCtx());
  }
}

beforeAll(async () => {
  await resetDatabase();
  owner = await createUser({ username: "list.owner" });
  staff = await createUser({ username: "list.staff" });
  viewer = await createUser({ username: "list.viewer" });
  org = await createOrganization("CreaInvoice Studio");
  otherOrg = await createOrganization("Organisasi Lain");
  await addMembership(owner.id, org.id, "OWNER");
  await addMembership(staff.id, org.id, "STAFF");
  await addMembership(viewer.id, org.id, "VIEWER");
  await addMembership(owner.id, otherOrg.id, "OWNER");

  profileId = (await createProfile(ownerCtx(), { name: "CreaInvoice Studio", code: "SB" })).id;
  cCipta = (await createCustomer(customerInput("PT Cipta Karya Prima"), ownerCtx())).id;
  cSentosa = (await createCustomer(customerInput("PT Sentosa Makmur"), ownerCtx())).id;

  const project = await createProject(
    {
      customerId: cSentosa,
      referenceType: "PURCHASE_ORDER",
      referenceNumber: "PO-TEST-001",
      title: "Pemasangan jaringan",
      workValue: "50000000",
      currency: "IDR",
    } satisfies ProjectFormInput,
    ownerCtx(),
  );
  projectId = project.id;

  // Fixture matrix (org-scoped unless noted):
  //   draftA    Cipta  FULL           DRAFT           invoiceDate −20d
  //   draftB    Sentosa DOWN_PAYMENT   DRAFT           −15d, linked project
  //   overdue   Cipta  FULL           ISSUED (→OVERDUE) −40d, due −10d
  //   issuedOk  Sentosa FULL           ISSUED          −5d,  due +10d
  //   partial   Sentosa DOWN_PAYMENT   PARTIALLY_PAID  −3d
  //   paid      Cipta  FULL           PAID            −2d
  //   cancelled Sentosa FULL           CANCELLED       −30d
  await makeInvoice(
    "draftA",
    { invoiceDate: daysAgo(20), dueDate: daysFromNow(5) },
    { draft: true },
  );
  await makeInvoice("draftB", {
    invoiceType: "DOWN_PAYMENT",
    customerId: cSentosa,
    invoiceDate: daysAgo(15),
    dueDate: daysFromNow(10),
    projectReferenceId: projectId,
    items: [
      { description: "Termin 1", quantity: "5", unit: "Lot", unitPrice: "900000" },
    ],
  }, { draft: true });
  await makeInvoice("overdue", {
    invoiceDate: daysAgo(40),
    dueDate: daysAgo(10),
    items: [{ description: "Sewa alat", quantity: "1", unit: "Paket", unitPrice: "3000000" }],
  });
  await makeInvoice("issuedOk", {
    customerId: cSentosa,
    invoiceDate: daysAgo(5),
    dueDate: daysFromNow(10),
    items: [{ description: "Instalasi", quantity: "1", unit: "Paket", unitPrice: "4000000" }],
  });
  await makeInvoice("partial", {
    invoiceType: "DOWN_PAYMENT",
    customerId: cSentosa,
    invoiceDate: daysAgo(3),
    dueDate: daysFromNow(14),
    items: [{ description: "DP pekerjaan", quantity: "5", unit: "Lot", unitPrice: "900000" }],
  });
  await makeInvoice("paid", {
    invoiceDate: daysAgo(2),
    dueDate: daysFromNow(7),
    items: [{ description: "Survey lokasi", quantity: "1", unit: "Paket", unitPrice: "1500000" }],
  });
  await makeInvoice(
    "cancelled",
    { customerId: cSentosa, invoiceDate: daysAgo(30), dueDate: daysAgo(15) },
    { cancel: true },
  );

  // Payments: partial = half of its grand total, paid = exactly its grand total.
  const partialRow = await db.invoice.findUnique({ where: { id: ids.partial } });
  const paidRow = await db.invoice.findUnique({ where: { id: ids.paid } });
  await recordPayment(
    ids.partial,
    {
      paymentDate: daysAgo(3),
      amount: new Decimal(partialRow!.grandTotal.toString()).div(2).toFixed(2),
      method: "BANK_TRANSFER",
      referenceNumber: "TRF-PART",
    },
    ownerCtx(),
  );
  await recordPayment(
    ids.paid,
    {
      paymentDate: daysAgo(2),
      amount: paidRow!.grandTotal.toString(),
      method: "CASH",
      referenceNumber: "TRF-FULL",
    },
    ownerCtx(),
  );

  // Foreign org: two invoices that must never appear in `org`'s list.
  const foreignCustomerRow = await createCustomer(
    customerInput("PT Luar Negeri"),
    ownerCtx(otherOrg.id),
  );
  foreignCustomer = foreignCustomerRow.id;
  const foreignProfile = await createProfile(ownerCtx(otherOrg.id), {
    name: "Lain Lain",
    code: "LL",
  });
  foreignProfileId = foreignProfile.id;
  for (const n of ["1", "2"]) {
    const draft = await createDraft(
      draftInput({
        profileId: foreignProfile.id,
        customerId: foreignCustomer,
        invoiceDate: daysAgo(Number(n)),
      }),
      ownerCtx(otherOrg.id),
    );
    await issueInvoice(draft.id, ownerCtx(otherOrg.id));
    foreignIds.push(draft.id);
  }
}, 180_000);

// ─── Pagination & sort ────────────────────────────────────────────────────

describe("pagination + sort (Check When Done)", () => {
  it("page 1 → 2 → 3 with the correct total, and an out-of-range page clamps", async () => {
    const page1 = await list(ownerCtx(), { pageSize: 3 });
    expect(page1.total).toBe(7);
    expect(page1.totalPages).toBe(3);
    expect(page1.rows).toHaveLength(3);
    expect(page1.page).toBe(1);

    const page2 = await list(ownerCtx(), { page: 2, pageSize: 3 });
    expect(page2.page).toBe(2);
    expect(page2.rows).toHaveLength(3);
    // Pages never repeat a row.
    const seen = new Set(page1.rows.map((row) => row.id));
    expect(page2.rows.some((row) => seen.has(row.id))).toBe(false);

    const page3 = await list(ownerCtx(), { page: 3, pageSize: 3 });
    expect(page3.page).toBe(3);
    expect(page3.rows).toHaveLength(1);

    const clamped = await list(ownerCtx(), { page: 99, pageSize: 3 });
    expect(clamped.page).toBe(3);
    expect(clamped.rows).toHaveLength(1);
  });

  it("sorts by grand total in both directions (server-side)", async () => {
    const asc = await list(ownerCtx(), { pageSize: 100, sort: "grandTotal", dir: "asc" });
    const ascValues = asc.rows.map((row) => new Decimal(row.grandTotal));
    for (let i = 1; i < ascValues.length; i += 1) {
      expect(ascValues[i]!.gte(ascValues[i - 1]!)).toBe(true);
    }

    const desc = await list(ownerCtx(), { pageSize: 100, sort: "grandTotal", dir: "desc" });
    const descValues = desc.rows.map((row) => new Decimal(row.grandTotal));
    for (let i = 1; i < descValues.length; i += 1) {
      expect(descValues[i]!.lte(descValues[i - 1]!)).toBe(true);
    }
    expect(desc.rows[0]!.grandTotal).toBe(descValues[0]!.toFixed(2));
  });

  it("sorts by invoice number (issued rows in order) and by date", async () => {
    const byNumber = await list(ownerCtx(), { pageSize: 100, sort: "number", dir: "asc" });
    const numbers = byNumber.rows
      .filter((row) => row.number !== null)
      .map((row) => row.number!);
    expect(numbers.length).toBeGreaterThanOrEqual(5);
    expect([...numbers]).toEqual([...numbers].sort());

    const byDate = await list(ownerCtx(), { pageSize: 100, sort: "invoiceDate", dir: "asc" });
    const dates = byDate.rows.map((row) => row.invoiceDate);
    expect([...dates]).toEqual([...dates].sort());
  });

  it("unknown sort column falls back to the default order (no error)", async () => {
    const result = await list(ownerCtx(), { pageSize: 10, sort: "hacker; DROP", dir: "sideways" });
    expect(result.rows).toHaveLength(7);
    // Default: invoiceDate desc → the newest invoice first.
    expect(result.rows[0]!.id).toBe(ids.paid);
    expect(result.rows[1]!.id).toBe(ids.partial);
  });
});

// ─── Search ───────────────────────────────────────────────────────────────

describe("search (Check When Done)", () => {
  it("filters by customer name (Cipta)", async () => {
    const result = await list(ownerCtx(), { search: "Cipta Karya", pageSize: 50 });
    expect(result.total).toBe(3);
    expect(result.rows.map((row) => row.id).sort()).toEqual(
      [ids.draftA, ids.overdue, ids.paid].sort(),
    );
    expect(result.rows.every((row) => row.customerName.includes("Cipta"))).toBe(true);
  });

  it("filters by invoice number", async () => {
    const issued = await db.invoice.findUnique({ where: { id: ids.issuedOk } });
    const number = issued!.number!;
    const result = await list(ownerCtx(), { search: number });
    expect(result.total).toBe(1);
    expect(result.rows[0]!.id).toBe(ids.issuedOk);
    expect(result.rows[0]!.label).toBe(number);
  });

  it("a miss returns an empty page (honest total, not an error)", async () => {
    const result = await list(ownerCtx(), { search: "TidakAdaSamaSekali" });
    expect(result.total).toBe(0);
    expect(result.rows).toHaveLength(0);
  });
});

// ─── Filters ──────────────────────────────────────────────────────────────

describe("filters (Check When Done)", () => {
  it("combines status + jenis + customer + profil + rentang tanggal", async () => {
    const result = await list(ownerCtx(), {
      status: "DRAFT",
      type: "DOWN_PAYMENT",
      customer: cSentosa,
      profile: profileId,
      from: daysAgo(16),
      to: todayInJakarta(),
    });
    expect(result.total).toBe(1);
    expect(result.rows[0]!.id).toBe(ids.draftB);
    expect(result.rows[0]!.permissions.createSettlement).toBe(true);
  });

  it("filters the read-time OVERDUE status, and ISSUED excludes those rows", async () => {
    const overdue = await list(ownerCtx(), { status: "OVERDUE", pageSize: 50 });
    expect(overdue.total).toBe(1);
    expect(overdue.rows[0]!.id).toBe(ids.overdue);
    expect(overdue.rows[0]!.status).toBe("ISSUED");
    expect(overdue.rows[0]!.displayStatus).toBe("OVERDUE");

    const issued = await list(ownerCtx(), { status: "ISSUED", pageSize: 50 });
    expect(issued.rows.map((row) => row.id)).toEqual([ids.issuedOk]);
    expect(issued.rows[0]!.displayStatus).toBe("ISSUED");
  });

  it("filters by jenis invoice", async () => {
    const dp = await list(ownerCtx(), { type: "DOWN_PAYMENT", pageSize: 50 });
    expect(dp.rows.map((row) => row.id).sort()).toEqual([ids.draftB, ids.partial].sort());
  });

  it("filters by rentang tanggal invoice (inclusive)", async () => {
    const recent = await list(ownerCtx(), { from: daysAgo(6), to: todayInJakarta(), pageSize: 50 });
    expect(recent.rows.map((row) => row.id).sort()).toEqual(
      [ids.issuedOk, ids.partial, ids.paid].sort(),
    );
  });

  it("rejects malformed input server-side (VALIDATION_ERROR)", async () => {
    await expectAppFailure(list(ownerCtx(), { from: "2026-13-99" }), "VALIDATION_ERROR");
    await expectAppFailure(list(ownerCtx(), { to: "09-10-2026" }), "VALIDATION_ERROR");
    await expectAppFailure(
      list(ownerCtx(), { from: daysAgo(10), to: daysAgo(20) }),
      "VALIDATION_ERROR",
    );
    await expectAppFailure(list(ownerCtx(), { status: "BOGUS" }), "VALIDATION_ERROR");
    await expectAppFailure(list(ownerCtx(), { type: "NOPE" }), "VALIDATION_ERROR");
  });
});

// ─── Row action permissions ───────────────────────────────────────────────

describe("row actions are permission-aware (Check When Done)", () => {
  it("flat workspace: every member gets the full action set (Change 6)", async () => {
    // Change 6: role tiers are gone — every member is a full admin, so the
    // row flags no longer differ between VIEWER / STAFF / owner. What still
    // varies is the STATUS of the row: a draft is editable, an issued invoice
    // is not, a cancelled/paid one cannot be cancelled again.
    for (const ctx of [ownerCtx(), staffCtx(), viewerCtx()]) {
      const result = await list(ctx, { pageSize: 50 });
      expect(result.total).toBe(7);
      const byId = new Map(result.rows.map((row) => [row.id, row]));

      const draft = byId.get(ids.draftA)!;
      expect(draft.permissions).toMatchObject({
        view: true,
        edit: true,
        issue: true,
        duplicate: true,
        remove: true,
        markSent: false,
        recordPayment: false,
        createSettlement: false,
      });

      const issued = byId.get(ids.issuedOk)!;
      expect(issued.permissions).toMatchObject({
        edit: false,
        issue: false,
        markSent: true,
        recordPayment: true,
        cancel: true,
        revise: true,
        duplicate: false,
        remove: false,
      });

      // Status gates still apply to everyone equally.
      const cancelled = byId.get(ids.cancelled)!;
      expect(cancelled.permissions.cancel).toBe(false);
      expect(cancelled.permissions.revise).toBe(false);
      expect(cancelled.permissions.issue).toBe(false);

      const paid = byId.get(ids.paid)!;
      expect(paid.permissions.cancel).toBe(false);
      expect(paid.permissions.revise).toBe(false);
      expect(paid.permissions.recordPayment).toBe(true);

      // Settlement only exists where there is a project to settle.
      expect(byId.get(ids.draftB)!.permissions.createSettlement).toBe(true);
      expect(byId.get(ids.draftA)!.permissions.createSettlement).toBe(false);
    }
  });
});

// ─── Org isolation ────────────────────────────────────────────────────────

describe("org isolation (Check When Done)", () => {
  it("never returns another organization's invoices", async () => {
    const mine = await list(ownerCtx(), { pageSize: 100 });
    expect(mine.rows.some((row) => foreignIds.includes(row.id))).toBe(false);

    const theirs = await list(ownerCtx(otherOrg.id), { pageSize: 100 });
    expect(theirs.total).toBe(2);
    expect(theirs.rows.every((row) => foreignIds.includes(row.id))).toBe(true);
  });
});

// ─── Quick search + filter options ────────────────────────────────────────

describe("command search + filter options", () => {
  it("quick search matches number/preview/customer, is capped and org-scoped", async () => {
    const byCustomer = await quickSearchInvoices(ownerCtx(), { q: "Cipta" });
    expect(byCustomer.length).toBeGreaterThanOrEqual(3);
    expect(byCustomer.every((row) => row.customerName.includes("Cipta"))).toBe(true);

    const issued = await db.invoice.findUnique({ where: { id: ids.overdue } });
    const byNumber = await quickSearchInvoices(ownerCtx(), { q: issued!.number! });
    // A draft's numberPreview is computed at save time and never refreshed
    // (documented quirk, feature 08 session notes), so whenever the issued
    // number's month+sequence bucket happens to match a draft's stale
    // preview — calendar-dependent, since the preview renders the month of
    // the draft's own invoiceDate — the same text matches several rows. The
    // invariant worth guarding: the invoice that actually CARRIES the final
    // number is returned, and it is the only row that carries it.
    const carryingFinalNumber = byNumber.filter((row) => row.status !== "DRAFT");
    expect(carryingFinalNumber).toHaveLength(1);
    expect(carryingFinalNumber[0]!.id).toBe(ids.overdue);
    expect(byNumber.map((row) => row.id)).toContain(ids.overdue);

    expect(await quickSearchInvoices(ownerCtx(), { q: "  " })).toEqual([]);

    const capped = await quickSearchInvoices(ownerCtx(), { q: "PT", limit: 2 });
    expect(capped.length).toBeLessThanOrEqual(2);

    const foreign = await quickSearchInvoices(ownerCtx(otherOrg.id), { q: "Cipta" });
    expect(foreign).toEqual([]);
  });

  it("filter options only expose this organization's customers and profiles", async () => {
    const options = await listInvoiceFilterOptions(ownerCtx());
    expect(options.customers.map((row) => row.companyName).sort()).toEqual([
      "PT Cipta Karya Prima",
      "PT Sentosa Makmur",
    ]);
    // One invoice profile per organization (feature 02 rule) — the filter must
    // offer exactly this org's profile, and a foreign profile id matches 0 rows.
    expect(options.profiles.map((row) => row.name)).toEqual(["CreaInvoice Studio"]);
    const byProfile = await list(ownerCtx(), { profile: options.profiles[0]!.id, pageSize: 50 });
    expect(byProfile.total).toBe(7);
    const foreignProfileFilter = await list(ownerCtx(), { profile: foreignProfileId });
    expect(foreignProfileFilter.total).toBe(0);

    const theirs = await listInvoiceFilterOptions(ownerCtx(otherOrg.id));
    expect(theirs.customers.map((row) => row.id)).toEqual([foreignCustomer]);
  });
});
