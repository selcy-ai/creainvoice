// tests/factories.ts — Drizzle-backed factories for integration tests (Change 6).
//
// All rows go through the real Drizzle schema against the Neon test database.
// Call resetDatabase() in beforeAll per test file. Change 14 made users REAL
// logins again: createUser hashes the password with argon2 and stores it on
// a `account` row (providerId "credential"), so both the integration suite
// (which drives the session row) and the E2E suite (which signs in through
// the real /login form) share one honest fixture.

import { db } from "@/db/client";
import {
  accounts,
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
  sessions,
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
  // Change 14: credential accounts and sessions are real rows now (they are
  // also cascaded by user_id, but an explicit delete keeps the order legible).
  await db.delete(sessions);
  await db.delete(accounts);
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
  /** Change 14: the password is REAL now — it is argon2-hashed and stored on
   *  a `account` row (providerId "credential") so the login form can
   *  actually sign the fixture user in. Set `withCredential: false` for the
   *  unit-style fixtures that never log in through the browser. */
  password?: string;
  /** Create a usable credential login (default true). The E2E specs sign in
   *  through the real /login form; integration specs drive the session row
   *  directly and do not need it. */
  withCredential?: boolean;
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

  // Change 14: a fixture user is a REAL login. The hash goes through the
  // app's own hashUserPassword (argon2), so POST /api/auth/sign-in/email
  // accepts it exactly like a signed-up user.
  if (options.withCredential !== false) {
    const { hashUserPassword } = await import("@/lib/auth");
    await db.insert(accounts).values({
      id: createId(),
      accountId: id,
      providerId: "credential",
      userId: id,
      password: await hashUserPassword(password),
    });
  }

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
