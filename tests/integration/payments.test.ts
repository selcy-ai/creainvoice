// tests/integration/payments.test.ts
// Feature 07 "Check When Done" at the service layer:
//   - record payment: ISSUED Rp1.000.000 of Rp2.250.000 → PARTIALLY_PAID with
//     amountPaid 1.000.000 / remainingAfter 1.250.000; second payment → PAID,
//     remainingAfter 0, badge/status reads PARTIALLY_PAID → PAID
//   - DRAFT and CANCELLED invoices are rejected (LOCKED)
//   - overpayment: STAFF confirms, OWNER/ADMIN override with a reason
//   - proof upload: PNG/PDF accepted with a random filename, >2 MB rejected,
//     fake MIME rejected, file removed on reversal
//   - reversal: OWNER/ADMIN only, status recomputed, audit metadata
//     { reversed: true }, no account number anywhere in the metadata
//   - permissions: VIEWER read-only, STAFF records, cross-org answers 404
//   - /payments list: server-side pagination + invoice/customer/date filters

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import { isAppError, type AppError } from "@/lib/errors";
import { env } from "@/server/env";
import { createCustomer, type CustomerFormInput } from "@/modules/customers/service";
import { createProfile } from "@/modules/profiles/service";
import { saveBankAccount } from "@/modules/bank-accounts/service";
import { createDraft } from "@/modules/invoices/service";
import type { InvoiceDraftFormOutput } from "@/modules/invoices/schema";
import { issueInvoice } from "@/modules/invoices/issue-service";
import { cancelInvoice } from "@/modules/invoices/lifecycle-service";
import { getInvoiceDetail } from "@/modules/invoices/detail-service";
import {
  deletePayment,
  getInvoicePaymentPanel,
  listPayableInvoices,
  listPayments,
  recordPayment,
} from "@/modules/payments/service";
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
let customerId: string;
let customer2Id: string;
let foreignCustomerId: string;
/** Bank account number of the org — must NEVER appear in audit metadata. */
const ACCOUNT_NUMBER = "987654321098";

/** A real 1×1 PNG (magic bytes — this is what the sniffer judges). */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
/** Minimal but valid PDF header bytes. */
const PDF_BYTES = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
  "latin1",
);


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

function customerInput(name: string): CustomerFormInput {
  return {
    companyName: name,
    legalName: name,
    businessType: "Dagang",
    taxId: "02.3456.7890.000003",
    address: "Jl. Pembayaran No. 7",
    city: "Jakarta Pusat",
    province: "DKI Jakarta",
    postalCode: "10110",
    country: "Indonesia",
    phone: "0215550199",
    whatsapp: "",
    email: "bayar@pembayaran.co.id",
    isActive: true,
  };
}

/** DOWN_PAYMENT 50% of 5 × 900.000 → grandTotal Rp2.250.000 (spec number). */
function draftInput(overrides: Partial<InvoiceDraftFormOutput> = {}): InvoiceDraftFormOutput {
  return {
    profileId,
    invoiceType: "DOWN_PAYMENT",
    customerId,
    billingMode: "PERCENT",
    billingPercent: "50",
    invoiceDate: "2026-07-01",
    items: [
      {
        description: "Pemasangan bracket frame",
        quantity: "5",
        unit: "Unit",
        unitPrice: "900000",
      },
    ],
    ...overrides,
  } as InvoiceDraftFormOutput;
}

/** Issue a fresh Rp2.250.000 invoice and return its id. */
async function issueQuick(overrides: Partial<InvoiceDraftFormOutput> = {}): Promise<string> {
  const draft = await createDraft(draftInput(overrides), ownerCtx());
  await issueInvoice(draft.id, ownerCtx());
  return draft.id;
}

function paymentInput(
  overrides: Partial<{ paymentDate: string; amount: string; method: "BANK_TRANSFER" | "CASH" | "QRIS" | "OTHER"; referenceNumber: string; notes: string; confirmOverpayment: boolean; overpaymentReason: string }> = {},
) {
  return {
    paymentDate: "2026-10-01",
    amount: "1000000",
    method: "BANK_TRANSFER" as const,
    referenceNumber: "TRF-001",
    notes: "DP termin pertama",
    ...overrides,
  };
}

