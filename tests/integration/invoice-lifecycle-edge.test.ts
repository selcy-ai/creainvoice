// tests/integration/invoice-lifecycle-edge.test.ts
// Feature 05 states and gates that the happy-path file (invoice-lifecycle.test.ts)
// deliberately does not cover. Nothing here duplicates existing assertions —
// every case exercises a branch the builder's coverage missed.
//
// This suite shares one test database with the other integration files, so no
// test may rely on a project being free of other tests' invoices. Every test
// creates its OWN project and asserts only against rows it created itself.

import { beforeAll, describe, expect, it } from "vitest";
import { AppError, isAppError } from "@/lib/errors";
import { can } from "@/modules/workspace/permissions";
import { db } from "@/tests/helpers/test-db";
import { createCustomer } from "@/modules/customers/service";
import { createProject, getProjectBilling, type ProjectFormInput } from "@/modules/projects/service";
import { createProfile } from "@/modules/profiles/service";
import { saveBankAccount } from "@/modules/bank-accounts/service";
import { saveSigner } from "@/modules/signers/service";
import { createDraft, getDraft } from "@/modules/invoices/service";
import type { InvoiceDraftFormOutput } from "@/modules/invoices/schema";
import { issueInvoice } from "@/modules/invoices/issue-service";
import { cancelInvoice, createRevision, markSent } from "@/modules/invoices/lifecycle-service";
import { getInvoiceDetail } from "@/modules/invoices/detail-service";
import { getPdfJob } from "@/modules/pdf/service";
import {
  addMembership,
  createOrganization,
  createUser,
  resetDatabase,
  type TestUser,
} from "../factories";
import { ctxFor } from "@/tests/helpers/context";

let owner: TestUser;
let admin: TestUser;
let staff: TestUser;
let org: { id: string };
let otherOrg: { id: string };
let profileId: string;
let foreignProfileId: string;
let customerId: string;
let foreignCustomerId: string;
let bankId: string;
let foreignBankId: string;
let signerId: string;
let foreignSignerId: string;
/** Kept invoice-free so a zero billed sum is provable, not coincidental. */
let isolationProjectId: string;


const ownerCtx = (organizationId?: string) => ctxFor(organizationId ?? org.id, owner.id);
const adminCtx = () => ctxFor(org.id, admin.id);
const staffCtx = () => ctxFor(org.id, staff.id);
const foreignCtx = () => ctxFor(otherOrg.id, owner.id);

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

function draftInput(overrides: Partial<InvoiceDraftFormOutput> = {}): InvoiceDraftFormOutput {
  return {
    profileId,
    invoiceType: "FULL",
    customerId,
    billingMode: "PERCENT",
    invoiceDate: "2026-07-01",
    items: [{ description: "Pemasangan bracket frame", quantity: "5", unit: "Unit", unitPrice: "900000" }],
    ...overrides,
  } as InvoiceDraftFormOutput;
}

