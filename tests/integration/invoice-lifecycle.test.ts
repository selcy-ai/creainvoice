// tests/integration/invoice-lifecycle.test.ts
// Feature 05 "Check When Done" at the service layer:
//   - issue flow end to end: ISSUED, final number INV/SB/VII/2026/001,
//     snapshots frozen, audit INVOICE_ISSUED, PdfJob PENDING
//   - issued invoice is LOCKED for getDraft/updateDraft (edit = revision)
//   - snapshot immutability: profile/customer/bank edits after issue never
//     change the issued document (detail reads the snapshots)
//   - cancel: mandatory reason, CANCELLED + audit, excluded from billed sums
//   - revision: original REVISED + replacedById, new draft revisedFromId with
//     copied items, previouslyBilled never double-counts the pair
//   - mark sent: ISSUED → SENT + audit
//   - OVERDUE on read: past due date shows OVERDUE, stored status untouched
//   - billedToDate: real numbers on the project (feature 03 placeholder gone)
//   - permissions: STAFF issues/marks sent, cannot cancel/revise; VIEWER none
//   - org isolation: issue/read of a foreign invoice answers 404

import { beforeAll, describe, expect, it } from "vitest";
import { isAppError, type AppError } from "@/lib/errors";
import {
  addContact,
  createCustomer,
  updateCustomer,
  type CustomerFormInput,
} from "@/modules/customers/service";
import { createProject, getProjectBilling, type ProjectFormInput } from "@/modules/projects/service";
import { createProfile, replaceLogo, updateProfile } from "@/modules/profiles/service";
import { saveBankAccount } from "@/modules/bank-accounts/service";
import { saveSigner } from "@/modules/signers/service";
import {
  createDraft,
  getDraft,
  updateDraft,
} from "@/modules/invoices/service";
import type { InvoiceDraftFormOutput } from "@/modules/invoices/schema";
import { issueInvoice } from "@/modules/invoices/issue-service";
import {
  cancelInvoice,
  createRevision,
  markSent,
} from "@/modules/invoices/lifecycle-service";
import { getInvoiceDetail } from "@/modules/invoices/detail-service";
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
let customerId: string;
let contactId: string;
let bankId: string;
let signerId: string;
let projectId: string; // P1 — DP + settlement + cancel story
let projectId2: string; // P2 — revision story
let foreignCustomerId: string;

/** The base issued invoice (first issue of the file → 001). */
let issuedId: string;


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

function customerInput(overrides: Partial<CustomerFormInput> = {}): CustomerFormInput {
  return {
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
    ...overrides,
  };
}

function projectInput(customerId: string, overrides: Partial<ProjectFormInput> = {}): ProjectFormInput {
  return {
    customerId,
    referenceType: "PURCHASE_ORDER",
    referenceNumber: `PO-LC-${Math.floor(Math.random() * 100000)}`,
    title: "Proyek Lifecycle",
    workValue: "4500000",
    currency: "IDR",
    ...overrides,
  };
}