beforeAll(async () => {
  await resetDatabase();
  owner = await createUser({ username: "pay.owner" });
  staff = await createUser({ username: "pay.staff" });
  viewer = await createUser({ username: "pay.viewer" });
  org = await createOrganization("CreaInvoice Studio");
  otherOrg = await createOrganization("Organisasi Lain");
  await addMembership(owner.id, org.id, "OWNER");
  await addMembership(staff.id, org.id, "STAFF");
  await addMembership(viewer.id, org.id, "VIEWER");
  await addMembership(owner.id, otherOrg.id, "OWNER");

  const profile = await createProfile(ownerCtx(), { name: "CreaInvoice Studio", code: "SB" });
  profileId = profile.id;

  await saveBankAccount(
    { bankName: "Bank Uji", accountNumber: ACCOUNT_NUMBER, accountHolder: "PT CreaInvoice Studio" },
    ownerCtx(),
  );

  customerId = (await createCustomer(customerInput("PT Pembayaran Nusantara"), ownerCtx())).id;
  customer2Id = (await createCustomer(customerInput("PT Pembayaran Sejahtera"), ownerCtx())).id;
  foreignCustomerId = (
    await createCustomer(customerInput("PT Luar Negeri"), ownerCtx(otherOrg.id))
  ).id;
}, 60_000);

// ─── Record payment: partial → paid ──────────────────────────────────────

describe("record payment (Check When Done)", () => {
  let invoiceId: string;

  it("records Rp1.000.000 against Rp2.250.000 → PARTIALLY_PAID + live columns + audit", async () => {
    invoiceId = await issueQuick();

    const outcome = await recordPayment(
      invoiceId,
      paymentInput({ amount: "1000000", referenceNumber: "TRF-001" }),
      ownerCtx(),
    );
    expect(outcome.status).toBe("PARTIALLY_PAID");
    expect(outcome.amountPaid).toBe("1000000.00");
    expect(outcome.remainingAfter).toBe("1250000.00");

    const row = await db.invoice.findUnique({ where: { id: invoiceId } });
    expect(row!.status).toBe("PARTIALLY_PAID");
    expect(Number(row!.amountPaid).toFixed(2)).toBe("1000000.00");
    expect(Number(row!.remainingAfter).toFixed(2)).toBe("1250000.00");
    // Snapshot immutability: the frozen calculation is untouched by payments.
    const calcSnap = row!.calculationSnapshot as { grandTotal: string } | null;
    expect(calcSnap).not.toBeNull();

    const payment = await db.payment.findUnique({ where: { id: outcome.paymentId } });
    expect(payment).not.toBeNull();
    expect(payment!.organizationId).toBe(org.id);
    expect(payment!.createdById).toBe(owner.id);
    expect(payment!.paymentDate.toISOString().slice(0, 10)).toBe("2026-10-01");
    expect(payment!.method).toBe("BANK_TRANSFER");
    expect(payment!.referenceNumber).toBe("TRF-001");

    const audit = await db.auditLog.findFirst({
      where: { action: "PAYMENT_RECORDED", entityId: outcome.paymentId },
    });
    expect(audit).not.toBeNull();
    expect(audit!.metadata).toMatchObject({
      invoiceId,
      amount: "1000000.00",
      method: "BANK_TRANSFER",
      status: "PARTIALLY_PAID",
      overpayment: false,
    });
    // Security: no bank account number (or its digits) ever lands in metadata.
    expect(JSON.stringify(audit!.metadata)).not.toContain(ACCOUNT_NUMBER);
  });

  it("records the second payment → PAID with remainingAfter 0 and the badge status", async () => {
    const outcome = await recordPayment(
      invoiceId,
      paymentInput({ paymentDate: "2026-10-02", amount: "1250000", method: "CASH" }),
      ownerCtx(),
    );
    expect(outcome.status).toBe("PAID");
    expect(outcome.amountPaid).toBe("2250000.00");
    expect(outcome.remainingAfter).toBe("0.00");

    // The detail view (which feeds InvoiceStatusBadge) reports the paid state.
    const detail = await getInvoiceDetail(invoiceId, ownerCtx());
    expect(detail.status).toBe("PAID");
    expect(detail.displayStatus).toBe("PAID");
    expect(new Decimal(detail.amounts.amountPaid).toFixed(2)).toBe("2250000.00");
    expect(new Decimal(detail.amounts.remainingAfter).toFixed(2)).toBe("0.00");

    const panel = await getInvoicePaymentPanel(invoiceId, ownerCtx());
    expect(panel.status).toBe("PAID");
    expect(panel.permissions.record).toBe(true);
    expect(panel.rows).toHaveLength(2);
    const latest = panel.rows[0]!;
    expect(latest.paymentDate).toBe("2026-10-02");
    expect(latest.method).toBe("CASH");
    expect(latest.recordedByName).toBe(owner.name);
    expect(latest.invoiceLabel).toBeTruthy();
    expect(latest.customerName).toBe("PT Pembayaran Nusantara");
  });

  it("keeps PARTIALLY_PAID visible on the detail view (badge status)", async () => {
    const partial = await issueQuick();
    await recordPayment(partial, paymentInput({ amount: "500000" }), ownerCtx());
    const detail = await getInvoiceDetail(partial, ownerCtx());
    expect(detail.displayStatus).toBe("PARTIALLY_PAID");
    expect(detail.status).toBe("PARTIALLY_PAID");
  });

  it("rejects a DRAFT invoice (LOCKED — no payment rows written)", async () => {
    const draft = await createDraft(draftInput(), ownerCtx());
    await expectAppFailure(
      recordPayment(draft.id, paymentInput({ amount: "100000" }), ownerCtx()),
      "LOCKED",
    );
    const row = await db.invoice.findUnique({ where: { id: draft.id } });
    expect(row!.status).toBe("DRAFT");
    expect(Number(row!.amountPaid).toFixed(2)).toBe("0.00");
    expect(await db.payment.count({ where: { invoiceId: draft.id } })).toBe(0);
  });

  it("rejects a CANCELLED invoice (LOCKED)", async () => {
    const id = await issueQuick();
    await cancelInvoice(id, "PO dibatalkan oleh customer.", ownerCtx());
    const error = await expectAppFailure(
      recordPayment(id, paymentInput({ amount: "100000" }), ownerCtx()),
      "LOCKED",
    );
    expect(error.message).toMatch(/dibatalkan/i);
    expect(await db.payment.count({ where: { invoiceId: id } })).toBe(0);
  });

  it("rejects an invalid amount and an invalid date (VALIDATION_ERROR)", async () => {
    const id = await issueQuick();
    await expectAppFailure(
      recordPayment(id, paymentInput({ amount: "0" }), ownerCtx()),
      "VALIDATION_ERROR",
    );
    await expectAppFailure(
      recordPayment(id, paymentInput({ amount: "-5000" }), ownerCtx()),
      "VALIDATION_ERROR",
    );
    await expectAppFailure(
      recordPayment(id, paymentInput({ paymentDate: "2026-13-45" }), ownerCtx()),
      "VALIDATION_ERROR",
    );
    expect(await db.payment.count({ where: { invoiceId: id } })).toBe(0);
  });
});

