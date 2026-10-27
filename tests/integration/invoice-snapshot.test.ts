// tests/integration/invoice-snapshot.test.ts
// Feature 05 invariant 4: the seven snapshots are the issued document.
//
// Existing coverage (invoice-lifecycle.test.ts) asserts that the columns
// are non-null and that profile/customer/bank edits after issue do not
// propagate. This file asserts the CONTENT of every snapshot — that each
// snapshot equals the live row at the instant of issue, that a profile or
// customer reassigned between createDraft and issue is captured at issue
// time, that contact/bank/signer absent-at-issue stay null forever, and that
// the calculation snapshot is the engine output for the rows that were
// actually issued (not the client's draft preview).
//
// This file shares one database with the other integration files, so every
// test creates its own project and asserts only against rows it created.

import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/tests/helpers/test-db";
import Decimal from "decimal.js";
import { calculateInvoice, type InvoiceCalcInput } from "@/modules/invoices/calculation";
import { createDraft, getDraft, updateDraft } from "@/modules/invoices/service";
import type { InvoiceDraftFormOutput } from "@/modules/invoices/schema";
import { issueInvoice } from "@/modules/invoices/issue-service";
import { getInvoiceDetail } from "@/modules/invoices/detail-service";
import { toBankAccountView } from "@/modules/bank-accounts/service";
import { createCustomer, updateCustomer } from "@/modules/customers/service";
import { createProfile, updateProfile } from "@/modules/profiles/service";
import { saveBankAccount } from "@/modules/bank-accounts/service";
import { saveSigner } from "@/modules/signers/service";
import { addContact, updateContact } from "@/modules/customers/service";
import { createProject } from "@/modules/projects/service";
import {
  addMembership,
  createOrganization,
  createUser,
  resetDatabase,
  type TestUser,
} from "../factories";
import { ctxFor } from "@/tests/helpers/context";

let owner: TestUser;
let org: { id: string };
let otherOrg: { id: string };
let profileId: string;
let otherProfileId: string;
let customerId: string;
let sameOrgOtherCustomerId: string;
let otherCustomerId: string;
let contactId: string;
let bankId: string;
let signerId: string;

function ctx() {
  return ctxFor(org.id, owner.id);
}
function otherCtx() {
  return ctxFor(otherOrg.id, owner.id);
}

async function issueDraft(input: InvoiceDraftFormOutput) {
  const draft = await createDraft(input, ctx());
  return { draft, outcome: await issueInvoice(draft.id, ctx()) };
}

function draftValues(overrides: Partial<InvoiceDraftFormOutput> = {}): InvoiceDraftFormOutput {
  return {
    profileId,
    customerId,
    customerContactId: contactId,
    bankAccountId: bankId,
    signerId,
    invoiceType: "FULL",
    billingMode: "PERCENT",
    invoiceDate: "2026-07-01",
    items: [
      { description: "Pemasangan bracket frame", quantity: "5", unit: "Unit", unitPrice: "900000", discountAmount: "0" },
      { description: "Ongkos pasang", quantity: "1", unit: "Lot", unitPrice: "250000", discountAmount: "0" },
    ],
    ...overrides,
  } as InvoiceDraftFormOutput;
}

