// tests/integration/auth-change14.test.ts — Change 14 regression guards.
//
// The Check When Done items that must be verified by running something:
//   • Register + onboarding: a new user finishes step 1 (org "PT Uji") and
//     both an `organizations` row and a `memberships` row exist; the
//     workspace scope resolves (the "organisasi tidak aktif" error cannot
//     happen anymore).
//   • Multi-tenant still works: 2 organizations, 1 invoice each, each
//     invoice is visible ONLY to its owning organization (feature 01
//     regression guard — the behavior that must NOT change).
//   • IDOR guard still works: an invoice owned by another organization
//     answers 404 (security-standards.md baris 20), never 200/leak.
//   • Password hashing: argon2 sign-up hash verifies, and login refuses a
//     wrong password (password contract for the self-hosted stack).
//
// Every request goes through the real service layer with a real better-auth
// session row (tests/helpers/auth signInFor), so the assertions exercise the
// same code path production uses after the Clerk removal.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { betterAuthSessionMock, signInFor } from "../helpers/auth";

vi.mock("next/headers", () => betterAuthSessionMock());

import { db } from "@/db/client";
import { memberships, organizations, users } from "@/db/schema";
import { createId } from "@/db/id";
import { eq } from "drizzle-orm";
import { createCustomer } from "@/modules/customers/service";
import type { CustomerFormInput } from "@/modules/customers/service";
import { createProfile } from "@/modules/profiles/service";
import { createDraft, getDraft } from "@/modules/invoices/service";
import { listInvoices } from "@/modules/invoices/query-service";
import type { InvoiceDraftFormOutput } from "@/modules/invoices/schema";
import { AppError } from "@/lib/errors";
import { ctxFor } from "@/tests/helpers/context";
import {
  addMembership,
  createOrganization,
  createUser,
  resetDatabase,
} from "../factories";
import { hashUserPassword, verifyUserPassword } from "@/lib/auth";

let ownerA: { id: string };
let ownerB: { id: string };
let orgA: { id: string };
let orgB: { id: string };
let profileA: string;
let profileB: string;
let customerA: string;
let customerB: string;
let invoiceA: string;
let invoiceB: string;

const customerInput = (companyName: string): CustomerFormInput => ({
  companyName,
  businessType: "Jasa",
  address: "Jl. Uji No. 1",
  city: "Jakarta",
  phone: "0215550123",
  email: "ap@example.test",
  isActive: true,
});

function draftInput(profileId: string, customerId: string): InvoiceDraftFormOutput {
  return {
    profileId,
    customerId,
    invoiceType: "FULL",
    invoiceDate: "2026-10-28",
    billingMode: "MANUAL",
    items: [
      {
        position: 1,
        description: "Pekerjaan uji",
        quantity: "1",
        unit: "Pcs",
        unitPrice: "1000000",
      },
    ],
    taxMode: "NONE",
    notes: null,
    footerText: null,
  } as unknown as InvoiceDraftFormOutput;
}

beforeAll(async () => {
  await resetDatabase();

  ownerA = await createUser({ email: `owner-a-${createId()}@test.local`, name: "Owner A" });
  ownerB = await createUser({ email: `owner-b-${createId()}@test.local`, name: "Owner B" });
  orgA = await createOrganization("Organisasi A");
  orgB = await createOrganization("Organisasi B");
  await addMembership(ownerA.id, orgA.id);
  await addMembership(ownerB.id, orgB.id);

  await signInFor(ownerA.id, orgA.id);
  profileA = (
    await createProfile(ctxFor(orgA.id, ownerA.id), {
      name: "Profil A",
      code: "PA",
      legalName: null,
      address: null,
      taxId: null,
    })
  ).id;
  customerA = (await createCustomer(customerInput("Pelanggan A"), ctxFor(orgA.id, ownerA.id))).id;
  invoiceA = (await createDraft(draftInput(profileA, customerA), ctxFor(orgA.id, ownerA.id))).id;

  await signInFor(ownerB.id, orgB.id);
  profileB = (
    await createProfile(ctxFor(orgB.id, ownerB.id), {
      name: "Profil B",
      code: "PB",
      legalName: null,
      address: null,
      taxId: null,
    })
  ).id;
  customerB = (await createCustomer(customerInput("Pelanggan B"), ctxFor(orgB.id, ownerB.id))).id;
  invoiceB = (await createDraft(draftInput(profileB, customerB), ctxFor(orgB.id, ownerB.id))).id;
});