// ─── Overpayment ─────────────────────────────────────────────────────────

describe("overpayment (Check When Done)", () => {
  it("blocks STAFF until they confirm, then records the excess", async () => {
    const id = await issueQuick();

    const failure = await expectAppFailure(
      recordPayment(id, paymentInput({ amount: "3000000" }), staffCtx()),
      "VALIDATION_ERROR",
    );
    expect(failure.message).toMatch(/melebihi sisa tagihan/i);
    expect(await db.payment.count({ where: { invoiceId: id } })).toBe(0);

    const outcome = await recordPayment(
      id,
      paymentInput({ amount: "3000000", confirmOverpayment: true }),
      staffCtx(),
    );
    expect(outcome.status).toBe("PAID");
    expect(outcome.amountPaid).toBe("3000000.00");
    // STAFF confirms — no reason column to fill, and none stored.
    const payment = await db.payment.findUnique({ where: { id: outcome.paymentId } });
    expect(payment!.overpaymentReason).toBeNull();

    const audit = await db.auditLog.findFirst({
      where: { action: "PAYMENT_RECORDED", entityId: outcome.paymentId },
    });
    expect(audit!.metadata).toMatchObject({ overpayment: true, status: "PAID" });
  });

  it("requires an OWNER/ADMIN reason and stores it on the payment", async () => {
    const id = await issueQuick();

    // Confirmation alone is NOT enough for the override role — the reason is.
    await expectAppFailure(
      recordPayment(
        id,
        paymentInput({ amount: "2500000", confirmOverpayment: true }),
        ownerCtx(),
      ),
      "VALIDATION_ERROR",
    );
    expect(await db.payment.count({ where: { invoiceId: id } })).toBe(0);

    const outcome = await recordPayment(
      id,
      paymentInput({
        amount: "2500000",
        overpaymentReason: "Pelunasan termasuk denda keterlambatan.",
      }),
      ownerCtx(),
    );
    expect(outcome.status).toBe("PAID");

    const payment = await db.payment.findUnique({ where: { id: outcome.paymentId } });
    expect(payment!.overpaymentReason).toBe("Pelunasan termasuk denda keterlambatan.");
    // The invoice never goes negative — the excess lives in amountPaid.
    const row = await db.invoice.findUnique({ where: { id } });
    expect(Number(row!.remainingAfter).toFixed(2)).toBe("0.00");
    expect(Number(row!.amountPaid).toFixed(2)).toBe("2500000.00");
  });

  it("a normal payment needs no confirmation at all", async () => {
    const id = await issueQuick();
    const outcome = await recordPayment(id, paymentInput({ amount: "1000000" }), staffCtx());
    expect(outcome.status).toBe("PARTIALLY_PAID");
  });
});