beforeAll(async () => {
  await resetDatabase();

  owner = await createUser({ username: "snap.owner" });
  org = await createOrganization("CreaInvoice Studio");
  otherOrg = await createOrganization("Org Lain");
  await addMembership(owner.id, org.id, "OWNER");
  await addMembership(owner.id, otherOrg.id, "OWNER");

  const profile = await createProfile(ctx(), { name: "CreaInvoice Studio", code: "SB" });
  profileId = profile.id;
  const otherProfile = await createProfile(otherCtx(), { name: "Org Lain", code: "SL" });
  otherProfileId = otherProfile.id;

  const customer = await createCustomer(
    {
      companyName: "PT Snapshot Nusantara",
      legalName: "PT Snapshot Nusantara",
      businessType: "Dagang",
      taxId: "01.2345.6789.000003",
      address: "Jl. Snapshot No. 1",
      city: "Jakarta Pusat",
      province: "DKI Jakarta",
      postalCode: "10110",
      country: "Indonesia",
      phone: "0215550188",
      whatsapp: "",
      email: "halo@snapshot.co.id",
      isActive: true,
    },
    ctx(),
  );
  customerId = customer.id;
  const otherCustomer = await createCustomer(
    {
      companyName: "PT Snapshot Lain",
      legalName: "PT Snapshot Lain",
      businessType: "Jasa",
      taxId: "02.9876.5432.000004",
      address: "Jl. Snapshot Lain No. 9",
      city: "Bandung",
      province: "Jawa Barat",
      postalCode: "40111",
      country: "Indonesia",
      phone: "0225550199",
      whatsapp: "",
      email: "halo@lain.co.id",
      isActive: true,
    },
    otherCtx(),
  );
  otherCustomerId = otherCustomer.id;

  const sameOrgOtherCustomer = await createCustomer(
    {
      companyName: "PT Snapshot Sama Org",
      legalName: "PT Snapshot Sama Org",
      businessType: "Jasa",
      taxId: "04.5555.6666.000006",
      address: "Jl. Snapshot Sama No. 3",
      city: "Jakarta",
      province: "DKI Jakarta",
      postalCode: "10120",
      country: "Indonesia",
      phone: "0215550133",
      whatsapp: "",
      email: "halo@sama.co.id",
      isActive: true,
    },
    ctx(),
  );
  sameOrgOtherCustomerId = sameOrgOtherCustomer.id;

  const contact = await addContact(customerId, { name: "Andi Wijaya", title: "Procurement", division: "Purchasing", email: "andi@snapshot.co.id", phone: "08112345678", whatsapp: "" }, ctx());
  contactId = contact.id;

  const bank = await saveBankAccount(
    { bankName: "Bank Uji", accountNumber: "1234567890123456", accountHolder: "PT CreaInvoice Studio", branch: "KCP Sudirman" },
    ctx(),
  );
  bankId = bank.id;

  const signer = await saveSigner({ name: "CreaInvoice Studio", title: "Direktur", location: "Jakarta" }, ctx());
  signerId = signer.id;
}, 60_000);

// ─── Snapshot contents equal the live row at issue ────────────────────────