/** Payload shape exactly as the editor sends it after Zod output. */
function draftInput(overrides: Partial<InvoiceDraftFormOutput> = {}): InvoiceDraftFormOutput {
  return {
    profileId,
    invoiceType: "FULL",
    customerId,
    billingMode: "PERCENT",
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

beforeAll(async () => {
  await resetDatabase();
  owner = await createUser({ username: "lc.owner" });
  staff = await createUser({ username: "lc.staff" });
  viewer = await createUser({ username: "lc.viewer" });
  org = await createOrganization("CreaInvoice Studio");
  otherOrg = await createOrganization("Organisasi Lain");
  await addMembership(owner.id, org.id, "OWNER");
  await addMembership(staff.id, org.id, "STAFF");
  await addMembership(viewer.id, org.id, "VIEWER");
  await addMembership(owner.id, otherOrg.id, "OWNER");

  const profile = await createProfile(ownerCtx(), { name: "CreaInvoice Studio", code: "SB" });
  profileId = profile.id;
  const foreignProfile = await createProfile(ownerCtx(otherOrg.id), {
    name: "Organisasi Lain",
    code: "OL",
  });
  foreignProfileId = foreignProfile.id;

  const bank = await saveBankAccount(
    {
      bankName: "Bank Uji",
      accountNumber: "1234567890",
      accountHolder: "PT CreaInvoice Studio",
    },
    ownerCtx(),
  );
  bankId = bank.id;
  const signer = await saveSigner({ name: "CreaInvoice Studio", title: "Direktur" }, ownerCtx());
  signerId = signer.id;

  const customer = await createCustomer(customerInput(), ownerCtx());
  customerId = customer.id;
  const contact = await addContact(customerId, { name: "Andi Wijaya", title: "Procurement" }, ownerCtx());
  contactId = contact.id;
  foreignCustomerId = (await createCustomer(customerInput(), ownerCtx(otherOrg.id))).id;

  const project = await createProject(projectInput(customerId), ownerCtx());
  projectId = project.id;
  const project2 = await createProject(
    projectInput(customerId, { title: "Proyek Revisi", workValue: "4500000" }),
    ownerCtx(),
  );
  projectId2 = project2.id;
}, 60_000);

// ─── Issue flow ───────────────────────────────────────────────────────────

describe("issue flow (Check When Done)", () => {
  it("issues a complete draft: ISSUED + final number + snapshots + audit + PdfJob", async () => {
    const draft = await createDraft(
      draftInput({
        invoiceType: "DOWN_PAYMENT",
        billingPercent: "50",
        projectReferenceId: projectId,
        customerContactId: contactId,
        bankAccountId: bankId,
        signerId,
      }),
      ownerCtx(),
    );
    issuedId = draft.id;

    const outcome = await issueInvoice(draft.id, ownerCtx());
    expect(outcome.number).toBe("INV/SB/VII/2026/001");
    expect(outcome.issuedAt).toBeTruthy();

    const row = await db.invoice.findUnique({ where: { id: draft.id } });
    expect(row).not.toBeNull();
    expect(row!.status).toBe("ISSUED");
    expect(row!.number).toBe("INV/SB/VII/2026/001");
    expect(row!.issuedAt).not.toBeNull();
    expect(row!.issuedById).toBe(owner.id);
    // Financial lock: outstanding equals the document total (spec step 6).
    expect(row!.remainingAfter.toString()).toBe(row!.grandTotal.toString());
    expect(Number(row!.grandTotal).toFixed(2)).toBe("2250000.00");
    // All seven snapshots frozen at issue.
    for (const column of [
      "issuerSnapshot",
      "customerSnapshot",
      "contactSnapshot",
      "bankSnapshot",
      "signerSnapshot",
      "calculationSnapshot",
      "templateSnapshot",
    ] as const) {
      expect(row![column], column).not.toBeNull();
    }

    // Audit + PDF job — the audit row lands inside the issue transaction.
    const audit = await db.auditLog.findFirst({
      where: { action: "INVOICE_ISSUED", entityId: draft.id },
    });
    expect(audit).not.toBeNull();
    expect(audit!.metadata).toMatchObject({ number: "INV/SB/VII/2026/001" });

    const jobs = await db.pdfJob.findMany({ where: { invoiceId: draft.id } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.status).toBe("PENDING"); // honest queue state — feature 06 runs it

    const detail = await getInvoiceDetail(draft.id, ownerCtx());
    expect(detail.status).toBe("ISSUED");
    expect(detail.displayStatus).toBe("ISSUED"); // no due date → not overdue
    expect(detail.fromSnapshot).toBe(true);
    expect(detail.number).toBe("INV/SB/VII/2026/001");
    expect(detail.calc.grandTotal).toBe("2250000.00");
    expect(detail.permissions.issue).toBe(false); // never again after issue
    expect(detail.permissions.edit).toBe(false);
  });

  it("refuses incomplete drafts (no items, zero billing base)", async () => {
    const noItems = await createDraft(draftInput({ items: [] }), ownerCtx());
    await expectAppFailure(issueInvoice(noItems.id, ownerCtx()), "VALIDATION_ERROR");

    const zeroValue = await createDraft(
      draftInput({
        items: [{ description: "Belum diharga", quantity: "1", unit: "Lot", unitPrice: "0" }],
      }),
      ownerCtx(),
    );
    const failure = await expectAppFailure(issueInvoice(zeroValue.id, ownerCtx()), "VALIDATION_ERROR");
    expect(failure.message).toMatch(/lebih dari 0/i);

    // Both rows are still plain drafts — nothing was issued half-ready.
    const rows = await db.invoice.findMany({
      where: { id: { in: [noItems.id, zeroValue.id] } },
    });
    expect(rows.every((row) => row.status === "DRAFT")).toBe(true);
    expect(rows.every((row) => row.number === null)).toBe(true);
  });

  it("locks an issued invoice for edits (LOCKED — route redirects to detail)", async () => {
    await expectAppFailure(getDraft(issuedId, ownerCtx()), "LOCKED");
    await expectAppFailure(
      updateDraft(issuedId, draftInput({ notes: "diedit diam-diam" }), ownerCtx()),
      "LOCKED",
    );
    const row = await db.invoice.findUnique({ where: { id: issuedId } });
    expect(row!.notes).toBeNull(); // nothing leaked through
  });

  it("answers 404 when a foreign session issues or reads the invoice (IDOR)", async () => {
    await expectAppFailure(issueInvoice(issuedId, ownerCtx(otherOrg.id)), "NOT_FOUND");
    await expectAppFailure(getInvoiceDetail(issuedId, ownerCtx(otherOrg.id)), "NOT_FOUND");

    const foreignDraft = await createDraft(
      draftInput({ profileId: foreignProfileId, customerId: foreignCustomerId }),
      ownerCtx(otherOrg.id),
    );
    // Our session cannot touch the foreign draft either.
    const foreignRow = await db.invoice.findUnique({ where: { id: foreignDraft.id } });
    await expectAppFailure(issueInvoice(foreignRow!.id, ownerCtx()), "NOT_FOUND");
  });
});

// ─── Snapshot immutability ────────────────────────────────────────────────

describe("snapshot immutability (Check When Done)", () => {
  it("profile edits after issue never change the issued document", async () => {
    const before = await getInvoiceDetail(issuedId, ownerCtx());
    expect(before.issuer.name).toBe("CreaInvoice Studio");
    expect(before.issuer.address).toBeNull();
    expect(before.issuer.logoPath).toBeNull();

    // Live master data really does change...
    await updateProfile(
      profileId,
      { name: "CreaInvoice Studio Baru", address: "Alamat BARU nomor 99" },
      ownerCtx(),
    );
    const oneByOnePng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    await replaceLogo(
      profileId,
      new File([oneByOnePng], "logo.png", { type: "image/png" }),
      ownerCtx(),
    );
    const liveProfile = await db.invoiceProfile.findUnique({ where: { id: profileId } });
    expect(liveProfile!.name).toBe("CreaInvoice Studio Baru");
    expect(liveProfile!.logoPath).not.toBeNull();

    // ...but the issued document still renders the frozen snapshot.
    const after = await getInvoiceDetail(issuedId, ownerCtx());
    expect(after.fromSnapshot).toBe(true);
    expect(after.issuer.name).toBe("CreaInvoice Studio");
    expect(after.issuer.address).toBeNull();
    expect(after.issuer.logoPath).toBeNull();
    expect(after.issuer.primaryColor).toBe(before.issuer.primaryColor);
  });

  it("customer and bank edits after issue never change the issued document", async () => {
    const before = await getInvoiceDetail(issuedId, ownerCtx());
    expect(before.customer?.address).toBe("Jl. Lifecycle No. 1");
    expect(before.bank?.bankName).toBe("Bank Uji");

    await updateCustomer(
      customerId,
      customerInput({ address: "Alamat CUSTOMER BARU 123", companyName: "PT Lifecycle Nusantara" }),
      ownerCtx(),
    );
    await saveBankAccount(
      { bankName: "Bank Baru", accountNumber: "", accountHolder: "PT CreaInvoice Studio" },
      ownerCtx(),
    );

    const liveCustomer = await db.customer.findUnique({ where: { id: customerId } });
    const liveBank = await db.bankAccount.findUnique({ where: { id: bankId } });
    expect(liveCustomer!.address).toBe("Alamat CUSTOMER BARU 123");
    expect(liveBank!.bankName).toBe("Bank Baru");

    const after = await getInvoiceDetail(issuedId, ownerCtx());
    expect(after.customer?.address).toBe("Jl. Lifecycle No. 1");
    expect(after.bank?.bankName).toBe("Bank Uji");
    // Masked form in the snapshot, never a plaintext number.
    expect(after.bank?.maskedNumber).toContain("*");
  });
});

// ─── billedToDate (project detail) ────────────────────────────────────────

describe("billedToDate on project (Check When Done)", () => {
  it("reports real numbers: issued DP counts, drafts/cancelled/revised never do", async () => {
    const billing = await getProjectBilling(projectId, ownerCtx());
    expect(billing.workValue).toBe("4500000"); // Decimal.toString() trims zeros
    expect(billing.billedToDate).toBe("2250000.00"); // the issued DP 50%
    expect(billing.remaining).toBe("2250000.00");
    expect(billing.invoiceCount).toBe(1);

    // A settlement draft is NOT billed yet (invariant 6)...
    const settlementDraft = await createDraft(
      draftInput({
        invoiceType: "SETTLEMENT",
        projectReferenceId: projectId,
        workValueOverride: true,
        workValueOverrideAmount: "4500000",
        workValueReason: "Pelunasan sisa project",
        items: [{ description: "Pelunasan termin akhir", quantity: "1", unit: "Lot", unitPrice: "0" }],
      }),
      ownerCtx(),
    );
    const draftView = await getDraft(settlementDraft.id, ownerCtx());
    // Prisma Decimal.toString() trims trailing zeros: "2250000.00" → "2250000".
    expect(draftView.previouslyBilled).toBe("2250000"); // counts the issued DP
    const still = await getProjectBilling(projectId, ownerCtx());
    expect(still.billedToDate).toBe("2250000.00");
    expect(still.invoiceCount).toBe(1);
  });
});

// ─── Mark sent ────────────────────────────────────────────────────────────

describe("mark sent (Check When Done)", () => {
  it("STAFF marks an issued invoice SENT with an audit row", async () => {
    const draft = await createDraft(draftInput(), staffCtx());
    await issueInvoice(draft.id, ownerCtx());

    const outcome = await markSent(draft.id, staffCtx());
    expect(outcome.status).toBe("SENT");
    const row = await db.invoice.findUnique({ where: { id: draft.id } });
    expect(row!.status).toBe("SENT");
    const audit = await db.auditLog.findFirst({
      where: { action: "INVOICE_SENT", entityId: draft.id },
    });
    expect(audit).not.toBeNull();

    // Idempotence is explicit: already sent / still draft → LOCKED.
    await expectAppFailure(markSent(draft.id, staffCtx()), "LOCKED");
    const freshDraft = await createDraft(draftInput(), staffCtx());
    await expectAppFailure(markSent(freshDraft.id, staffCtx()), "LOCKED");
  });
});

// ─── Cancel ───────────────────────────────────────────────────────────────

describe("cancel (Check When Done)", () => {
  it("requires a reason, then cancels with audit and drops out of the billed sum", async () => {
    const settlement = await createDraft(
      draftInput({
        invoiceType: "SETTLEMENT",
        projectReferenceId: projectId,
        workValueOverride: true,
        workValueOverrideAmount: "4500000",
        workValueReason: "Pelunasan sisa project",
        items: [{ description: "Pelunasan termin akhir", quantity: "1", unit: "Lot", unitPrice: "0" }],
      }),
      ownerCtx(),
    );
    await issueInvoice(settlement.id, ownerCtx());
    const beforeBilling = await getProjectBilling(projectId, ownerCtx());
    expect(beforeBilling.billedToDate).toBe("4500000.00"); // DP + settlement
    expect(beforeBilling.invoiceCount).toBe(2);

    // Reason mandatory (empty and whitespace both rejected) — nothing changed yet.
    const noReason = await expectAppFailure(cancelInvoice(settlement.id, "   ", ownerCtx()), "VALIDATION_ERROR");
    expect(noReason.message).toMatch(/alasan/i);
    expect((await db.invoice.findUnique({ where: { id: settlement.id } }))!.status).toBe("ISSUED");

    const cancelled = await cancelInvoice(settlement.id, "Salah kirim termin", ownerCtx());
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.cancellationReason).toBe("Salah kirim termin");

    const row = await db.invoice.findUnique({ where: { id: settlement.id } });
    expect(row!.status).toBe("CANCELLED");
    expect(row!.cancelledAt).not.toBeNull();
    expect(row!.cancellationReason).toBe("Salah kirim termin");

    const audit = await db.auditLog.findFirst({
      where: { action: "INVOICE_CANCELLED", entityId: settlement.id },
    });
    expect(audit).not.toBeNull();

    // Excluded from billed sums from now on (invariant 6).
    const afterBilling = await getProjectBilling(projectId, ownerCtx());
    expect(afterBilling.billedToDate).toBe("2250000.00");
    expect(afterBilling.invoiceCount).toBe(1);

    // A fresh settlement draft afterwards only counts the surviving invoice.
    const freshSettlement = await createDraft(
      draftInput({
        invoiceType: "SETTLEMENT",
        projectReferenceId: projectId,
        workValueOverride: true,
        workValueOverrideAmount: "4500000",
        workValueReason: "Pelunasan ulang",
        items: [{ description: "Pelunasan kedua", quantity: "1", unit: "Lot", unitPrice: "0" }],
      }),
      ownerCtx(),
    );
    const freshView = await getDraft(freshSettlement.id, ownerCtx());
    expect(freshView.previouslyBilled).toBe("2250000"); // cancelled not counted
    // Clean up the extra draft so later assertions see a stable world.
    await db.invoice.delete({ where: { id: freshSettlement.id } });
  });
});

// ─── Revision ─────────────────────────────────────────────────────────────

describe("revision (Check When Done)", () => {
  it("marks the original REVISED, links the replacement, and never double-counts", async () => {
    const original = await createDraft(draftInput({ projectReferenceId: projectId2 }), ownerCtx());
    await issueInvoice(original.id, ownerCtx());
    const beforeBilling = await getProjectBilling(projectId2, ownerCtx());
    expect(beforeBilling.billedToDate).toBe("4500000.00");
    expect(beforeBilling.invoiceCount).toBe(1);

    const revision = await createRevision(original.id, ownerCtx());

    // Original keeps every value — status + link only.
    const oldRow = await db.invoice.findUnique({ where: { id: original.id } });
    expect(oldRow!.status).toBe("REVISED");
    expect(oldRow!.replacedById).toBe(revision.draftId);
    // Number history intact — the old document keeps its allocated number.
    expect(oldRow!.number).toMatch(/^INV\/SB\/VII\/2026\/\d{3}$/);
    expect(Number(oldRow!.grandTotal).toFixed(2)).toBe("4500000.00");

    // The replacement is a normal draft carrying the relation + copied items.
    const copy = await getDraft(revision.draftId, ownerCtx());
    expect(copy.status).toBe("DRAFT");
    expect(copy.number).toBeNull();
    expect(copy.items).toHaveLength(1);
    expect(copy.items[0]!.description).toBe("Pemasangan bracket frame");
    expect(copy.items[0]!.unitPrice).toBe("900000");
    const copyRow = await db.invoice.findUnique({ where: { id: revision.draftId } });
    expect(copyRow!.revisedFromId).toBe(original.id);

    const audit = await db.auditLog.findFirst({
      where: { action: "INVOICE_REVISED", entityId: original.id },
    });
    expect(audit).not.toBeNull();

    // REVISED is excluded — the work is billed ONCE, never twice.
    const afterBilling = await getProjectBilling(projectId2, ownerCtx());
    expect(afterBilling.billedToDate).toBe("0.00");
    expect(afterBilling.invoiceCount).toBe(0);

    // The replacement's settlement context sees 0 previously billed (its own
    // project has no live invoice right now)…
    expect(copy.previouslyBilled).toBe("0");

    // …and once issued, the billed sum counts ONLY the replacement.
    await issueInvoice(revision.draftId, ownerCtx());
    const finalBilling = await getProjectBilling(projectId2, ownerCtx());
    expect(finalBilling.billedToDate).toBe("4500000.00"); // 4.500.000 — not 9.000.000
    expect(finalBilling.invoiceCount).toBe(1);

    // One revision per invoice.
    const failure = await expectAppFailure(createRevision(original.id, ownerCtx()), "CONFLICT");
    expect(failure.message).toMatch(/revisi/i);
  });
});

// ─── OVERDUE on read ──────────────────────────────────────────────────────

describe("OVERDUE on read (Check When Done)", () => {
  it("shows OVERDUE for a past-due issued invoice without touching the stored status", async () => {
    const draft = await createDraft(draftInput({ dueDate: "2026-07-15" }), ownerCtx());
    await issueInvoice(draft.id, ownerCtx());

    const detail = await getInvoiceDetail(draft.id, ownerCtx());
    expect(detail.displayStatus).toBe("OVERDUE");
    expect(detail.status).toBe("ISSUED"); // stored column untouched (sweep = feature 11)

    const row = await db.invoice.findUnique({ where: { id: draft.id } });
    expect(row!.status).toBe("ISSUED");

    // A PAID or cancelled invoice can never display as overdue — and an
    // invoice without a due date is never overdue (inv1 above proves it).
    const cancelledDetail = await getInvoiceDetail(issuedId, ownerCtx());
    expect(cancelledDetail.displayStatus).not.toBe("OVERDUE");
  });
});

// ─── Permissions & org isolation ──────────────────────────────────────────

describe("permissions (Check When Done)", () => {
  it("STAFF can issue, cannot cancel or revise", async () => {
    const draft = await createDraft(draftInput(), staffCtx());
    const outcome = await issueInvoice(draft.id, staffCtx());
    expect(outcome.number).toMatch(/^INV\/SB\/VII\/2026\/\d{3}$/);

    await expectAppFailure(cancelInvoice(draft.id, "alasan", staffCtx()), "FORBIDDEN");
    await expectAppFailure(createRevision(draft.id, staffCtx()), "FORBIDDEN");
    // Nothing changed through the forbidden paths.
    const row = await db.invoice.findUnique({ where: { id: draft.id } });
    expect(row!.status).toBe("ISSUED");
    expect(row!.cancelledAt).toBeNull();
    expect(row!.replacedById).toBeNull();
  });

  it("VIEWER can read the issued invoice but cannot issue, mark sent, cancel or revise", async () => {
    const detail = await getInvoiceDetail(issuedId, viewerCtx());
    expect(detail.number).toBe("INV/SB/VII/2026/001");
    expect(detail.permissions.issue).toBe(false);
    expect(detail.permissions.markSent).toBe(false);
    expect(detail.permissions.cancel).toBe(false);
    expect(detail.permissions.revise).toBe(false);

    const draft = await createDraft(draftInput(), ownerCtx());
    await expectAppFailure(issueInvoice(draft.id, viewerCtx()), "FORBIDDEN");
    await expectAppFailure(markSent(issuedId, viewerCtx()), "FORBIDDEN");
    await expectAppFailure(cancelInvoice(issuedId, "alasan", viewerCtx()), "FORBIDDEN");
    await expectAppFailure(createRevision(issuedId, viewerCtx()), "FORBIDDEN");
    await expectAppFailure(getDraft(draft.id, viewerCtx()), "FORBIDDEN");
  });
});

describe("org isolation (Check When Done)", () => {
  it("a session of another organization gets 404 for issue and read", async () => {
    const draft = await createDraft(draftInput(), ownerCtx());
    await expectAppFailure(issueInvoice(draft.id, ownerCtx(otherOrg.id)), "NOT_FOUND");
    await expectAppFailure(getInvoiceDetail(draft.id, ownerCtx(otherOrg.id)), "NOT_FOUND");
    await expectAppFailure(markSent(issuedId, ownerCtx(otherOrg.id)), "NOT_FOUND");
    await expectAppFailure(cancelInvoice(issuedId, "alasan", ownerCtx(otherOrg.id)), "NOT_FOUND");
    // Still a draft — the foreign session changed nothing.
    const row = await db.invoice.findUnique({ where: { id: draft.id } });
    expect(row!.status).toBe("DRAFT");
  });

  it("every allocated number is unique across the whole run", async () => {
    const rows = await db.invoice.findMany({
      where: { number: { not: null } },
      select: { number: true },
    });
    const numbers = rows.map((row) => row.number);
    expect(numbers.length).toBeGreaterThanOrEqual(6);
    expect(new Set(numbers).size).toBe(numbers.length);

    // All four feature-05 audit actions exist.
    for (const action of ["INVOICE_ISSUED", "INVOICE_SENT", "INVOICE_CANCELLED", "INVOICE_REVISED"] as const) {
      const count = await db.auditLog.count({ where: { action } });
      expect(count, action).toBeGreaterThan(0);
    }

    // Every issued invoice has exactly one PENDING PDF job (enqueue-only here).
    const issued = await db.invoice.findMany({ where: { status: { in: ["ISSUED", "SENT"] } } });
    for (const row of issued) {
      const jobs = await db.pdfJob.findMany({ where: { invoiceId: row.id } });
      expect(jobs.length, row.id).toBe(1);
      expect(jobs[0]!.status).toBe("PENDING");
    }
  });
});
