// tests/factories.ts — Drizzle-backed factories for integration tests (Change 6).
//
// All rows go through the real Drizzle schema against the Neon test database.
// Call resetDatabase() in beforeAll per test file. Users mirror the Clerk
// shape (id, email, name, username, onboarding flags) — there is no password
// column anymore because Clerk owns credentials.

import { db } from "@/db/client";
import {
  auditLogs,
  bankAccounts,
  customerContacts,
  customers,
  invoiceItems,
  invoicePdfs,
  invoiceProfiles,
  invoiceSequences,
  invoices,
  memberships,
  organizations,
  payments,
  pdfJobs,
  projectReferences,
  signers,
  uploadRecords,
  users,
} from "@/db/schema";
import { createId } from "@/db/id";
import { sql } from "drizzle-orm";

/** Wipes all tables (children first — FK order). */
export async function resetDatabase(): Promise<void> {
  await db.delete(auditLogs);
  await db.delete(uploadRecords);
  await db.delete(payments);
  await db.delete(invoiceItems);
  await db.delete(invoicePdfs);
  await db.delete(pdfJobs);
  await db.delete(invoices);
  await db.delete(invoiceSequences);
  await db.delete(invoiceProfiles);
  await db.delete(bankAccounts);
  await db.delete(signers);
  await db.delete(projectReferences);
  await db.delete(customerContacts);
  await db.delete(customers);
  await db.delete(memberships);
  await db.delete(users);
  await db.delete(organizations);
}

let sequence = 0;
function uniqueSuffix(): string {
  sequence += 1;
  return `${Date.now().toString(36)}${sequence}`;
}

export interface TestUserOptions {
  username?: string;
  email?: string;
  name?: string;
  /** Kept for call-site compatibility: Clerk owns the password now, so the
   *  value is recorded on the returned object but never persisted. */
  password?: string;
  status?: "ACTIVE" | "SUSPENDED";
  /** Defaults to TRUE so tests keep their "straight to dashboard"
   *  expectation; onboarding tests opt in with false. */
  onboardingComplete?: boolean;
  onboardingStep?: number;
}

export interface TestUser {
  id: string;
  username: string;
  email: string;
  password: string;
  name: string;
}

export async function createUser(options: TestUserOptions = {}): Promise<TestUser> {
  const username = options.username ?? `user${uniqueSuffix()}`;
  const email = options.email ?? `${username}@test.local`;
  const password = options.password ?? `Pwd-${uniqueSuffix()}x1`;

  const id = createId();
  await db.insert(users).values({
    id,
    username,
    email,
    name: options.name ?? username,
    emailVerified: true,
    status: options.status ?? "ACTIVE",
    onboardingComplete: options.onboardingComplete ?? true,
    onboardingStep: options.onboardingStep ?? 1,
  });

  return { id, username, email, password, name: options.name ?? username };
}

export async function createOrganization(
  name?: string,
): Promise<{ id: string; slug: string }> {
  const slug = `org-${uniqueSuffix()}`;
  const id = createId();
  await db.insert(organizations).values({
    id,
    name: name ?? `Organisasi Uji ${uniqueSuffix()}`,
    slug,
  });
  return { id, slug };
}

export async function addMembership(
  userId: string,
  organizationId: string,
  _role?: string,
  status: "ACTIVE" | "INVITED" | "REMOVED" = "ACTIVE",
): Promise<{ id: string }> {
  const id = createId();
  await db.insert(memberships).values({ id, userId, organizationId, status });
  return { id };
}

/** Raw SQL escape hatch for fixtures that need statements the factories do
 *  not cover (kept small on purpose). */
export async function raw(sqlText: string): Promise<void> {
  await db.execute(sql.raw(sqlText));
}