describe("snapshot contents", () => {
  it("issuer and customer snapshots freeze every field of the live row", async () => {
    const project = await createProject(
      { customerId, referenceType: "PURCHASE_ORDER", referenceNumber: "PO-SNAP-001",
        title: "Proyek Snapshot", workValue: "4750000", currency: "IDR" }, ctx(),
    );
    const { draft } = await issueDraft(draftValues({ projectReferenceId: project.id }));

    const issued = (await db.invoice.findUnique({ where: { id: draft.id } }))!;
    const profile = (await db.invoiceProfile.findUnique({ where: { id: profileId } }))!;
    const customer = (await db.customer.findUnique({ where: { id: customerId } }))!;
    const contact = (await db.customerContact.findUnique({ where: { id: contactId } }))!;
    const bank = (await db.bankAccount.findUnique({ where: { id: bankId } }))!;
    const signer = (await db.signer.findUnique({ where: { id: signerId } }))!;

    const issuerSnap = JSON.parse(JSON.stringify(issued.issuerSnapshot));
    const customerSnap = JSON.parse(JSON.stringify(issued.customerSnapshot));
    const contactSnap = JSON.parse(JSON.stringify(issued.contactSnapshot));
    const bankSnap = JSON.parse(JSON.stringify(issued.bankSnapshot));
    const signerSnap = JSON.parse(JSON.stringify(issued.signerSnapshot));

    // Issuer: every rendered field, and the rendering metadata (pattern/template).
    expect(issuerSnap.profileId).toBe(profileId);
    expect(issuerSnap.name).toBe(profile.name);
    expect(issuerSnap.legalName).toBe(profile.legalName);
    expect(issuerSnap.code).toBe(profile.code);
    expect(issuerSnap.logoPath).toBe(profile.logoPath);
    expect(issuerSnap.primaryColor).toBe(profile.primaryColor);
    expect(issuerSnap.address).toBe(profile.address);
    expect(issuerSnap.phone).toBe(profile.phone);
    expect(issuerSnap.whatsapp).toBe(profile.whatsapp);
    expect(issuerSnap.fax).toBe(profile.fax);
    expect(issuerSnap.email).toBe(profile.email);
    expect(issuerSnap.website).toBe(profile.website);
    expect(issuerSnap.taxId).toBe(profile.taxId);
    expect(issuerSnap.numberPattern).toBe(profile.numberPattern);
    expect(issuerSnap.templateKey).toBe(profile.templateKey);

    // Customer: PII that belongs in the document (never in audit metadata).
    expect(customerSnap.customerId).toBe(customerId);
    expect(customerSnap.companyName).toBe(customer.companyName);
    expect(customerSnap.legalName).toBe(customer.legalName);
    expect(customerSnap.businessType).toBe(customer.businessType);
    expect(customerSnap.taxId).toBe(customer.taxId);
    expect(customerSnap.address).toBe(customer.address);
    expect(customerSnap.city).toBe(customer.city);
    expect(customerSnap.province).toBe(customer.province);
    expect(customerSnap.postalCode).toBe(customer.postalCode);
    expect(customerSnap.country).toBe(customer.country);
    expect(customerSnap.phone).toBe(customer.phone);
    expect(customerSnap.whatsapp).toBe(customer.whatsapp);
    expect(customerSnap.email).toBe(customer.email);

    // PIC: the contact chosen at issue.
    expect(contactSnap).not.toBeNull();
    expect(contactSnap!.contactId).toBe(contactId);
    expect(contactSnap!.name).toBe(contact.name);
    expect(contactSnap!.title).toBe(contact.title);
    expect(contactSnap!.division).toBe(contact.division);
    expect(contactSnap!.email).toBe(contact.email);
    expect(contactSnap!.phone).toBe(contact.phone);
    expect(contactSnap!.whatsapp).toBe(contact.whatsapp);

    // Bank: masked form only — the encrypted number must never leave the module.
    const view = toBankAccountView(bank);
    expect(bankSnap).not.toBeNull();
    expect(bankSnap!.bankAccountId).toBe(view.id);
    expect(bankSnap!.bankName).toBe(view.bankName);
    expect(bankSnap!.bankCode).toBe(view.bankCode);
    expect(bankSnap!.accountHolder).toBe(view.accountHolder);
    expect(bankSnap!.branch).toBe(view.branch);
    expect(bankSnap!.currency).toBe(view.currency);
    expect(bankSnap!.maskedNumber).toBe(view.maskedNumber);
    expect(bankSnap!.last4).toBe(view.last4);
    expect(bankSnap!.maskedNumber).toContain("*");
    expect(bankSnap!.maskedNumber).not.toBe(bank.accountNumberEncrypted);

    // Signer.
    expect(signerSnap).not.toBeNull();
    expect(signerSnap!.signerId).toBe(signerId);
    expect(signerSnap!.name).toBe(signer.name);
    expect(signerSnap!.title).toBe(signer.title);
    expect(signerSnap!.location).toBe(signer.location);
    expect(signerSnap!.signaturePath).toBe(signer.signatureImagePath);
  });

  it("calculation snapshot is the engine output for the rows actually issued", async () => {
    const project = await createProject(
      { customerId, referenceType: "PURCHASE_ORDER", referenceNumber: "PO-SNAP-002",
        title: "Proyek Calc Snap", workValue: "4750000", currency: "IDR" }, ctx(),
    );
    const { draft } = await issueDraft(draftValues({ projectReferenceId: project.id }));
    const issued = (await db.invoice.findUnique({ where: { id: draft.id } }))!;
    const items = await db.invoiceItem.findMany({ where: { invoiceId: draft.id } });

    const calcSnap = JSON.parse(JSON.stringify(issued.calculationSnapshot));
    const row = (await db.invoice.findUnique({ where: { id: draft.id } }))!;

    // The snapshot is the frozen document numbers; they must equal the
    // persisted row and the engine output for the same rows.
    expect(calcSnap.invoiceType).toBe("FULL");
    expect(calcSnap.billingMode).toBe("PERCENT");
    expect(calcSnap.billingPercent).toBeNull();
    expect(calcSnap.billingAmount).toBeNull();
    // workValue is a Decimal(18,2) column, so it always renders with 2dp.
    expect(calcSnap.workValue).toBe(new Decimal(row.workValue).toFixed(2));
    expect(calcSnap.itemsSubtotal).toBe(new Decimal(row.itemsSubtotal).toFixed(2));
    expect(calcSnap.billingBase).toBe(new Decimal(row.billingBase).toFixed(2));
    expect(calcSnap.discountAmount).toBe(new Decimal(row.discountAmount).toFixed(2));
    expect(calcSnap.additionalAmount).toBe(new Decimal(row.additionalAmount).toFixed(2));
    expect(calcSnap.taxMode).toBe(row.taxMode);
    expect(calcSnap.taxPercent).toBe(row.taxPercent?.toString() ?? null);
    expect(calcSnap.taxAmount).toBe(new Decimal(row.taxAmount).toFixed(2));
    expect(calcSnap.roundingAmount).toBe(new Decimal(row.roundingAmount).toFixed(2));
    expect(calcSnap.grandTotal).toBe(new Decimal(row.grandTotal).toFixed(2));
    expect(calcSnap.remainingAfter).toBe(new Decimal(row.remainingAfter).toFixed(2));

    // previouslyBilled is computed at issue, not taken from the draft preview.
    expect(calcSnap.previouslyBilled).toBe(new Decimal(row.previouslyBilled).toFixed(2));

    // The nested `calc` is the engine output per line (toFixed(2) strings);
    // `items` mirrors the persisted rows, whose Decimal columns trim trailing
    // zeros — compare as equal values, not as identical strings.
    expect(calcSnap.calc.itemsSubtotal).toBe(
      new Decimal(calcSnap.itemsSubtotal).toFixed(2),
    );
    expect(calcSnap.calc.lineAmounts.length).toBe(items.length);
    for (let i = 0; i < items.length; i++) {
      expect(calcSnap.items[i].position).toBe(items[i].position);
      expect(calcSnap.items[i].description).toBe(items[i].description);
      expect(calcSnap.items[i].quantity).toBe(items[i].quantity.toString());
      expect(calcSnap.items[i].unit).toBe(items[i].unit);
      expect(calcSnap.items[i].unitPrice).toBe(items[i].unitPrice.toString());
      expect(calcSnap.items[i].discountAmount).toBe(items[i].discountAmount.toString());
      // Line amount = quantity × unitPrice − discount.
      const expected = new Decimal(items[i].quantity).mul(items[i].unitPrice)
        .minus(items[i].discountAmount).toFixed(2);
      expect(calcSnap.calc.lineAmounts[i]).toBe(expected);
      // The `items` mirror comes from the Decimal column, so it equals the
      // engine value when both are normalized.
      expect(new Decimal(calcSnap.items[i].lineAmount).toFixed(2)).toBe(expected);
    }
  });

  it("template snapshot freezes the rendering context of the issued document", async () => {
    const project = await createProject(
      { customerId, referenceType: "PURCHASE_ORDER", referenceNumber: "PO-SNAP-003",
        title: "Proyek Template Snap", workValue: "4750000", currency: "IDR" }, ctx(),
    );
    const { draft } = await issueDraft(draftValues({ projectReferenceId: project.id, stampMode: "NONE" }));
    const issued = (await db.invoice.findUnique({ where: { id: draft.id } }))!;
    const profile = (await db.invoiceProfile.findUnique({ where: { id: profileId } }))!;

    const templateSnap = JSON.parse(JSON.stringify(issued.templateSnapshot));
    expect(templateSnap.templateKey).toBe(profile.templateKey);
    expect(templateSnap.primaryColor).toBe(profile.primaryColor);
    expect(templateSnap.stampMode).toBe("NONE");
    expect(templateSnap.numberPattern).toBe(profile.numberPattern);

    // The detail view renders from the snapshot, not from the live row.
    const detail = await getInvoiceDetail(draft.id, ctx());
    expect(detail.template).toEqual(templateSnap);
    expect(detail.stampMode).toBe("NONE");
  });
});

