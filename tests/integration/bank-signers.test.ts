// tests/integration/bank-signers.test.ts
// Feature 10 "Check When Done" at the service layer:
//   - bank CRUD multi-account + set default (exactly one default, profile sync)
//   - encryption at rest: raw row is ciphertext ≠ plaintext, last4 kept
//   - list payload is masked — the plaintext number never leaves the service
//   - detail reveals the full number only with bankAccount.update (VIEWER null)
//   - key rotation support: decrypt/encrypt roundtrip via the real key
//   - signer CRUD with signature upload (PNG, MIME sniff, 2 MB cap, replace+delete)
//   - VIEWER cannot CRUD; foreign ids answer NOT_FOUND (IDOR); audit rows
//     record created/updated/defaultChanged/deleted without any account number
//   - editor integration: org-scoped options, draft stores bankAccountId +
//     signerId, issue freezes bankSnapshot (FULL number) + signerSnapshot,
//     editing the bank afterwards never changes the issued snapshot
//   - token notes resolve in the detail view AND the print/PDF render path

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { isAppError, type AppError } from "@/lib/errors";
import { env } from "@/server/env";
import { createCustomer, type CustomerFormInput } from "@/modules/customers/service";
import { createProfile } from "@/modules/profiles/service";
import {
  createBankAccount,
  deleteBankAccount,
  getBankAccountDetail,
  listBankAccounts,
  listBankAccountsPage,
  setDefaultBankAccount,
  updateBankAccount,
} from "@/modules/bank-accounts/service";
import {
  createSigner,
  deleteSigner,
  getSignerDetail,
  listSignersPage,
  setDefaultSigner,
  updateSigner,
} from "@/modules/signers/service";
import { createDraft, getEditorOptions } from "@/modules/invoices/service";
import type { InvoiceDraftFormOutput } from "@/modules/invoices/schema";
import { issueInvoice } from "@/modules/invoices/issue-service";
import { getInvoiceDetail } from "@/modules/invoices/detail-service";
import { getPrintDocument } from "@/modules/invoices/print-document";
import { rendererDataFromIssued } from "@/components/invoice/renderer-data";
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
/** Bank account number of the org — must NEVER appear outside snapshot/detail. */
const ACCOUNT_NUMBER = "987654321098";

/** A real 1×1 PNG (magic bytes — this is what the sniffer judges). */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
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
    taxId: "02.3456.7890.000009",
    address: "Jl. Token No. 10",
    city: "Jakarta Pusat",
    province: "DKI Jakarta",
    postalCode: "10110",
    country: "Indonesia",
    phone: "0215550110",
    whatsapp: "",
    email: "tanda@token.co.id",
    isActive: true,
  };
}

