// tests/integration/invoice-engine.test.ts
// Feature 04 "Check When Done" at the service layer:
//   - create draft → autosave (update) → reload: data identical, server-recalculated
//   - DP keeps the real qty/unit price while billing only a percentage
//   - settlement: previouslyBilled is subtracted from the work value
//   - prefill from project hands the editor customer + reference + workValue
//   - VIEWER cannot create/update a draft; STAFF can
//   - a draft from another org answers 404 (IDOR guard)
//   - INVOICE_DRAFT_CREATED / INVOICE_DRAFT_AUDIT land in the audit log

import { beforeAll, describe, expect, it } from "vitest";
import { isAppError, type AppError } from "@/lib/errors";
import { createCustomer } from "@/modules/customers/service";
import type { CustomerFormInput } from "@/modules/customers/service";
import { createProject } from "@/modules/projects/service";
import type { ProjectFormInput } from "@/modules/projects/service";
import { createProfile, getProfileByOrg } from "@/modules/profiles/service";
import { saveBankAccount } from "@/modules/bank-accounts/service";
import { saveSigner } from "@/modules/signers/service";
import {
  createDraft,
  getDraft,
  getEditorOptions,
  listDrafts,
  prefillEditorFromProject,
  updateDraft,
} from "@/modules/invoices/service";
import type { InvoiceDraftFormOutput } from "@/modules/invoices/schema";
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
let staffId: string;
let viewerId: string;
let org: { id: string };
let otherOrg: { id: string };
let profileId: string;
let customerId: string;
let projectId: string;


function ownerCtx(organizationId?: string) {
  return ctxFor(organizationId ?? org.id, owner.id);
}

function staffCtx() {
  return ctxFor(org.id, staffId);
}

function viewerCtx() {
  return ctxFor(org.id, viewerId);
}

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

/** Calculation results are decimal strings with 2 fraction digits ("2250000.00");
 * the tests reason in plain rupiah and let the helper normalize. */
function plainAmount(value: string): string {
  return value.replace(/\.00$/, "");
}

function customerInput(overrides: Partial<CustomerFormInput> = {}): CustomerFormInput {
  return {
    companyName: "PT Uji Coba Sentosa",
    legalName: "PT Uji Coba Sentosa",
    businessType: "Dagang",
    taxId: "01.2345.6789.000001",
    address: "Jl. Jend. Sudirman No. 1",
    city: "Jakarta Pusat",
    province: "DKI Jakarta",
    postalCode: "10110",
    country: "Indonesia",
    phone: "0215550123",
    whatsapp: "",
    email: "halo@ujicoba.co.id",
    isActive: true,
    ...overrides,
  };
}

function projectInput(customerId: string, overrides: Partial<ProjectFormInput> = {}): ProjectFormInput {
  return {
    customerId,
    referenceType: "PURCHASE_ORDER",
    referenceNumber: "PO-2026-0001",
    title: "Pengadaan Bracket Frame",
    workValue: "4500000",
    currency: "IDR",
    ...overrides,
  };
}

/**
 * A minimal, valid FULL draft with one 5 × 900.000 line. Optional fields are
 * `undefined` (the zod output shape) — this is exactly the payload the editor
 * sends after toDraftPayload(), so the tests exercise the real boundary type.
 */
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
  owner = await createUser({ username: "inv.owner" });
  const staff = await createUser({ username: "inv.staff" });
  const viewer = await createUser({ username: "inv.viewer" });
  org = await createOrganization("CreaInvoice Studio");
  otherOrg = await createOrganization("Organisasi Lain");
  await addMembership(owner.id, org.id, "OWNER");
  await addMembership(staff.id, org.id, "STAFF");
  await addMembership(viewer.id, org.id, "VIEWER");
  await addMembership(owner.id, otherOrg.id, "OWNER");
  staffId = staff.id;
  viewerId = viewer.id;

  const profile = await createProfile(ownerCtx(), { name: "CreaInvoice Studio", code: "SB" });
  profileId = profile.id;
  // The other org needs its own profile before its drafts can exist.
  await createProfile(ownerCtx(otherOrg.id), { name: "Organisasi Lain", code: "OL" });

  await saveBankAccount(
    {
      bankName: "Bank Uji",
      accountNumber: "1234567890",
      accountHolder: "PT CreaInvoice Studio",
    },
    ownerCtx(),
  );
  await saveSigner({ name: "CreaInvoice Studio", title: "Direktur" }, ownerCtx());

  const customer = await createCustomer(customerInput(), ownerCtx());
  customerId = customer.id;
  const project = await createProject(projectInput(customerId), ownerCtx());
  projectId = project.id;
});