// ─── Reassignment between draft and issue ─────────────────────────────────

describe("draft-to-issue reassignment", () => {
  it("captures the customer assigned at issue, not at createDraft", async () => {
    const project = await createProject(
      { customerId, referenceType: "PURCHASE_ORDER", referenceNumber: "PO-SNAP-004",
        title: "Proyek Reassign", workValue: "4750000", currency: "IDR" }, ctx(),
    );
    // Start a draft with customer A (and its PIC).
    const draft = await createDraft(draftValues({ projectReferenceId: project.id }), ctx());

    // Reassign to B (same organization — one invoice profile per org is the
    // product rule, so only the customer can be reassigned), drop the contact
    // from the wrong customer, then issue.
    await updateDraft(
      draft.id,
      draftValues({
        projectReferenceId: project.id,
        customerId: sameOrgOtherCustomerId,
        customerContactId: undefined,
        items: [
          { description: "Pemasangan bracket frame", quantity: "5", unit: "Unit", unitPrice: "900000", discountAmount: "0" },
          { description: "Ongkos pasang", quantity: "1", unit: "Lot", unitPrice: "250000", discountAmount: "0" },
          { description: "Biaya admin", quantity: "1", unit: "Lot", unitPrice: "100000", discountAmount: "0" },
        ],
      }),
      ctx(),
    );

    await issueInvoice(draft.id, ctx());
    const issued = (await db.invoice.findUnique({ where: { id: draft.id } }))!;

    const issuerSnap = JSON.parse(JSON.stringify(issued.issuerSnapshot));
    const customerSnap = JSON.parse(JSON.stringify(issued.customerSnapshot));
    // The profile does not change (one profile per org) but it is still
    // captured from the live row at issue.
    expect(issuerSnap.name).toBe("CreaInvoice Studio");
    expect(issuerSnap.code).toBe("SB");
    expect(customerSnap.companyName).toBe("PT Snapshot Sama Org");
    expect(customerSnap.taxId).toBe("04.5555.6666.000006");

    // The contact chosen at createDraft belonged to customer A; the
    // reassignment dropped it (customerContactId undefined), so the snapshot
    // contact is null — the issued document must not keep a PIC from the
    // wrong customer.
    expect(issued.contactSnapshot).toBeNull();

    // Recalculation against the new rows: 4.750.000 + 100.000 = 4.850.000.
    expect(new Decimal(issued.grandTotal).toFixed(2)).toBe("4850000.00");
    const detail = await getInvoiceDetail(draft.id, ctx());
    expect(detail.calc.grandTotal).toBe("4850000.00");
  });
});

