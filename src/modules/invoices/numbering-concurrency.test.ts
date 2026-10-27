// src/modules/invoices/numbering-concurrency.test.ts
// Feature 05 Check When Done — "Concurrency test: 10 issue paralel di
// profile+bulan yang sama → 10 nomor unik (001–010), tidak ada duplikat,
// tidak ada invoice setengah jadi."
//
// This exercises the REAL issue transaction (SERIALIZABLE + InvoiceSequence
// row lock + bounded retry) end to end against the test database — the unit
// level for the numbering engine, the integration level for the database.

import { beforeAll, describe, expect, it } from "vitest";
import { createCustomer, type CustomerFormInput } from "@/modules/customers/service";
import { createProfile } from "@/modules/profiles/service";
import { createDraft, getDraft } from "@/modules/invoices/service";
import type { InvoiceDraftFormOutput } from "@/modules/invoices/schema";
import { issueInvoice } from "@/modules/invoices/issue-service";
import { db } from "@/tests/helpers/test-db";
import { ctxFor } from "@/tests/helpers/context";
import {
  addMembership,
  createOrganization,
  createUser,
  resetDatabase,
  type TestUser,
} from "../../../tests/factories";

let owner: TestUser;
let org: { id: string };
let profileId: string;
let customerId: string;

// Change 6: role tiers are gone — the context is flat (every member is admin).
function ownerCtx() {
  return ctxFor(org.id, owner.id);
}

function customerInput(): CustomerFormInput {
  return {
    companyName: "PT Uji Parallel Nusantara",
    legalName: "PT Uji Parallel Nusantara",
    businessType: "Dagang",
    taxId: "01.2345.6789.000001",
    address: "Jl. Uji Parallel No. 1",
    city: "Jakarta Pusat",
    province: "DKI Jakarta",
    postalCode: "10110",
    country: "Indonesia",
    phone: "0215550199",
    whatsapp: "",
    email: "halo@parallel.co.id",
    isActive: true,
  } as CustomerFormInput;
}

/** Minimal valid FULL draft — same payload shape the editor sends. */
function draftInput(seq: number): InvoiceDraftFormOutput {
  return {
    profileId,
    invoiceType: "FULL",
    customerId,
    billingMode: "PERCENT",
    invoiceDate: "2026-07-01",
    items: [
      {
        description: `Pekerjaan paralel #${seq}`,
        quantity: "1",
        unit: "Lot",
        unitPrice: "1000000",
      },
    ],
  } as InvoiceDraftFormOutput;
}

beforeAll(async () => {
  await resetDatabase();
  owner = await createUser({ username: "nc.owner" });
  org = await createOrganization("CreaInvoice Studio");
  await addMembership(owner.id, org.id, "OWNER");

  const profile = await createProfile(ownerCtx(), { name: "CreaInvoice Studio", code: "SB" });
  profileId = profile.id;
  const customer = await createCustomer(customerInput(), ownerCtx());
  customerId = customer.id;
}, 60_000);

describe("numbering concurrency — 10 parallel issues (Check When Done)", () => {
  it(
    "allocates INV/SB/VII/2026/001–010 exactly once each, no half-issued invoice",
    async () => {
      const COUNT = 10;
      const drafts = [];
      for (let i = 1; i <= COUNT; i += 1) {
        drafts.push(await createDraft(draftInput(i), ownerCtx()));
      }

      // Issue all ten at once — the transactions contend on the same
      // InvoiceSequence bucket ([profile, "2026"] under the default YEARLY
      // policy) and serialize on its row lock.
      const results = await Promise.all(
        drafts.map((draft) => issueInvoice(draft.id, ownerCtx())),
      );

      const numbers = results.map((result) => result.number);
      // Ten DISTINCT numbers...
      expect(new Set(numbers).size).toBe(COUNT);
      // ...each rendered from the real pattern, sequence 001..010.
      const expected = Array.from({ length: COUNT }, (_, index) =>
        `INV/SB/VII/2026/${String(index + 1).padStart(3, "0")}`,
      );
      expect([...numbers].sort()).toEqual(expected);

      // Nothing half-issued: every row is fully ISSUED with number, issuer,
      // issuedAt, snapshots and remainingAfter — and no draft is left over.
      const rows = await db.invoice.findMany({ where: { profileId } });
      expect(rows).toHaveLength(COUNT);
      expect(rows.every((row) => row.status === "ISSUED")).toBe(true);
      expect(rows.every((row) => row.number !== null)).toBe(true);
      expect(rows.every((row) => row.issuedAt !== null)).toBe(true);
      expect(rows.every((row) => row.issuedById === owner.id)).toBe(true);
      expect(rows.every((row) => row.issuerSnapshot !== null)).toBe(true);
      expect(rows.every((row) => row.customerSnapshot !== null)).toBe(true);
      expect(rows.every((row) => row.calculationSnapshot !== null)).toBe(true);
      expect(rows.every((row) => row.templateSnapshot !== null)).toBe(true);
      expect(
        rows.every((row) => row.remainingAfter.toString() === row.grandTotal.toString()),
      ).toBe(true);

      // The bucket counter matches the issued count — no lost or burned value.
      const bucket = await db.invoiceSequence.findFirst({
        where: { invoiceProfileId: profileId },
      });
      expect(bucket?.currentValue).toBe(COUNT);

      // Exactly one PdfJob per issued invoice, all honestly PENDING.
      const jobs = await db.pdfJob.findMany();
      expect(jobs).toHaveLength(COUNT);
      expect(jobs.every((job) => job.status === "PENDING")).toBe(true);

      // A draft read of any issued invoice now answers LOCKED (edit = revision).
      await expect(getDraft(drafts[0]!.id, ownerCtx())).rejects.toMatchObject({ code: "LOCKED" });
    },
    120_000,
  );
});