// ─── Proof upload ────────────────────────────────────────────────────────

describe("proof upload (Check When Done)", () => {
  it("accepts a PNG with a random filename under payment-proofs", async () => {
    const id = await issueQuick();
    const file = new File([PNG_BYTES], "bukti-transfer.png", { type: "image/png" });
    const outcome = await recordPayment(
      id,
      paymentInput({ amount: "250000" }),
      ownerCtx(),
      { proof: file },
    );

    const payment = await db.payment.findUnique({ where: { id: outcome.paymentId } });
    const proofPath = payment!.proofPath;
    expect(proofPath).toMatch(
      new RegExp(`^uploads/organizations/${org.id}/payment-proofs/[0-9a-f-]{36}\\.png$`),
    );
    // The client's filename never reaches storage.
    expect(proofPath).not.toContain("bukti-transfer");
    expect(existsSync(resolve(env.STORAGE_ROOT, proofPath!))).toBe(true);

    const panel = await getInvoicePaymentPanel(id, ownerCtx());
    expect(panel.rows[0]!.proofPath).toBe(proofPath);
  });

  it("accepts a PDF proof by content", async () => {
    const id = await issueQuick();
    const file = new File([PDF_BYTES], "bukti.pdf", { type: "application/pdf" });
    const outcome = await recordPayment(
      id,
      paymentInput({ amount: "250000" }),
      ownerCtx(),
      { proof: file },
    );
    const payment = await db.payment.findUnique({ where: { id: outcome.paymentId } });
    expect(payment!.proofPath).toMatch(/\.pdf$/);
  });

  it("rejects a file above 2 MB", async () => {
    const id = await issueQuick();
    const big = new File([Buffer.alloc(2 * 1024 * 1024 + 10)], "besar.png", {
      type: "image/png",
    });
    const error = await expectAppFailure(
      recordPayment(id, paymentInput({ amount: "250000" }), ownerCtx(), { proof: big }),
      "VALIDATION_ERROR",
    );
    expect(error.message).toMatch(/melebihi batas 2 MB/i);
    expect(await db.payment.count({ where: { invoiceId: id } })).toBe(0);
  });

  it("rejects a file whose bytes are not one of the allowed types (fake MIME)", async () => {
    const id = await issueQuick();
    const fake = new File([Buffer.from("ini bukan gambar, hanya teks biasa")], "bukti.png", {
      type: "image/png",
    });
    const error = await expectAppFailure(
      recordPayment(id, paymentInput({ amount: "250000" }), ownerCtx(), { proof: fake }),
      "VALIDATION_ERROR",
    );
    expect(error.message).toMatch(/Format file tidak dikenali/i);
    expect(await db.payment.count({ where: { invoiceId: id } })).toBe(0);
  });
});

// ─── Reversal ────────────────────────────────────────────────────────────