// ─── Immutability after issue ─────────────────────────────────────────────

describe("immutability after issue", () => {
  // Only one invoice profile per organization is allowed, and the shared
  // masters (profile/customer/contact/bank/signer) are used by every test in
  // this file — so the suite mutates them and restores them afterwards.
  async function freezeEverything() {
    const project = await createProject(
      { customerId, referenceType: "PURCHASE_ORDER", referenceNumber: "PO-SNAP-005",
        title: "Proyek Immutability", workValue: "4750000", currency: "IDR" }, ctx(),
    );
    const { draft } = await issueDraft(draftValues({ projectReferenceId: project.id }));
    const detailBefore = await getInvoiceDetail(draft.id, ctx());
    return { draft, project, detailBefore };
  }

  async function restoreMasters() {
    await updateProfile(profileId, { name: "CreaInvoice Studio", address: null, primaryColor: "#2563eb" }, ctx());
    await updateCustomer(customerId, { companyName: "PT Snapshot Nusantara", address: "" }, ctx());
    await saveBankAccount(
      { bankName: "Bank Uji", accountNumber: "1234567890123456", accountHolder: "PT CreaInvoice Studio", branch: "KCP Sudirman" },
      ctx(),
    );
    await saveSigner({ name: "CreaInvoice Studio", title: "Direktur", location: "Jakarta" }, ctx());
    await updateContact(contactId, { name: "Andi Wijaya", title: "Procurement", division: "Purchasing", email: "andi@snapshot.co.id", phone: "08112345678", whatsapp: "" }, ctx());
  }

  it("issuer/customer/bank/signer/contact edits after issue never leak into the document", async () => {
    const { draft, detailBefore } = await freezeEverything();
    try {
      await updateProfile(profileId, { name: "CreaInvoice Studio Ubah", address: "Alamat BARU", primaryColor: "#ff0000" }, ctx());
      await updateCustomer(customerId, { companyName: "PT Snapshot Diubah", address: "Alamat BARU customer" }, ctx());
      await saveBankAccount(
        { bankName: "Bank Diubah", accountNumber: "9999999999999999", accountHolder: "PT Diubah", branch: "BARU" },
        ctx(),
      );
      await saveSigner({ name: "Andi Diubah", title: "Direktur BARU", location: "Bandung" }, ctx());
      await updateContact(contactId, { name: "Andi Diubah", title: "Manager BARU", division: "Divisi BARU", email: "andi@diubah.co.id" }, ctx());

      const detail = await getInvoiceDetail(draft.id, ctx());
      expect(detail.fromSnapshot).toBe(true);
      expect(detail.issuer.name).toBe(detailBefore.issuer.name);
      expect(detail.issuer.address).toBe(detailBefore.issuer.address);
      expect(detail.issuer.primaryColor).toBe(detailBefore.issuer.primaryColor);
      expect(detail.customer?.name).toBe(detailBefore.customer?.name);
      expect(detail.customer?.address).toBe(detailBefore.customer?.address);
      expect(detail.bank?.bankName).toBe(detailBefore.bank?.bankName);
      expect(detail.signer?.name).toBe(detailBefore.signer?.name);
      expect(detail.contact?.name).toBe(detailBefore.contact?.name);
      expect(detail.contact?.title).toBe(detailBefore.contact?.title);
      expect(detail.contact?.division).toBe(detailBefore.contact?.division);

      // The masters really did change — so the assertion above is meaningful.
      expect(((await db.invoiceProfile.findUnique({ where: { id: profileId } }))!).name).toBe("CreaInvoice Studio Ubah");
      expect(((await db.customer.findUnique({ where: { id: customerId } }))!).companyName).toBe("PT Snapshot Diubah");
    } finally {
      await restoreMasters();
    }
  });

  it("financial columns stay locked: no post-issue edit can change the document amounts", async () => {
    const { draft, detailBefore } = await freezeEverything();

    // The issued row is LOCKED; the only mutation path is a revision.
    await expect(
      getDraft(draft.id, ctx()),
    ).rejects.toThrow("Invoice yang sudah terbit tidak dapat diedit.");

    const detail = await getInvoiceDetail(draft.id, ctx());
    expect(detail.calc.grandTotal).toBe(detailBefore.calc.grandTotal);
    expect(detail.calc.billingBase).toBe(detailBefore.calc.billingBase);
    expect(detail.calc.previouslyBilled).toBe(detailBefore.calc.previouslyBilled);
    expect(detail.amounts.grandTotal).toBe(detailBefore.amounts.grandTotal);

    // The frozen numbers equal the persisted row (invariant 4 + 5).
    const row = (await db.invoice.findUnique({ where: { id: draft.id } }))!;
    expect(new Decimal(row.grandTotal).toFixed(2)).toBe(detailBefore.calc.grandTotal);
    expect(new Decimal(row.previouslyBilled).toFixed(2)).toBe(detailBefore.calc.previouslyBilled);
  });
});