beforeAll(async () => {
  await resetDatabase();

  owner = await createUser({ username: "edge.owner" });
  admin = await createUser({ username: "edge.admin" });
  staff = await createUser({ username: "edge.staff" });
  org = await createOrganization("CreaInvoice Studio");
  otherOrg = await createOrganization("Organisasi Lain");
  await addMembership(owner.id, org.id, "OWNER");
  await addMembership(admin.id, org.id, "ADMIN");
  await addMembership(staff.id, org.id, "STAFF");
  await addMembership(owner.id, otherOrg.id, "OWNER");

  const profile = await createProfile(ownerCtx(), { name: "CreaInvoice Studio", code: "SB" });
  profileId = profile.id;
  const foreignProfile = await createProfile(ownerCtx(otherOrg.id), {
    name: "Organisasi Lain",
    code: "OL",
  });
  foreignProfileId = foreignProfile.id;

  const bank = await saveBankAccount(
    { bankName: "Bank Uji", accountNumber: "1234567890", accountHolder: "PT CreaInvoice Studio" },
    ownerCtx(),
  );
  bankId = bank.id;
  const foreignBank = await saveBankAccount(
    { bankName: "Bank Asing", accountNumber: "0987654321", accountHolder: "PT Asing" },
    ownerCtx(otherOrg.id),
  );
  foreignBankId = foreignBank.id;

  const signer = await saveSigner({ name: "CreaInvoice Studio", title: "Direktur" }, ownerCtx());
  signerId = signer.id;
  const foreignSigner = await saveSigner(
    { name: "Petani Asing", title: "Direktur" },
    ownerCtx(otherOrg.id),
  );
  foreignSignerId = foreignSigner.id;

  const customer = await createCustomer(
    {
      companyName: "PT Lifecycle Nusantara",
      legalName: "PT Lifecycle Nusantara",
      businessType: "Dagang",
      taxId: "01.2345.6789.000002",
      address: "Jl. Lifecycle No. 1",
      city: "Jakarta Pusat",
      province: "DKI Jakarta",
      postalCode: "10110",
      country: "Indonesia",
      phone: "0215550188",
      whatsapp: "",
      email: "halo@lifecycle.co.id",
      isActive: true,
    },
    ownerCtx(),
  );
  customerId = customer.id;
  const foreignCustomer = await createCustomer(
    {
      companyName: "PT Asing Nusantara",
      legalName: "PT Asing Nusantara",
      businessType: "Jasa",
      taxId: "02.9876.5432.000009",
      address: "Jl. Asing No. 99",
      city: "Bandung",
      province: "Jawa Barat",
      postalCode: "40111",
      country: "Indonesia",
      phone: "0225550199",
      whatsapp: "",
      email: "halo@asing.co.id",
      isActive: true,
    },
    ownerCtx(otherOrg.id),
  );
  foreignCustomerId = foreignCustomer.id;

  // Kept invoice-free so a zero billed sum is provable (not coincidental).
  const isolationProject = await createProject(
    {
      customerId,
      referenceType: "PURCHASE_ORDER",
      referenceNumber: "PO-EDGE-ISOL",
      title: "Proyek Isolasi",
      workValue: "4500000",
      currency: "IDR",
    },
    ownerCtx(),
  );
  isolationProjectId = isolationProject.id;
}, 60_000);

// ─── PARTIALLY_PAID gates ─────────────────────────────────────────────────

describe("PARTIALLY_PAID lifecycle gates", () => {
  it("cancels a PARTIALLY_PAID invoice and removes it from billedToDate", async () => {
    const project = await createProject(
      { customerId, referenceType: "PURCHASE_ORDER", referenceNumber: "PO-PP-001",
        title: "Proyek PP", workValue: "4500000", currency: "IDR" }, ownerCtx(),
    );
    const draft = await createDraft(draftInput({ projectReferenceId: project.id }), ownerCtx());
    await issueInvoice(draft.id, ownerCtx());

    // Feature 07 lands payments; reach PARTIALLY_PAID directly on the row so
    // the cancel gate can be exercised on a status between ISSUED and PAID.
    await db.invoice.update({
      where: { id: draft.id },
      data: { status: "PARTIALLY_PAID", remainingAfter: "1000000" },
    });
    expect((await db.invoice.findUnique({ where: { id: draft.id } }))!.status).toBe(
      "PARTIALLY_PAID",
    );

    // A FULL invoice at 5 × 900.000 bills the whole work value.
    const before = await getProjectBilling(project.id, ownerCtx());
    expect(before.billedToDate).toBe("4500000.00");

    const outcome = await cancelInvoice(draft.id, "Hanya sebagian yang lunas", ownerCtx());
    expect(outcome.status).toBe("CANCELLED");

    const row = await db.invoice.findUnique({ where: { id: draft.id } });
    expect(row!.status).toBe("CANCELLED");
    expect(row!.cancelledAt).not.toBeNull();
    expect(row!.cancellationReason).toBe("Hanya sebagian yang lunas");

    // CANCELLED drops out of BILLED_STATUSES → billedToDate returns to 0.
    const after = await getProjectBilling(project.id, ownerCtx());
    expect(after.billedToDate).toBe("0.00");
    expect(after.invoiceCount).toBe(0);
  });

  it("revises a PARTIALLY_PAID invoice: copy inherits billingPercent and recalculates", async () => {
    const project = await createProject(
      { customerId, referenceType: "PURCHASE_ORDER", referenceNumber: "PO-REV-001",
        title: "Proyek Revisi", workValue: "4500000", currency: "IDR" }, ownerCtx(),
    );
    const original = await createDraft(
      draftInput({
        projectReferenceId: project.id,
        invoiceType: "DOWN_PAYMENT",
        billingPercent: "50",
      }),
      ownerCtx(),
    );
    await issueInvoice(original.id, ownerCtx());
    await db.invoice.update({
      where: { id: original.id },
      data: { status: "PARTIALLY_PAID", remainingAfter: "500000" },
    });

    const revision = await createRevision(original.id, ownerCtx());

    const oldRow = await db.invoice.findUnique({ where: { id: original.id } });
    expect(oldRow!.status).toBe("REVISED");
    expect(oldRow!.replacedById).toBe(revision.draftId);

    const copy = await getDraft(revision.draftId, ownerCtx());
    expect(copy.status).toBe("DRAFT");
    // The copy inherits the original's billing shape and recalculates against
    // the fresh billed context — it does not keep stale numbers.
    expect(copy.billingPercent).toBe("50");
    expect(copy.calc.grandTotal).toBe("2250000.00");
    expect(copy.calc.billingBase).toBe("2250000.00");
    // The original is excluded (it is about to become REVISED and counts for
    // nothing), so the copy starts from a clean previouslyBilled.
    expect(copy.previouslyBilled.toString()).toBe("0");
  });
});