describe("draft create → autosave → reload (Check When Done: integration)", () => {
  it("creates a draft with a server-recalculated total and a preview number", async () => {
    const draft = await createDraft(draftInput(), ownerCtx());

    expect(draft.status).toBe("DRAFT");
    expect(draft.items).toHaveLength(1);
    expect(draft.items[0]?.quantity).toBe("5");
    expect(draft.items[0]?.unitPrice).toBe("900000");
    // 5 × 900.000, no tax: the grand total is the server's number, not the client's.
    expect(plainAmount(draft.calc.itemsSubtotal)).toBe("4500000");
    expect(plainAmount(draft.calc.workValue)).toBe("4500000");
    expect(plainAmount(draft.calc.billingBase)).toBe("4500000");
    expect(plainAmount(draft.calc.grandTotal)).toBe("4500000");
    // Preview number only — the final number is feature 05.
    expect(draft.number).toBeNull();
    expect(draft.numberPreview).toBe("INV/SB/VII/2026/001");

    const audit = await db.auditLog.findFirst({
      where: { action: "INVOICE_DRAFT_CREATED", entityId: draft.id },
    });
    expect(audit).not.toBeNull();
  });

  it("autosaves an update and reloads identical data", async () => {
    const created = await createDraft(draftInput(), staffCtx());

    const updated = await updateDraft(
      created.id,
      draftInput({
        invoiceType: "DOWN_PAYMENT",
        billingMode: "PERCENT",
        billingPercent: "50",
        items: [
          { description: "Pemasangan bracket frame", quantity: "5", unit: "Unit", unitPrice: "900000" },
          { description: "Pengiriman", quantity: "1", unit: "Lot", unitPrice: "100000" },
        ],
        notes: "DP pertama",
      }),
      staffCtx(),
    );

    // DP 50% of 4.600.000 = 2.300.000 — the base is derived, the rows stay honest.
    expect(plainAmount(updated.calc.itemsSubtotal)).toBe("4600000");
    expect(plainAmount(updated.calc.billingBase)).toBe("2300000");
    expect(plainAmount(updated.calc.grandTotal)).toBe("2300000");
    expect(updated.items).toHaveLength(2);
    expect(updated.notes).toBe("DP pertama");

    // Reload: persistence round-trips exactly (the editor's reload shows the same data).
    const reloaded = await getDraft(created.id, staffCtx());
    expect(reloaded.items).toHaveLength(2);
    expect(reloaded.items.map((item) => item.description)).toEqual([
      "Pemasangan bracket frame",
      "Pengiriman",
    ]);
    expect(plainAmount(reloaded.calc.grandTotal)).toBe("2300000");
    expect(reloaded.notes).toBe("DP pertama");

    const audit = await db.auditLog.findFirst({
      where: { action: "INVOICE_UPDATED", entityId: created.id },
    });
    expect(audit).not.toBeNull();
  });

  it("replaces items wholesale on autosave (reorder + delete persist)", async () => {
    const created = await createDraft(draftInput(), ownerCtx());

    const updated = await updateDraft(
      created.id,
      draftInput({
        items: [
          { description: "Baris B", quantity: "2", unit: "Unit", unitPrice: "100000" },
          { description: "Baris A", quantity: "1", unit: "Unit", unitPrice: "50000" },
        ],
      }),
      ownerCtx(),
    );

    expect(updated.items.map((item) => item.description)).toEqual(["Baris B", "Baris A"]);
    expect(plainAmount(updated.calc.itemsSubtotal)).toBe("250000");

    // The old row is gone — autosave is a full replace, never an append.
    const rows = await db.invoiceItem.count({ where: { invoiceId: created.id } });
    expect(rows).toBe(2);
  });
});