/** DOWN_PAYMENT 50% of 5 × 900.000 → workValue Rp4.500.000, total Rp2.250.000. */
function draftInput(overrides: Partial<InvoiceDraftFormOutput> = {}): InvoiceDraftFormOutput {
  return {
    profileId,
    invoiceType: "DOWN_PAYMENT",
    customerId,
    billingMode: "PERCENT",
    billingPercent: "50",
    invoiceDate: "2026-07-01",
    referenceType: "PURCHASE_ORDER",
    referenceNumber: "5198021181",
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

let bankAId: string;
let bankBId: string;
let signerAId: string;

beforeAll(async () => {
  await resetDatabase();
  owner = await createUser({ username: "bank.owner" });
  staff = await createUser({ username: "bank.staff" });
  viewer = await createUser({ username: "bank.viewer" });
  org = await createOrganization("CreaInvoice Studio");
  otherOrg = await createOrganization("Organisasi Lain");
  await addMembership(owner.id, org.id, "OWNER");
  await addMembership(staff.id, org.id, "STAFF");
  await addMembership(viewer.id, org.id, "VIEWER");
  await addMembership(owner.id, otherOrg.id, "OWNER");

  const profile = await createProfile(ownerCtx(), { name: "CreaInvoice Studio", code: "SB" });
  profileId = profile.id;
  customerId = (await createCustomer(customerInput("PT Token Nusantara"), ownerCtx())).id;
}, 60_000);

// ─── Bank CRUD, encryption, permissions ────────────────────────────────────

describe("bank account CRUD & encryption at rest (Check When Done)", () => {
  it("creates multi-account; the first becomes default, STAFF may create", async () => {
    const first = await createBankAccount(
      { bankName: "Bank Uji", accountNumber: ACCOUNT_NUMBER, accountHolder: "PT CreaInvoice Studio" },
      staffCtx(),
    );
    bankAId = first.id;
    expect(first.isDefault).toBe(true);
    expect(first.isActive).toBe(true);
    expect(first.accountNumberLast4).toBe(ACCOUNT_NUMBER.slice(-4));
    expect(first.currency).toBe("IDR");

    const second = await createBankAccount(
      {
        bankName: "Bank Kedua",
        bankCode: "B2",
        accountNumber: "111222333444",
        accountHolder: "PT CreaInvoice Studio",
        branch: "KCP Sudirman",
        isDefault: true,
      },
      ownerCtx(),
    );
    bankBId = second.id;
    expect(second.isDefault).toBe(true);

    // Exactly one default survives the second create.
    const defaults = await db.bankAccount.findMany({
      where: { organizationId: org.id, isDefault: true },
    });
    expect(defaults).toHaveLength(1);
    expect(defaults[0]!.id).toBe(bankBId);
  });

  it("stores ciphertext ≠ plaintext with last4 kept in the clear (raw DB)", async () => {
    const row = await db.bankAccount.findUnique({ where: { id: bankAId } });
    expect(row).not.toBeNull();
    expect(row!.accountNumberEncrypted).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
    expect(row!.accountNumberEncrypted).not.toContain(ACCOUNT_NUMBER);
    expect(row!.accountNumberLast4).toBe(ACCOUNT_NUMBER.slice(-4));
  });

  it("list views are masked — no plaintext number in any list payload", async () => {
    const page = await listBankAccountsPage(staffCtx());
    expect(page.rows.length).toBeGreaterThanOrEqual(2);
    expect(page.rows.some((row) => row.id === bankAId)).toBe(true);
    expect(page.rows.some((row) => row.id === bankBId)).toBe(true);

    const json = JSON.stringify(page.rows);
    expect(json).not.toContain(ACCOUNT_NUMBER);
    expect(json).not.toContain("111222333444");
    const rowA = page.rows.find((row) => row.id === bankAId)!;
    expect(rowA.maskedNumber).toContain("*");
    expect(rowA.maskedNumber.endsWith(ACCOUNT_NUMBER.slice(-4))).toBe(true);

    // Editor dropdown (active only) is masked the same way.
    const dropdown = await listBankAccounts(org.id);
    expect(JSON.stringify(dropdown)).not.toContain(ACCOUNT_NUMBER);
  });

  it("update: empty number keeps the stored ciphertext, a new number re-encrypts", async () => {
    const before = await db.bankAccount.findUnique({ where: { id: bankAId } });
    const renamed = await updateBankAccount(
      bankAId,
      {
        bankName: "Bank Uji Rename",
        accountNumber: "",
        accountHolder: "PT CreaInvoice Studio",
        isActive: true,
      },
      ownerCtx(),
    );
    expect(renamed.bankName).toBe("Bank Uji Rename");
    expect(renamed.accountNumberEncrypted).toBe(before!.accountNumberEncrypted);
    expect(renamed.accountNumberLast4).toBe(ACCOUNT_NUMBER.slice(-4));

    const changed = await updateBankAccount(
      bankAId,
      {
        bankName: "Bank Uji Rename",
        accountNumber: "999888777012",
        accountHolder: "PT CreaInvoice Studio",
        isActive: true,
      },
      ownerCtx(),
    );
    expect(changed.accountNumberEncrypted).not.toBe(before!.accountNumberEncrypted);
    expect(changed.accountNumberEncrypted).not.toContain("999888777012");
    expect(changed.accountNumberLast4).toBe("7012");

    // Put the original number back for the later snapshot assertions.
    await updateBankAccount(
      bankAId,
      {
        bankName: "Bank Uji",
        accountNumber: ACCOUNT_NUMBER,
        accountHolder: "PT CreaInvoice Studio",
        isActive: true,
      },
      ownerCtx(),
    );
  });

  it("set default: one default per org and the profile default follows", async () => {
    const result = await setDefaultBankAccount(bankAId, ownerCtx());
    expect(result.isDefault).toBe(true);

    const defaults = await db.bankAccount.findMany({
      where: { organizationId: org.id, isDefault: true },
    });
    expect(defaults).toHaveLength(1);
    expect(defaults[0]!.id).toBe(bankAId);

    // The editor prefills from the profile — it must not drift (feature 02 rule).
    const profile = await db.invoiceProfile.findUnique({ where: { id: profileId } });
    expect(profile!.defaultBankAccountId).toBe(bankAId);

    // Idempotent: setting the existing default changes nothing.
    await setDefaultBankAccount(bankAId, ownerCtx());
    expect(
      (await db.bankAccount.count({ where: { organizationId: org.id, isDefault: true } })),
    ).toBe(1);
  });

  it("detail reveals the full number only with permission (STAFF full, VIEWER masked)", async () => {
    const asStaff = await getBankAccountDetail(bankAId, staffCtx());
    expect(asStaff.accountNumber).toBe(ACCOUNT_NUMBER);

    const asViewer = await getBankAccountDetail(bankAId, viewerCtx());
    expect(asViewer.accountNumber).toBeNull();
    expect(asViewer.maskedNumber).toContain("*");
    // The masked list view a VIEWER receives never carries the plaintext either.
    expect(JSON.stringify(asViewer)).not.toContain(ACCOUNT_NUMBER);
  });

  it("pagination clamps an out-of-range page to the last page", async () => {
    const clamped = await listBankAccountsPage(ownerCtx(), { page: 99 });
    expect(clamped.page).toBe(clamped.pageCount);
    expect(clamped.page).toBeLessThanOrEqual(clamped.pageCount);
    expect(clamped.pageSize).toBe(20);
  });

  it("deletes hard; the profile default clears through the SetNull FK", async () => {
    // bankA is currently the default and the profile points at it.
    await deleteBankAccount(bankAId, ownerCtx());

    const row = await db.bankAccount.findUnique({ where: { id: bankAId } });
    expect(row).toBeNull();
    const profile = await db.invoiceProfile.findUnique({ where: { id: profileId } });
    expect(profile!.defaultBankAccountId).toBeNull();

    // Restore a default so the editor fixture keeps working.
    await setDefaultBankAccount(bankBId, ownerCtx());
  });

  it("audits created/updated/defaultChanged/deleted without any account number", async () => {
    const rows = await db.auditLog.findMany({
      where: { organizationId: org.id, entityType: "bankAccount" },
    });
    expect(rows.length).toBeGreaterThanOrEqual(6);
    expect(rows.every((row) => row.action === "PROFILE_CHANGED")).toBe(true);
    const changes = new Set(
      rows
        .map((row) => (row.metadata as { change?: string }).change)
        .filter((value): value is string => Boolean(value)),
    );
    for (const expected of ["created", "updated", "defaultChanged", "deleted"]) {
      expect(changes.has(expected)).toBe(true);
    }
    // Log sanitization: neither account number may appear in metadata.
    const metadata = JSON.stringify(rows.map((row) => row.metadata));
    expect(metadata).not.toContain(ACCOUNT_NUMBER);
    expect(metadata).not.toContain("111222333444");
    expect(metadata).not.toContain("999888777012");
  });
});

describe("bank permissions & org isolation (Check When Done)", () => {
  it("VIEWER can list masked but never create/update/delete/setDefault", async () => {
    const page = await listBankAccountsPage(viewerCtx());
    expect(page.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(page.rows)).not.toContain(ACCOUNT_NUMBER);

    await expectAppFailure(
      createBankAccount(
        { bankName: "Bank VIEWER", accountNumber: "555666777888", accountHolder: "X Y" },
        viewerCtx(),
      ),
      "FORBIDDEN",
    );
    await expectAppFailure(
      updateBankAccount(
        bankBId,
        { bankName: "Hacked", accountNumber: "", accountHolder: "X Y", isActive: true },
        viewerCtx(),
      ),
      "FORBIDDEN",
    );
    await expectAppFailure(deleteBankAccount(bankBId, viewerCtx()), "FORBIDDEN");
    await expectAppFailure(setDefaultBankAccount(bankBId, viewerCtx()), "FORBIDDEN");
  });

  it("foreign bank ids answer NOT_FOUND and lists stay org-scoped (IDOR)", async () => {
    const foreign = await createBankAccount(
      { bankName: "Bank Lain", accountNumber: "333444555666", accountHolder: "PT Lain" },
      ownerCtx(otherOrg.id),
    );

    await expectAppFailure(getBankAccountDetail(foreign.id, ownerCtx()), "NOT_FOUND");
    await expectAppFailure(
      updateBankAccount(
        foreign.id,
        { bankName: "Dicuri", accountNumber: "", accountHolder: "X Y", isActive: true },
        ownerCtx(),
      ),
      "NOT_FOUND",
    );
    await expectAppFailure(deleteBankAccount(foreign.id, ownerCtx()), "NOT_FOUND");
    await expectAppFailure(setDefaultBankAccount(foreign.id, ownerCtx()), "NOT_FOUND");

    const page = await listBankAccountsPage(ownerCtx());
    expect(page.rows.some((row) => row.id === foreign.id)).toBe(false);

    // Cleanup so the pagination count stays stable for the rest of the suite.
    await deleteBankAccount(foreign.id, ownerCtx(otherOrg.id));
  });
});

// ─── Signer CRUD & signature upload ────────────────────────────────────────

describe("signer CRUD & signature upload (Check When Done)", () => {
  it("creates with a PNG signature — sniffed content, stored under the org signature folder", async () => {
    const file = new File([PNG_BYTES], "tanda-tangan.png", { type: "image/png" });
    const signer = await createSigner(
      { name: "Andi Wijaya", title: "Direktur", location: "Yogyakarta" },
      staffCtx(),
      { signatureFile: file },
    );
    signerAId = signer.id;

    expect(signer.isDefault).toBe(true);
    expect(signer.signatureImagePath).not.toBeNull();
    expect(signer.signatureImagePath).toContain(`uploads/organizations/${org.id}/signature/`);
    expect(existsSync(resolve(env.STORAGE_ROOT, signer.signatureImagePath!))).toBe(true);
    // Random filename: the original name is never trusted.
    expect(signer.signatureImagePath).not.toContain("tanda-tangan");
  });

  it("rejects a fake MIME (text bytes named .png) and a file over 2 MB", async () => {
    const fake = new File([Buffer.from("ini bukan gambar, hanya teks")], "palsu.png", {
      type: "image/png",
    });
    await expectAppFailure(
      createSigner({ name: "Palsu" }, ownerCtx(), { signatureFile: fake }),
      "VALIDATION_ERROR",
    );

    const oversize = new File([new Uint8Array(2 * 1024 * 1024 + 1)], "besar.png", {
      type: "image/png",
    });
    await expectAppFailure(
      createSigner({ name: "Kebesaran" }, ownerCtx(), { signatureFile: oversize }),
      "VALIDATION_ERROR",
    );
  });

  it("update keeps the stored image when no file is sent, replaces+deletes when one is", async () => {
    const before = await db.signer.findUnique({ where: { id: signerAId } });
    const kept = await updateSigner(
      signerAId,
      { name: "Andi Wijaya", title: "Direktur Utama", location: "Yogyakarta", isActive: true },
      ownerCtx(),
    );
    expect(kept.signatureImagePath).toBe(before!.signatureImagePath);
    expect(kept.title).toBe("Direktur Utama");

    const replacement = new File([PNG_BYTES], "baru.png", { type: "image/png" });
    const replaced = await updateSigner(
      signerAId,
      { name: "Andi Wijaya", title: "Direktur Utama", location: "Yogyakarta", isActive: true },
      ownerCtx(),
      { signatureFile: replacement },
    );
    expect(replaced.signatureImagePath).not.toBe(before!.signatureImagePath);
    expect(existsSync(resolve(env.STORAGE_ROOT, replaced.signatureImagePath!))).toBe(true);
    expect(existsSync(resolve(env.STORAGE_ROOT, before!.signatureImagePath!))).toBe(false);
  });

  it("set default syncs the profile default", async () => {
    const second = await createSigner({ name: "Admin Keuangan", title: "Finance" }, ownerCtx());
    expect(second.isDefault).toBe(false); // signerA already claimed the default

    await setDefaultSigner(second.id, ownerCtx());
    const profile = await db.invoiceProfile.findUnique({ where: { id: profileId } });
    expect(profile!.defaultSignerId).toBe(second.id);
    const defaults = await db.signer.findMany({
      where: { organizationId: org.id, isDefault: true },
    });
    expect(defaults).toHaveLength(1);
    expect(defaults[0]!.id).toBe(second.id);

    // Restore signerA as the default and drop the extra row.
    await setDefaultSigner(signerAId, ownerCtx());
    await deleteSigner(second.id, ownerCtx());
  });

  it("VIEWER can read the lists but never mutate; foreign ids answer NOT_FOUND", async () => {
    const page = await listSignersPage(viewerCtx());
    expect(page.rows.length).toBeGreaterThan(0);

    await expectAppFailure(
      createSigner({ name: "Dari VIEWER" }, viewerCtx()),
      "FORBIDDEN",
    );
    await expectAppFailure(
      updateSigner(signerAId, { name: "Dicuri", isActive: true }, viewerCtx()),
      "FORBIDDEN",
    );
    await expectAppFailure(deleteSigner(signerAId, viewerCtx()), "FORBIDDEN");
    await expectAppFailure(setDefaultSigner(signerAId, viewerCtx()), "FORBIDDEN");

    const foreign = await createSigner({ name: "Penanda Lain" }, ownerCtx(otherOrg.id));
    await expectAppFailure(getSignerDetail(foreign.id, ownerCtx()), "NOT_FOUND");
    await expectAppFailure(
      updateSigner(foreign.id, { name: "Dicuri", isActive: true }, ownerCtx()),
      "NOT_FOUND",
    );
    await expectAppFailure(deleteSigner(foreign.id, ownerCtx()), "NOT_FOUND");

    const orgPage = await listSignersPage(ownerCtx());
    expect(orgPage.rows.some((row) => row.id === foreign.id)).toBe(false);
    await deleteSigner(foreign.id, ownerCtx(otherOrg.id));
  });

  it("deletes hard — row and image file are gone, audit rows carry no path secrets", async () => {
    const spare = await createSigner(
      { name: "Sementara" },
      ownerCtx(),
      { signatureFile: new File([PNG_BYTES], "sementara.png", { type: "image/png" }) },
    );
    const path = spare.signatureImagePath!;

    await deleteSigner(spare.id, ownerCtx());
    expect(await db.signer.findUnique({ where: { id: spare.id } })).toBeNull();
    expect(existsSync(resolve(env.STORAGE_ROOT, path))).toBe(false);

    const rows = await db.auditLog.findMany({
      where: { organizationId: org.id, entityType: "signer" },
    });
    expect(rows.length).toBeGreaterThanOrEqual(5);
    expect(rows.every((row) => row.action === "PROFILE_CHANGED")).toBe(true);
    const changes = new Set(
      rows
        .map((row) => (row.metadata as { change?: string }).change)
        .filter((value): value is string => Boolean(value)),
    );
    for (const expected of ["created", "updated", "defaultChanged", "deleted"]) {
      expect(changes.has(expected)).toBe(true);
    }
  });
});

// ─── Editor integration & snapshot immutability ────────────────────────────

describe("editor integration & snapshot (Check When Done)", () => {
  let issuedId: string;

  it("editor options are org-scoped and the draft stores bankAccountId + signerId", async () => {
    const options = await getEditorOptions(ownerCtx());
    expect(options.banks.some((bank) => bank.id === bankBId)).toBe(true);
    expect(options.signers.some((signer) => signer.id === signerAId)).toBe(true);
    // Foreign org rows never appear in the dropdowns.
    const foreignBank = await createBankAccount(
      { bankName: "Bank Luar", accountNumber: "777888999000", accountHolder: "PT Lain" },
      ownerCtx(otherOrg.id),
    );
    expect(options.banks.some((bank) => bank.id === foreignBank.id)).toBe(false);
    await deleteBankAccount(foreignBank.id, ownerCtx(otherOrg.id));

    const draft = await createDraft(
      draftInput({ bankAccountId: bankBId, signerId: signerAId }),
      ownerCtx(),
    );
    const row = await db.invoice.findUnique({ where: { id: draft.id } });
    expect(row!.bankAccountId).toBe(bankBId);
    expect(row!.signerId).toBe(signerAId);
    issuedId = draft.id;
  });

  it("rejects a foreign bank/signer id on the draft (org-scoped selection)", async () => {
    const foreignBank = await createBankAccount(
      { bankName: "Bank Luar 2", accountNumber: "777888999111", accountHolder: "PT Lain" },
      ownerCtx(otherOrg.id),
    );
    const foreignSigner = await createSigner({ name: "Penanda Lain 2" }, ownerCtx(otherOrg.id));

    await expectAppFailure(
      createDraft(draftInput({ bankAccountId: foreignBank.id }), ownerCtx()),
      "NOT_FOUND",
    );
    await expectAppFailure(
      createDraft(draftInput({ signerId: foreignSigner.id }), ownerCtx()),
      "NOT_FOUND",
    );

    await deleteBankAccount(foreignBank.id, ownerCtx(otherOrg.id));
    await deleteSigner(foreignSigner.id, ownerCtx(otherOrg.id));
  });

  it("issue freezes bankSnapshot with the FULL number + signerSnapshot", async () => {
    await issueInvoice(issuedId, ownerCtx());

    const row = await db.invoice.findUnique({ where: { id: issuedId } });
    const bankSnap = row!.bankSnapshot as {
      accountNumber?: string;
      maskedNumber: string;
      bankName: string;
    } | null;
    const signerSnap = row!.signerSnapshot as { signerId: string; name: string } | null;

    expect(bankSnap).not.toBeNull();
    // Spec 10: the invoice (snapshot) is where the real number lives. The
    // draft was linked to bank B, whose number is still 111222333444.
    expect(bankSnap!.accountNumber).toBe("111222333444");
    // …while the mask stays for summary cards and legacy rows.
    expect(bankSnap!.maskedNumber).toContain("*");
    expect(bankSnap!.maskedNumber).not.toBe("111222333444");
    expect(bankSnap!.bankName).toBe("Bank Kedua");

    expect(signerSnap).not.toBeNull();
    expect(signerSnap!.signerId).toBe(signerAId);
    expect(signerSnap!.name).toBe("Andi Wijaya");
  });

  it("the print/PDF source renders the full number, never the ciphertext", async () => {
    const source = await getPrintDocument(issuedId);
    expect(source.bank?.accountNumber).toBe("111222333444");
    const renderer = rendererDataFromIssued(source);
    expect(renderer.bank?.accountNumber).toBe("111222333444");
    const json = JSON.stringify(renderer);
    expect(json).not.toContain("accountNumberEncrypted");
    expect(json).not.toContain("iv:tag:ciphertext");
  });

  it("editing the bank afterwards never changes the issued snapshot", async () => {
    await updateBankAccount(
      bankBId,
      {
        bankName: "Bank Sesudah Edit",
        accountNumber: "555111222333",
        accountHolder: "PT Baru",
        isActive: true,
      },
      ownerCtx(),
    );

    const row = await db.invoice.findUnique({ where: { id: issuedId } });
    const bankSnap = row!.bankSnapshot as { accountNumber?: string; bankName: string } | null;
    expect(bankSnap!.bankName).toBe("Bank Kedua");
    expect(bankSnap!.accountNumber).toBe("111222333444");

    const source = await getPrintDocument(issuedId);
    expect(source.bank?.bankName).toBe("Bank Kedua");
    expect(source.bank?.accountNumber).toBe("111222333444");
  });
});

// ─── Token notes (Check When Done) ─────────────────────────────────────────

describe("token notes resolve at render (Check When Done)", () => {
  it("resolves all six tokens in the detail view with the spec's id-ID formats", async () => {
    const draft = await createDraft(
      draftInput({
        notes:
          "Penagihan Down Payment {BILLING_PERCENT} dari nilai PO sebesar {WORK_VALUE}. " +
          "Mohon cantumkan nomor PO {REFERENCE_NUMBER} pada berita transfer senilai {GRAND_TOTAL} " +
          "kepada {CUSTOMER_NAME} — invoice {INVOICE_NUMBER}.",
      }),
      ownerCtx(),
    );
    await issueInvoice(draft.id, ownerCtx());

    const detail = await getInvoiceDetail(draft.id, ownerCtx());
    expect(detail.amounts.workValue).toBe("4500000.00");
    expect(detail.amounts.grandTotal).toBe("2250000.00");
    expect(detail.notesDisplay).toBe(
      "Penagihan Down Payment 50% dari nilai PO sebesar Rp4.500.000. " +
        "Mohon cantumkan nomor PO 5198021181 pada berita transfer senilai Rp2.250.000 " +
        `kepada PT Token Nusantara — invoice ${detail.number}.`,
    );
    expect(detail.notesUnknownTokens).toEqual([]);
    // The stored value stays raw — only the display text resolves.
    expect(detail.notes).toContain("{INVOICE_NUMBER}");

    // The same values reach the print/PDF path (preview === print).
    const renderer = rendererDataFromIssued(await getPrintDocument(draft.id));
    expect(renderer.notes).toBe(detail.notesDisplay);
  });

  it("keeps unknown tokens literal and reports them for the preview warning", async () => {
    const draft = await createDraft(
      draftInput({ notes: "Halo {FOOBAR}, nomor {INVOICE_NUMBER} untuk {BAR_BAZ}." }),
      ownerCtx(),
    );
    const detail = await getInvoiceDetail(draft.id, ownerCtx());
    expect(detail.notesDisplay).toBe(
      `Halo {FOOBAR}, nomor ${detail.numberPreview} untuk {BAR_BAZ}.`,
    );
    expect(detail.notesUnknownTokens).toEqual(["FOOBAR", "BAR_BAZ"]);

    // A draft is never printable — the print/PDF path only serves issued rows.
    await expectAppFailure(getPrintDocument(draft.id), "NOT_FOUND");
  });

  it("resolves a known token with no value to an empty string", async () => {
    const detail = await getInvoiceDetail(
      (
        await createDraft(
          draftInput({
            referenceNumber: undefined,
            notes: "PO {REFERENCE_NUMBER} kosong; total {GRAND_TOTAL}.",
          }),
          ownerCtx(),
        )
      ).id,
      ownerCtx(),
    );
    expect(detail.referenceNumber).toBeNull();
    expect(detail.notesDisplay).toBe("PO  kosong; total Rp2.250.000.");
    expect(detail.notesUnknownTokens).toEqual([]);
  });
});