describe("delete payment / reversal (Check When Done)", () => {
  it("is OWNER/ADMIN only, recomputes status, cleans up the proof and audits", async () => {
    const id = await issueQuick();
    const file = new File([PNG_BYTES], "bukti.png", { type: "image/png" });
    const p1 = await recordPayment(id, paymentInput({ amount: "1000000" }), ownerCtx());
    const p2 = await recordPayment(
      id,
      paymentInput({ paymentDate: "2026-10-02", amount: "1250000" }),
      ownerCtx(),
      { proof: file },
    );
    expect((await db.invoice.findUnique({ where: { id } }))!.status).toBe("PAID");

    // STAFF cannot reverse.
    await expectAppFailure(deletePayment(p2.paymentId, staffCtx()), "FORBIDDEN");

    const proofPath = (await db.payment.findUnique({ where: { id: p2.paymentId } }))!.proofPath!;
    expect(existsSync(resolve(env.STORAGE_ROOT, proofPath))).toBe(true);

    const back = await deletePayment(p2.paymentId, ownerCtx());
    expect(back.status).toBe("PARTIALLY_PAID");
    expect(back.amountPaid).toBe("1000000.00");
    expect(back.remainingAfter).toBe("1250000.00");
    expect(await db.payment.findUnique({ where: { id: p2.paymentId } })).toBeNull();
    // The proof file goes with the row (best-effort storage cleanup).
    expect(existsSync(resolve(env.STORAGE_ROOT, proofPath))).toBe(false);

    const audits = await db.auditLog.findMany({
      where: { action: "PAYMENT_RECORDED", entityId: p2.paymentId },
    });
    const reversedAudit = audits.find(
      (row) => (row.metadata as { reversed?: boolean }).reversed === true,
    );
    expect(reversedAudit).toBeDefined();
    expect(reversedAudit!.metadata).toMatchObject({
      reversed: true,
      invoiceId: id,
      amount: "1250000.00",
    });
    expect(JSON.stringify(reversedAudit!.metadata)).not.toContain(ACCOUNT_NUMBER);

    // Reversing the rest returns the invoice to ISSUED with nothing paid.
    const back2 = await deletePayment(p1.paymentId, ownerCtx());
    expect(back2.status).toBe("ISSUED");
    expect(back2.amountPaid).toBe("0.00");
    expect(back2.remainingAfter).toBe("2250000.00");
    const row = await db.invoice.findUnique({ where: { id } });
    expect(row!.status).toBe("ISSUED");
    expect(Number(row!.amountPaid).toFixed(2)).toBe("0.00");
  });

  it("answers 404 for a payment from another organization", async () => {
    const foreignProfile = await createProfile(ownerCtx(otherOrg.id), {
      name: "Organisasi Lain",
      code: "OL",
    });
    const foreignDraft = await createDraft(
      draftInput({ profileId: foreignProfile.id, customerId: foreignCustomerId }),
      ownerCtx(otherOrg.id),
    );
    await issueInvoice(foreignDraft.id, ownerCtx(otherOrg.id));
    const foreignPayment = await recordPayment(
      foreignDraft.id,
      paymentInput({ amount: "500000" }),
      ownerCtx(otherOrg.id),
    );

    // Our scope cannot see or touch it.
    await expectAppFailure(
      recordPayment(foreignDraft.id, paymentInput({ amount: "1000" }), ownerCtx()),
      "NOT_FOUND",
    );
    await expectAppFailure(
      getInvoicePaymentPanel(foreignDraft.id, ownerCtx()),
      "NOT_FOUND",
    );
    await expectAppFailure(deletePayment(foreignPayment.paymentId, ownerCtx()), "NOT_FOUND");

    const ours = await listPayments(ownerCtx(), {});
    expect(ours.rows.map((row) => row.id)).not.toContain(foreignPayment.paymentId);
    const theirs = await listPayments(ownerCtx(otherOrg.id), {});
    expect(theirs.rows.map((row) => row.id)).toContain(foreignPayment.paymentId);
  });
});

// ─── Permissions ─────────────────────────────────────────────────────────

describe("permissions (Check When Done)", () => {
  it("flat workspace: every member records payments and reads the panel", async () => {
    // Change 6: no role tiers — every verified member may record/reverse and
    // sees the same permission flags (no viewer/staff split anymore).
    const id = await issueQuick();
    const byStaff = await recordPayment(id, paymentInput({ amount: "100000" }), staffCtx());
    expect(byStaff.status).toBe("PARTIALLY_PAID");

    const byViewer = await recordPayment(
      id,
      paymentInput({ amount: "100000" }),
      viewerCtx(),
    );
    expect(byViewer.status).toBe("PARTIALLY_PAID");

    // The panel renders the same flags for every member of the workspace.
    const panel = await getInvoicePaymentPanel(id, viewerCtx());
    expect(panel.rows.length).toBeGreaterThan(0);
    expect(panel.permissions.record).toBe(true);
    expect(panel.permissions.reverse).toBe(true);
    expect(panel.permissions.override).toBe(true);

    const ownerPanel = await getInvoicePaymentPanel(id, ownerCtx());
    expect(ownerPanel.permissions.record).toBe(true);
    expect(ownerPanel.permissions.reverse).toBe(true);
    expect(ownerPanel.permissions.override).toBe(true);

    const list = await listPayments(viewerCtx(), {});
    expect(list.rows.map((row) => row.id)).toContain(byStaff.paymentId);
    await deletePayment(byStaff.paymentId, viewerCtx());
  });
});