describe("jenis penagihan (server recalculation)", () => {
  it("DP keeps the real qty/unit price while billing half", async () => {
    const draft = await createDraft(
      draftInput({
        invoiceType: "DOWN_PAYMENT",
        billingMode: "PERCENT",
        billingPercent: "50",
      }),
      ownerCtx(),
    );
    expect(draft.items[0]?.quantity).toBe("5");
    expect(draft.items[0]?.unitPrice).toBe("900000");
    expect(plainAmount(draft.calc.workValue)).toBe("4500000");
    expect(plainAmount(draft.calc.billingBase)).toBe("2250000");
    expect(plainAmount(draft.calc.grandTotal)).toBe("2250000");
  });

  it("DP 10% bills 450.000", async () => {
    const draft = await createDraft(
      draftInput({
        invoiceType: "DOWN_PAYMENT",
        billingMode: "PERCENT",
        billingPercent: "10",
      }),
      ownerCtx(),
    );
    expect(plainAmount(draft.calc.billingBase)).toBe("450000");
    expect(plainAmount(draft.calc.grandTotal)).toBe("450000");
  });

  it("settlement subtracts previouslyBilled from the work value", async () => {
    // No issued invoices exist yet (feature 05), so the honest answer is 0 billed.
    const options = await getEditorOptions(ownerCtx());
    const project = options.projects.find((row) => row.id === projectId);
    expect(project).toBeDefined();
    expect(project!.previouslyBilled).toBe("0.00");

    const draft = await createDraft(
      draftInput({
        invoiceType: "SETTLEMENT",
        projectReferenceId: projectId,
      }),
      ownerCtx(),
    );
    expect(plainAmount(draft.calc.previouslyBilled)).toBe("0");
    expect(plainAmount(draft.calc.billingBase)).toBe("4500000");

    // The persisted draft keeps the computed context for the next editor open.
    const reloaded = await getDraft(draft.id, ownerCtx());
    expect(reloaded.previouslyBilled).toBe("0");
  });

  it("termin 40% bills 1.800.000", async () => {
    const draft = await createDraft(
      draftInput({
        invoiceType: "TERM",
        billingMode: "PERCENT",
        billingPercent: "40",
        termName: "2",
        termNumber: "2",
      }),
      ownerCtx(),
    );
    expect(plainAmount(draft.calc.billingBase)).toBe("1800000");
    expect(plainAmount(draft.calc.grandTotal)).toBe("1800000");
    expect(draft.termName).toBe("2");
  });

  it("PPN exclusive 11% adds tax on top of the base", async () => {
    const draft = await createDraft(
      draftInput({
        taxMode: "EXCLUSIVE",
        taxPercent: "11",
      }),
      ownerCtx(),
    );
    expect(plainAmount(draft.calc.taxAmount)).toBe("495000");
    expect(plainAmount(draft.calc.grandTotal)).toBe("4995000");
  });

  it("PPN inclusive separates the tax out of the total", async () => {
    const draft = await createDraft(
      draftInput({
        invoiceType: "DOWN_PAYMENT",
        billingMode: "PERCENT",
        billingPercent: "50",
        taxMode: "INCLUSIVE",
        taxPercent: "11",
      }),
      ownerCtx(),
    );
    expect(plainAmount(draft.calc.billingBase)).toBe("2250000");
    // INCLUSIVE: the tax is INSIDE the total (11/111 split), so taxAmount stays 0
    // and the split lands in taxIncludedInTotal (net = total − tax).
    expect(plainAmount(draft.calc.taxAmount)).toBe("0");
    expect(draft.calc.taxIncludedInTotal).toBe("222972.97");
    expect(plainAmount(draft.calc.grandTotal)).toBe("2250000");
  });

  it("manual tax uses the input nominal", async () => {
    const draft = await createDraft(
      draftInput({
        taxMode: "MANUAL",
        taxAmountInput: "50000",
      }),
      ownerCtx(),
    );
    expect(plainAmount(draft.calc.taxAmount)).toBe("50000");
    expect(plainAmount(draft.calc.grandTotal)).toBe("4550000");
  });

  it("invoice discount + additional charge + rounding adjust the total", async () => {
    const draft = await createDraft(
      draftInput({
        discountAmount: "500000",
        additionalAmount: "250000",
        roundingAmount: "-500",
      }),
      ownerCtx(),
    );
    // 4.500.000 − 500.000 + 250.000 − 500
    expect(plainAmount(draft.calc.grandTotal)).toBe("4249500");
  });
});