describe("Change 14 — register + onboarding (step 1 creates local rows)", () => {
  it("creates organizations + memberships rows and resolves the workspace scope", async () => {
    const uid = createId();
    await db.insert(users).values({
      id: uid,
      email: `uji-${createId()}@creainvoice.id`,
      name: "User Uji",
      emailVerified: true,
      onboardingComplete: false,
      onboardingStep: 1,
    });
    await signInFor(uid, null);

    const { chooseWorkspaceAction } = await import("@/modules/onboarding/actions");
    const form = new FormData();
    form.set("mode", "create");
    form.set("name", "PT Uji");
    form.set("step", "1");
    const result = await chooseWorkspaceAction(form);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rows = await db
      .select({ orgId: memberships.organizationId })
      .from(memberships)
      .where(eq(memberships.userId, uid));
    expect(rows.length).toBe(1);

    const { resolveWorkspaceScope } = await import("@/modules/workspace/service");
    const scope = await resolveWorkspaceScope({
      userId: uid,
      orgId: rows[0]!.orgId,
      isAuthenticated: true,
      user: null,
    });
    expect(scope?.organizationStatus).toBe("ACTIVE");
    expect(scope?.isAdmin).toBe(true);
  });

  it("resolves the first active membership when the session has no org stored", async () => {
    const uid = createId();
    const oid = createId();
    await db.insert(organizations).values({ id: oid, name: "Org Default", slug: `sl-${createId()}` });
    await db.insert(users).values({ id: uid, email: `d-${createId()}@test.local`, emailVerified: true });
    await db.insert(memberships).values({ id: createId(), userId: uid, organizationId: oid, status: "ACTIVE" });

    const { resolveActiveOrgId } = await import("@/lib/auth");
    expect(await resolveActiveOrgId(uid, null)).toBe(oid);
  });
});

describe("Change 14 — multi-tenant regression guard (feature 01)", () => {
  it("shows org A's invoice to org A and NOT to org B", async () => {
    await signInFor(ownerA.id, orgA.id);
    const aRows = await listInvoices(ctxFor(orgA.id, ownerA.id), { page: 1, pageSize: 50 });
    const aIds = aRows.rows.map((row) => row.id);
    expect(aIds).toContain(invoiceA);
    expect(aIds).not.toContain(invoiceB);

    await signInFor(ownerB.id, orgB.id);
    const bRows = await listInvoices(ctxFor(orgB.id, ownerB.id), { page: 1, pageSize: 50 });
    const bIds = bRows.rows.map((row) => row.id);
    expect(bIds).toContain(invoiceB);
    expect(bIds).not.toContain(invoiceA);
  });
});

describe("Change 14 — IDOR guard (security-standards baris 20)", () => {
  it("answers 404 (NOT_FOUND) for an invoice owned by another organization", async () => {
    await signInFor(ownerA.id, orgA.id);
    const own = await getDraft(invoiceA, ctxFor(orgA.id, ownerA.id));
    expect(own.id).toBe(invoiceA);

    // The same user requesting org B's invoice through org A's scope must
    // fail closed — 404, never a leak.
    let code: AppError["code"] | null = null;
    try {
      await getDraft(invoiceB, ctxFor(orgA.id, ownerA.id));
    } catch (error) {
      code = (error as AppError).code;
    }
    expect(code).toBe("NOT_FOUND");
  });
});

describe("Change 14 — self-hosted password hashing", () => {
  it("hashes with argon2 and verifies the password (wrong password refused)", async () => {
    const hash = await hashUserPassword("PasswordUji123");
    expect(hash.startsWith("$argon2")).toBe(true);
    expect(await verifyUserPassword("PasswordUji123", hash)).toBe(true);
    expect(await verifyUserPassword("salah-sekali", hash)).toBe(false);
  });

  it("accepts better-auth's default scrypt format rows (legacy compatibility)", async () => {
    // The "saltHex:keyHex" shape better-auth's default hasher produces.
    const { scryptSync, randomBytes } = await import("node:crypto");
    const salt = randomBytes(16);
    const key = scryptSync("legacy-password".normalize("NFKC"), salt, 64, {
      N: 16384,
      r: 16,
      p: 1,
      maxmem: 128 * 16384 * 16 * 2,
    });
    const legacyHash = `${salt.toString("hex")}:${key.toString("hex")}`;
    expect(await verifyUserPassword("legacy-password", legacyHash)).toBe(true);
    expect(await verifyUserPassword("wrong", legacyHash)).toBe(false);
  });
});