// ─── /payments list ──────────────────────────────────────────────────────

describe("payments list (Check When Done)", () => {
  let listInvoiceId: string;
  let listInvoiceNumber: string;
  const paymentIds: string[] = [];

  it("paginates server-side", async () => {
    listInvoiceId = await issueQuick({ customerId: customer2Id });
    const row = await db.invoice.findUnique({ where: { id: listInvoiceId } });
    listInvoiceNumber = row!.number!;

    for (const date of ["2026-11-01", "2026-11-02", "2026-11-03"]) {
      const outcome = await recordPayment(
        listInvoiceId,
        paymentInput({ paymentDate: date, amount: "100000" }),
        ownerCtx(),
      );
      paymentIds.push(outcome.paymentId);
    }

    const page1 = await listPayments(ownerCtx(), {
      invoice: listInvoiceNumber,
      pageSize: 2,
    });
    expect(page1.total).toBe(3);
    expect(page1.totalPages).toBe(2);
    expect(page1.page).toBe(1);
    expect(page1.rows).toHaveLength(2);
    // Newest first — stable order across pages.
    expect(page1.rows.map((row) => row.paymentDate)).toEqual(["2026-11-03", "2026-11-02"]);

    const page2 = await listPayments(ownerCtx(), {
      invoice: listInvoiceNumber,
      pageSize: 2,
      page: 2,
    });
    expect(page2.page).toBe(2);
    expect(page2.rows).toHaveLength(1);
    expect(page2.rows[0]!.paymentDate).toBe("2026-11-01");
    expect(page2.rows[0]!.invoiceLabel).toBe(listInvoiceNumber);
    expect(page2.rows[0]!.customerName).toBe("PT Pembayaran Sejahtera");
  });

  it("filters by invoice number", async () => {
    const result = await listPayments(ownerCtx(), { invoice: listInvoiceNumber });
    expect(result.total).toBe(3);
    expect(result.rows.every((row) => row.invoiceId === listInvoiceId)).toBe(true);

    const miss = await listPayments(ownerCtx(), { invoice: "INV/TIDAK/ADA" });
    expect(miss.total).toBe(0);
    expect(miss.rows).toHaveLength(0);
  });

  it("filters by customer", async () => {
    const result = await listPayments(ownerCtx(), { customer: "Sejahtera" });
    expect(result.total).toBe(3);
    expect(result.rows.every((row) => row.customerName === "PT Pembayaran Sejahtera")).toBe(true);
  });

  it("filters by date range (inclusive) and validates the dates", async () => {
    const inRange = await listPayments(ownerCtx(), { from: "2026-11-02", to: "2026-11-03" });
    expect(inRange.rows.map((row) => row.paymentDate)).toEqual(["2026-11-03", "2026-11-02"]);

    const before = await listPayments(ownerCtx(), { to: "2026-10-31" });
    expect(before.rows.every((row) => row.paymentDate <= "2026-10-31")).toBe(true);

    await expectAppFailure(listPayments(ownerCtx(), { from: "03-11-2026" }), "VALIDATION_ERROR");
    await expectAppFailure(
      listPayments(ownerCtx(), { from: "2026-11-03", to: "2026-11-01" }),
      "VALIDATION_ERROR",
    );
  });

  it("lists every payable invoice for the record picker (drafts excluded)", async () => {
    const draft = await createDraft(draftInput(), ownerCtx());
    const options = await listPayableInvoices(ownerCtx());
    const ids = options.map((option) => option.id);
    expect(ids).not.toContain(draft.id);
    expect(ids).toContain(listInvoiceId);
    const option = options.find((row) => row.id === listInvoiceId)!;
    expect(option.label).toBe(listInvoiceNumber);
    expect(new Decimal(option.remaining).toFixed(2)).toBe("1950000.00");
    expect(options.length).toBeLessThanOrEqual(100);
  });
});