// ─── Cancel gates ─────────────────────────────────────────────────────────

describe("cancel gates", () => {
  it("rejects a second cancel ('sudah pernah dibatalkan')", async () => {
    const project = await createProject(
      { customerId, referenceType: "PURCHASE_ORDER", referenceNumber: "PO-DBL-001",
        title: "Proyek Double Cancel", workValue: "4500000", currency: "IDR" }, ownerCtx(),
    );
    const draft = await createDraft(draftInput({ projectReferenceId: project.id }), ownerCtx());
    await issueInvoice(draft.id, ownerCtx());
    await cancelInvoice(draft.id, "Pembatalan pertama", ownerCtx());

    const failure = await expectAppFailure(
      cancelInvoice(draft.id, "Pembatalan kedua", ownerCtx()),
      "LOCKED",
    );
    expect(failure.message).toBe("Invoice sudah pernah dibatalkan.");
    // Nothing changed through the forbidden path.
    expect(((await db.invoice.findUnique({ where: { id: draft.id } }))!).status).toBe("CANCELLED");
  });

  it("rejects cancelling an already-REVISED original ('sudah digantikan revisi')", async () => {
    const project = await createProject(
      { customerId, referenceType: "PURCHASE_ORDER", referenceNumber: "PO-REVX-001",
        title: "Proyek Revised", workValue: "4500000", currency: "IDR" }, ownerCtx(),
    );
    const original = await createDraft(draftInput({ projectReferenceId: project.id }), ownerCtx());
    await issueInvoice(original.id, ownerCtx());
    await createRevision(original.id, ownerCtx());

    const failure = await expectAppFailure(
      cancelInvoice(original.id, "Ganti dengan revisi", ownerCtx()),
      "LOCKED",
    );
    expect(failure.message).toBe("Invoice sudah digantikan revisi dan tidak dapat dibatalkan.");
    expect(((await db.invoice.findUnique({ where: { id: original.id } }))!).status).toBe("REVISED");
  });
});

// ─── markSent boundaries ──────────────────────────────────────────────────