// ─── Absent-at-issue stays null forever (JsonNull semantics) ──────────────

describe("absent-at-issue snapshots", () => {
  it("an invoice issued without bank/signer/contact keeps null snapshots", async () => {
    const project = await createProject(
      { customerId, referenceType: "PURCHASE_ORDER", referenceNumber: "PO-SNAP-006",
        title: "Proyek Tanpa Bank", workValue: "4750000", currency: "IDR" }, ctx(),
    );
    const { draft } = await issueDraft(
      draftValues({
        projectReferenceId: project.id,
        customerContactId: undefined,
        bankAccountId: undefined,
        signerId: undefined,
      }),
    );

    const issued = (await db.invoice.findUnique({ where: { id: draft.id } }))!;
    expect(issued.bankSnapshot).toBeNull();
    expect(issued.signerSnapshot).toBeNull();
    expect(issued.contactSnapshot).toBeNull();

    // The detail view reports no bank/signer/PIC for the issued document.
    const detail = await getInvoiceDetail(draft.id, ctx());
    expect(detail.bank).toBeNull();
    expect(detail.signer).toBeNull();
    expect(detail.contact).toBeNull();
  });

  it("later-added bank/signer/contact never appear on the issued document", async () => {
    const project = await createProject(
      { customerId, referenceType: "PURCHASE_ORDER", referenceNumber: "PO-SNAP-007",
        title: "Proyek Added Later", workValue: "475000", currency: "IDR" }, ctx(),
    );
    const { draft } = await issueDraft(
      draftValues({
        projectReferenceId: project.id,
        customerContactId: undefined,
        bankAccountId: undefined,
        signerId: undefined,
      }),
    );

    // Add master data AFTER the document has been issued.
    const contact = await addContact(customerId, { name: "Contact Baru", title: "Staff Baru", division: "Divisi Baru", email: "baru@snapshot.co.id", phone: "", whatsapp: "" }, ctx());
    const newBank = await saveBankAccount(
      { bankName: "Bank Baru", accountNumber: "1122334455667788", accountHolder: "PT Baru", branch: "BARU" },
      ctx(),
    );
    const newSigner = await saveSigner({ name: "Penanda Tangan Baru", title: "Manager", location: "Surabaya" }, ctx());

    // And mutate the original master rows, so "the newest value" would
    // leak if the read path used live relations instead of the snapshot.
    await saveBankAccount(
      { bankName: "Bank Diubah Lagi", accountNumber: "9988776655443322", accountHolder: "PT Diubah Lagi" },
      ctx(),
    );
    await saveSigner({ name: "Andi Diubah Lagi", title: "Direktur", location: "Jakarta" }, ctx());
    await updateContact(contact.id, { name: "Contact Diubah" }, ctx());

    const detail = await getInvoiceDetail(draft.id, ctx());
    expect(detail.fromSnapshot).toBe(true);
    // Still null: a bank/signer/PIC that did not exist at issue time must
    // never silently appear on an issued document (that would be a post-issue
    // edit of the document itself).
    expect(detail.bank).toBeNull();
    expect(detail.signer).toBeNull();
    expect(detail.contact).toBeNull();

    // The detail view still renders the other frozen data.
    expect(detail.calc.grandTotal).toBe("4750000.00");
    expect(detail.issuer.name).toBe("CreaInvoice Studio");
  });
});