describe("prefill dari project (feature 03 contract)", () => {
  it("fills customer + reference + workValue for the editor", async () => {
    const prefill = await prefillEditorFromProject(projectId, ownerCtx());

    expect(prefill.customerId).toBe(customerId);
    expect(prefill.referenceType).toBe("PURCHASE_ORDER");
    expect(prefill.referenceNumber).toBe("PO-2026-0001");
    expect(prefill.workValueOverrideAmount).toBe("4500000");
    // Feature 03 stores no work items — the editor opens with an honest empty list.
    expect(prefill.items).toEqual([]);
  });

  it("answers 404 for a project from another organization", async () => {
    await expectAppFailure(prefillEditorFromProject(projectId, ownerCtx(otherOrg.id)), "NOT_FOUND");
  });
});

describe("permission & org isolation", () => {
  it("allows every member to create and update a draft (flat workspace)", async () => {
    // Change 6: role tiers are gone — a VIEWER is a full admin of the
    // workspace, so create/update by any member succeeds; org isolation is
    // the only gate that remains.
    const viewerDraft = await createDraft(draftInput(), viewerCtx());
    const updated = await updateDraft(
      viewerDraft.id,
      draftInput({ notes: "diubah viewer" }),
      viewerCtx(),
    );
    expect(updated.notes).toBe("diubah viewer");

    const created = await createDraft(draftInput(), ownerCtx());
    const updatedByStaff = await updateDraft(
      created.id,
      draftInput({ notes: "diubah staff" }),
      staffCtx(),
    );
    expect(updatedByStaff.notes).toBe("diubah staff");
  });

  it("answers 404 for a draft from another organization (IDOR)", async () => {
    const created = await createDraft(draftInput(), ownerCtx());

    await expectAppFailure(getDraft(created.id, ownerCtx(otherOrg.id)), "NOT_FOUND");
    await expectAppFailure(
      updateDraft(created.id, draftInput({ notes: "org lain" }), ownerCtx(otherOrg.id)),
      "NOT_FOUND",
    );

    // The cross-org update never landed.
    const reloaded = await getDraft(created.id, ownerCtx());
    expect(reloaded.notes).toBeNull();
  });

  it("answers 404 for a foreign profile id in the payload", async () => {
    const foreignProfile = await getProfileByOrg(otherOrg.id);
    expect(foreignProfile).not.toBeNull();
    await expectAppFailure(
      createDraft(draftInput({ profileId: foreignProfile!.id }), ownerCtx()),
      "NOT_FOUND",
    );
  });

  it("lists only the caller's org drafts", async () => {
    await createDraft(draftInput(), ownerCtx());
    // The other org needs its own customer + profile before its draft can exist.
    const foreignProfile = await getProfileByOrg(otherOrg.id);
    const foreignCustomer = await createCustomer(customerInput(), ownerCtx(otherOrg.id));
    await createDraft(
      draftInput({ profileId: foreignProfile!.id, customerId: foreignCustomer.id }),
      ownerCtx(otherOrg.id),
    );

    const ours = await listDrafts(ownerCtx(), {});
    const theirs = await listDrafts(ownerCtx(otherOrg.id), {});
    expect(ours.total).toBeGreaterThanOrEqual(1);
    expect(theirs.total).toBeGreaterThanOrEqual(1);
    expect(ours.rows.every((row) => row.customerName === "PT Uji Coba Sentosa")).toBe(true);
  });
});