describe("markSent boundaries", () => {
  it("rejects markSent on SENT, PAID, CANCELLED and DRAFT with distinct messages", async () => {
    // SENT — already marked, idempotent rejection.
    const sentProject = await createProject(
      { customerId, referenceType: "PURCHASE_ORDER", referenceNumber: "PO-SENT-001",
        title: "Proyek Sent", workValue: "4500000", currency: "IDR" }, ownerCtx(),
    );
    const sentDraft = await createDraft(draftInput({ projectReferenceId: sentProject.id }), ownerCtx());
    await issueInvoice(sentDraft.id, ownerCtx());
    await markSent(sentDraft.id, ownerCtx());
    const sentFailure = await expectAppFailure(markSent(sentDraft.id, ownerCtx()), "LOCKED");
    expect(sentFailure.message).toBe("Invoice sudah ditandai terkirim.");

    // DRAFT — must be published first.
    const draftProject = await createProject(
      { customerId, referenceType: "PURCHASE_ORDER", referenceNumber: "PO-DRAFT-001",
        title: "Proyek Draft", workValue: "4500000", currency: "IDR" }, ownerCtx(),
    );
    const plainDraft = await createDraft(draftInput({ projectReferenceId: draftProject.id }), ownerCtx());
    const draftFailure = await expectAppFailure(markSent(plainDraft.id, ownerCtx()), "LOCKED");
    expect(draftFailure.message).toBe("Invoice belum diterbitkan — terbitkan dulu.");

    // PAID — no longer a publishable document.
    const paidProject = await createProject(
      { customerId, referenceType: "PURCHASE_ORDER", referenceNumber: "PO-PAID-001",
        title: "Proyek Paid", workValue: "4500000", currency: "IDR" }, ownerCtx(),
    );
    const paidDraft = await createDraft(draftInput({ projectReferenceId: paidProject.id }), ownerCtx());
    await issueInvoice(paidDraft.id, ownerCtx());
    await db.invoice.update({ where: { id: paidDraft.id }, data: { status: "PAID", remainingAfter: "0" } });
    const paidFailure = await expectAppFailure(markSent(paidDraft.id, ownerCtx()), "LOCKED");
    expect(paidFailure.message).toBe("Hanya invoice terbit yang bisa ditandai terkirim.");

    // CANCELLED — no longer a publishable document.
    const cancelledProject = await createProject(
      { customerId, referenceType: "PURCHASE_ORDER", referenceNumber: "PO-CXL-001",
        title: "Proyek Cancel", workValue: "4500000", currency: "IDR" }, ownerCtx(),
    );
    const cancelledDraft = await createDraft(
      draftInput({ projectReferenceId: cancelledProject.id }),
      ownerCtx(),
    );
    await issueInvoice(cancelledDraft.id, ownerCtx());
    await cancelInvoice(cancelledDraft.id, "Salah kirim", ownerCtx());
    const cancelledFailure = await expectAppFailure(
      markSent(cancelledDraft.id, ownerCtx()),
      "LOCKED",
    );
    expect(cancelledFailure.message).toBe("Hanya invoice terbit yang bisa ditandai terkirim.");
  });
});

// ─── ADMIN role ───────────────────────────────────────────────────────────

describe("ADMIN role", () => {
  it("ADMIN can issue, mark sent, cancel and revise", async () => {
    const project = await createProject(
      { customerId, referenceType: "PURCHASE_ORDER", referenceNumber: "PO-ADMIN-001",
        title: "Proyek Admin", workValue: "4500000", currency: "IDR" }, ownerCtx(),
    );
    const draft = await createDraft(draftInput({ projectReferenceId: project.id }), adminCtx());
    const issued = await issueInvoice(draft.id, adminCtx());
    expect(issued.number).toMatch(/^INV\/SB\/VII\/2026\/\d{3}$/);

    const sent = await markSent(draft.id, adminCtx());
    expect(sent.status).toBe("SENT");

    const fresh = await createDraft(draftInput({ projectReferenceId: project.id }), adminCtx());
    await issueInvoice(fresh.id, adminCtx());
    const cancelled = await cancelInvoice(fresh.id, "Dibatalkan admin", adminCtx());
    expect(cancelled.status).toBe("CANCELLED");

    const original = await createDraft(draftInput({ projectReferenceId: project.id }), adminCtx());
    await issueInvoice(original.id, adminCtx());
    const revision = await createRevision(original.id, adminCtx());
    expect(revision.originalId).toBe(original.id);

    // Flat workspace (Change 6): every workspace action is granted to any
    // verified member — the old ADMIN/OWNER exclusivity is gone.
    for (const action of [
      "invoice.view",
      "invoice.download",
      "invoice.preview",
      "invoice.export",
      "invoice.issue",
      "invoice.markSent",
      "invoice.cancel",
      "invoice.revise",
      "invoice.draft.create",
      "invoice.draft.read",
      "invoice.draft.update",
      "invoice.draft.delete",
    ] as const) {
      expect(can(action, { organizationId: org.id, userId: owner.id }), action).toBe(true);
    }
  });

  it("ADMIN detail-view buttons are computed by can(), not by a hardcoded role", async () => {
    const project = await createProject(
      { customerId, referenceType: "PURCHASE_ORDER", referenceNumber: "PO-ADM2-001",
        title: "Proyek Admin 2", workValue: "4500000", currency: "IDR" }, ownerCtx(),
    );
    const draft = await createDraft(draftInput({ projectReferenceId: project.id }), adminCtx());
    await issueInvoice(draft.id, adminCtx());

    const detail = await getInvoiceDetail(draft.id, adminCtx());
    // Issue is gone forever once published; the other three are next steps.
    expect(detail.permissions.issue).toBe(false);
    expect(detail.permissions.markSent).toBe(true);
    expect(detail.permissions.cancel).toBe(true);
    expect(detail.permissions.revise).toBe(true);

    // And a draft still offers issue, while cancel/revise stay gated on status.
    const draftOnly = await createDraft(draftInput({ projectReferenceId: project.id }), adminCtx());
    const draftDetail = await getInvoiceDetail(draftOnly.id, adminCtx());
    expect(draftDetail.permissions.issue).toBe(true);
    expect(draftDetail.permissions.cancel).toBe(false);
    expect(draftDetail.permissions.revise).toBe(false);
  });

  it("no scope grants nothing (fail closed, flat workspace)", () => {
    // Change 6: there is no role string to fall back on — without a verified
    // organization scope, nothing is permitted.
    expect(can("invoice.view", {})).toBe(false);
    expect(can("invoice.cancel", { organizationId: org.id })).toBe(false);
    expect(can("payment.record", { userId: owner.id })).toBe(false);
  });
});