// ─── fromSnapshot and amountPaid ──────────────────────────────────────────

describe("detail view contract", () => {
  it("fromSnapshot is true only when issuer, customer and calculation are frozen", async () => {
    const project = await createProject(
      { customerId, referenceType: "PURCHASE_ORDER", referenceNumber: "PO-SNAP-008",
        title: "Proyek FromSnapshot", workValue: "4750000", currency: "IDR" }, ctx(),
    );
    const { draft } = await issueDraft(draftValues({ projectReferenceId: project.id }));
    const detail = await getInvoiceDetail(draft.id, ctx());
    expect(detail.fromSnapshot).toBe(true);
    expect(detail.status).toBe("ISSUED");
    expect(detail.displayStatus).toBe("ISSUED");
  });

  it("amountPaid comes from the live row (it is the payment dimension, feature 07)", async () => {
    const project = await createProject(
      { customerId, referenceType: "PURCHASE_ORDER", referenceNumber: "PO-SNAP-009",
        title: "Proyek AmountPaid", workValue: "4750000", currency: "IDR" }, ctx(),
    );
    const { draft } = await issueDraft(draftValues({ projectReferenceId: project.id }));

    await db.invoice.update({
      where: { id: draft.id },
      data: { status: "PARTIALLY_PAID", amountPaid: "2000000", remainingAfter: "2750000" },
    });

    const detail = await getInvoiceDetail(draft.id, ctx());
    // The snapshot keeps the issue-time amounts; amountPaid is read live.
    expect(detail.amounts.amountPaid).toBe("2000000");
    expect(detail.amounts.grandTotal).toBe("4750000.00");
    expect(detail.status).toBe("PARTIALLY_PAID");
  });
});