// ─── Org isolation: pdf + project billing ─────────────────────────────────

describe("org isolation on pdf and project billing", () => {
  it("getPdfJob answers 404 for a foreign invoice", async () => {
    const project = await createProject(
      { customerId, referenceType: "PURCHASE_ORDER", referenceNumber: "PO-FX-001",
        title: "Proyek Foreign Pdf", workValue: "4500000", currency: "IDR" }, ownerCtx(),
    );
    const draft = await createDraft(draftInput({ projectReferenceId: project.id }), ownerCtx());
    await issueInvoice(draft.id, ownerCtx());

    await expectAppFailure(getPdfJob(draft.id, foreignCtx()), "NOT_FOUND");
  });

  it("getPdfJob is null when no PDF job was ever queued (honest absence)", async () => {
    const project = await createProject(
      { customerId, referenceType: "PURCHASE_ORDER", referenceNumber: "PO-NOPDF-001",
        title: "Proyek No Pdf", workValue: "4500000", currency: "IDR" }, ownerCtx(),
    );
    const draft = await createDraft(draftInput({ projectReferenceId: project.id }), ownerCtx());
    const job = await getPdfJob(draft.id, ownerCtx());
    expect(job).toBeNull();
  });

  it("getProjectBilling answers 404 for a foreign project", async () => {
    const foreignProject = await createProject(
      { customerId: foreignCustomerId, referenceType: "PURCHASE_ORDER",
        referenceNumber: "PO-FX-002", title: "Proyek Foreign Billing", workValue: "4500000",
        currency: "IDR" }, ownerCtx(otherOrg.id),
    );
    await expectAppFailure(getProjectBilling(foreignProject.id, ownerCtx()), "NOT_FOUND");
  });

  it("billedToDate sums only own-org invoices (cross-org sums cannot bleed)", async () => {
    // A project that has never seen an invoice in this run stays at zero
    // regardless of billing activity in other organizations.
    const emptyBilling = await getProjectBilling(isolationProjectId, ownerCtx());
    expect(emptyBilling.billedToDate).toBe("0.00");
    expect(emptyBilling.invoiceCount).toBe(0);

    // Issue an invoice inside the foreign organization, linked to a foreign
    // project. It must count there and nowhere else.
    const foreignProject = await createProject(
      { customerId: foreignCustomerId, referenceType: "PURCHASE_ORDER",
        referenceNumber: "PO-FX-003", title: "Proyek Foreign Bleed", workValue: "4500000",
        currency: "IDR" }, ownerCtx(otherOrg.id),
    );
    const foreignDraft = await createDraft(
      {
        profileId: foreignProfileId,
        invoiceType: "DOWN_PAYMENT",
        billingPercent: "50",
        customerId: foreignCustomerId,
        billingMode: "PERCENT",
        invoiceDate: "2026-07-01",
        items: [
          { description: "Pemasangan bracket asing", quantity: "5", unit: "Unit", unitPrice: "900000" },
        ],
        projectReferenceId: foreignProject.id,
        bankAccountId: foreignBankId,
        signerId: foreignSignerId,
      } as InvoiceDraftFormOutput,
      ownerCtx(otherOrg.id),
    );
    await issueInvoice(foreignDraft.id, ownerCtx(otherOrg.id));

    const foreignBilling = await getProjectBilling(foreignProject.id, foreignCtx());
    expect(foreignBilling.billedToDate).toBe("2250000.00");
    expect(foreignBilling.invoiceCount).toBe(1);

    // Our own projects are untouched by foreign billing activity.
    const ourBilling = await getProjectBilling(isolationProjectId, ownerCtx());
    expect(ourBilling.billedToDate).toBe("0.00");
  });
});