// tests/integration/auth-http-change14.test.ts — Change 14 HTTP contract.
//
// The auth swap's most load-bearing surface is the catch-all route handler
// (src/app/api/auth/[...all]/route.ts → better-auth). The login and register
// forms POST to it, the shell's sign-out POSTs to it, and getSession() reads
// the cookie it sets. That contract had no test at all after the Clerk
// removal — this file drives it the way the forms do: real Request objects
// through the exported { GET, POST } handlers, real rows in the test
// database, real argon2 hashes. No HTTP server, no better-auth client SDK:
// the handler is a plain `Request → Response`, so calling it in-process is
// the same code path the browser hits.
//
// Covers the spec's Check When Done items that live at the HTTP layer:
//   • "Login sungguhan" — POST /api/auth/sign-in/email sets the local
//     session cookie (better-auth.session_token) and GET /api/auth/get-session
//     then answers authenticated.
//   • "Register" — POST /api/auth/sign-up/email creates the user + credential
//     account, and with requireEmailVerification no session cookie is handed
//     out until the email is verified (public sign-up gate).
//   • Login refuses a wrong password without leaking which leg failed.
//   • GET /api/auth/get-session answers an empty session for an anonymous
//     request.
//
// Rate limiting: better-auth throttles /sign-in and /sign-up to 3 requests
// per 10s per (client IP, path) — a real security control the app enables
// (rateLimit.enabled: true in src/lib/auth.ts). Every request here carries a
// UNIQUE x-forwarded-for so each one is a distinct client and the suite
// measures the auth contract, not the throttle. This is deliberate: the
// moment a test disables rate limiting to make itself pass is the moment the
// suite stops proving anything about production.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db/client";
import { accounts, sessions, users } from "@/db/schema";
import { createId } from "@/db/id";
import { hashUserPassword, verifyCredentials } from "@/lib/auth";
import { eq } from "drizzle-orm";
import { resetDatabase } from "../factories";

// The catch-all route handler — exactly what Next.js mounts.
import { GET, POST } from "@/app/api/auth/[...all]/route";

const BASE = "http://localhost:3000";

/** Unique client IP per request → each is a fresh rate-limit bucket. */
let clientSeq = 0;
function nextClientIp(): string {
  clientSeq += 1;
  // A valid single-value x-forwarded-for (the header better-auth reads).
  return `198.51.100.${clientSeq % 250}`;
}

function json(path: string, body: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": nextClientIp(),
    },
    body: JSON.stringify(body),
  });
}

/** GET with the session cookie (and its own client IP for rate limiting). */
function getWithCookie(path: string, cookie: string): Request {
  return new Request(`${BASE}${path}`, {
    headers: {
      cookie,
      "x-forwarded-for": nextClientIp(),
    },
  });
}

/** The cookie a browser would hold after a successful sign-in. */
function sessionCookieFrom(response: Response): string | null {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) return null;
  const match = /better-auth\.session_token=([^;]+)/.exec(setCookie);
  return match ? match[1]! : null;
}

/** A pre-verified user with a credential account — the state the seed admin
 *  starts in, and the only state login accepts. */
async function makeVerifiedUser(email: string, password: string): Promise<string> {
  const id = createId();
  await db.insert(users).values({
    id,
    email,
    name: "User Uji HTTP",
    emailVerified: true,
    status: "ACTIVE",
    onboardingComplete: true,
    onboardingStep: 12,
  });
  await db.insert(accounts).values({
    id: createId(),
    accountId: id,
    providerId: "credential",
    userId: id,
    password: await hashUserPassword(password),
  });
  return id;
}

let userId: string;
const EMAIL = `http-uji-${createId()}@test.local`;
const PASSWORD = "PasswordUji123";

beforeAll(async () => {
  await resetDatabase();
  userId = await makeVerifiedUser(EMAIL, PASSWORD);
});

afterAll(async () => {
  await db.delete(sessions).where(eq(sessions.userId, userId));
});

// ─── Sign in (the login form's POST) ────────────────────────────────────────

describe("POST /api/auth/sign-in/email — the login form's endpoint", () => {
  it("sets the local session cookie (better-auth.session_token)", async () => {
    const response = await POST(json("/api/auth/sign-in/email", { email: EMAIL, password: PASSWORD }));

    expect(response.status).toBe(200);
    const cookie = sessionCookieFrom(response);
    expect(cookie).toBeTruthy();

    // The Check When Done contract: the cookie is the local session, not a
    // third-party token, and it is HttpOnly (security-standards).
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("better-auth.session_token=");
    expect(setCookie.toLowerCase()).toContain("httponly");
    // No session cookie may ever be readable by client JS.
    expect(setCookie.toLowerCase()).not.toMatch(/httponly.*;\s*secure=false/);
  });

  it("refuses a wrong password with the same error as an unknown email (no leak)", async () => {
    const wrong = await POST(
      json("/api/auth/sign-in/email", { email: EMAIL, password: "salah-sekali-123" }),
    );
    expect(wrong.status).toBe(401);
    expect(sessionCookieFrom(wrong)).toBeNull();

    const unknown = await POST(
      json("/api/auth/sign-in/email", {
        email: `tidak-ada-${createId()}@test.local`,
        password: "salah-sekali-123",
      }),
    );
    expect(unknown.status).toBe(401);
    expect(sessionCookieFrom(unknown)).toBeNull();

    // The two failures must be indistinguishable — do not leak which leg
    // failed (security-standards; the login form relies on the same).
    const wrongBody = (await wrong.json().catch(() => null)) as { error?: { code?: string } } | null;
    const unknownBody = (await unknown.json().catch(() => null)) as { error?: { code?: string } } | null;
    expect(wrongBody?.error?.code).toBe(unknownBody?.error?.code);
  });

  it("refuses a malformed body (validation, not a session)", async () => {
    const response = await POST(json("/api/auth/sign-in/email", { email: EMAIL }));
    expect(response.status).toBe(400);
    expect(sessionCookieFrom(response)).toBeNull();
  });
});

// ─── Session read (getSession's HTTP twin) ──────────────────────────────────

describe("GET /api/auth/get-session — the session read", () => {
  it("answers an empty session for an anonymous request", async () => {
    // better-auth answers anonymous get-session with 200 + null session
    // (its documented shape), so the contract that matters to the app is
    // "no user", not the status code: resolveSession() treats a missing
    // user as unauthenticated, never a session.
    const response = await GET(
      new Request(`${BASE}/api/auth/get-session`, { headers: { "x-forwarded-for": nextClientIp() } }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json().catch(() => null)) as { user?: unknown } | null;
    expect(body?.user).toBeFalsy();
  });

  it("answers authenticated with the cookie from sign-in", async () => {
    const signIn = await POST(json("/api/auth/sign-in/email", { email: EMAIL, password: PASSWORD }));
    const cookie = sessionCookieFrom(signIn);
    expect(cookie).toBeTruthy();

    const response = await GET(getWithCookie("/api/auth/get-session", `better-auth.session_token=${cookie}`));
    expect(response.status).toBe(200);
    const body = (await response.json().catch(() => null)) as { user?: { id?: string } } | null;
    expect(body?.user?.id).toBe(userId);
  });
});

// ─── Sign up (the register form's POST) ─────────────────────────────────────

describe("POST /api/auth/sign-up/email — the register form's endpoint", () => {
  it("creates the user + a credential account with an argon2 hash", async () => {
    const newEmail = `daftar-${createId()}@test.local`;
    const response = await POST(
      json("/api/auth/sign-up/email", { email: newEmail, password: "PasswordDaftar123", name: "User Daftar" }),
    );

    expect(response.status).toBe(200);
    const created = await db.select().from(users).where(eq(users.email, newEmail)).limit(1);
    expect(created.length).toBe(1);

    const credential = await db
      .select({ password: accounts.password })
      .from(accounts)
      .where(eq(accounts.userId, created[0]!.id))
      .limit(1);
    // The hash goes through our hashPassword → argon2 (spec: "argon2
    // direkomendasikan"), so the stored value is an argon2 encoded hash.
    expect(credential[0]?.password?.startsWith("$argon2")).toBe(true);
  });

  it("hands out NO session cookie until the email is verified (public sign-up gate)", async () => {
    const newEmail = `gate-${createId()}@test.local`;
    const response = await POST(
      json("/api/auth/sign-up/email", { email: newEmail, password: "PasswordDaftar123", name: "User Gate" }),
    );

    // The account is created (200)… but requireEmailVerification +
    // autoSignIn:false mean better-auth hands out no session yet.
    expect(response.status).toBe(200);
    expect(sessionCookieFrom(response)).toBeNull();

    // …and the unverified user cannot log in until the email is verified.
    const login = await POST(
      json("/api/auth/sign-in/email", { email: newEmail, password: "PasswordDaftar123" }),
    );
    expect(login.status).toBe(403);
    expect(sessionCookieFrom(login)).toBeNull();
  });

  it("does not leak which emails already exist (duplicate sign-up looks like success)", async () => {
    // requireEmailVerification makes better-auth answer a duplicate sign-up
    // with the same plain OK as a fresh one instead of "user already exists"
    // — no user enumeration through the public form. Asserted because it is
    // a real security property of this configuration, not an accident.
    const response = await POST(
      json("/api/auth/sign-up/email", { email: EMAIL, password: "PasswordLain123", name: "Duplikat" }),
    );
    expect(response.status).toBe(200);
    expect(sessionCookieFrom(response)).toBeNull();

    // And no second row was created for the existing email.
    const rows = await db.select({ id: users.id }).from(users).where(eq(users.email, EMAIL));
    expect(rows.length).toBe(1);
  });

  it("refuses a too-short password", async () => {
    const response = await POST(
      json("/api/auth/sign-up/email", {
        email: `pendek-${createId()}@test.local`,
        password: "abc123",
        name: "Pendek",
      }),
    );
    expect(response.status).toBe(400);
    expect(sessionCookieFrom(response)).toBeNull();
  });
});

// ─── Credential helper (seed-admin path + tests) ────────────────────────────

describe("verifyCredentials — the in-process login (seed admin path)", () => {
  it("returns the user for the right password", async () => {
    const user = await verifyCredentials({ email: EMAIL, password: PASSWORD });
    expect(user?.id).toBe(userId);
    expect(user?.email).toBe(EMAIL);
  });

  it("returns null for a wrong password or an unknown email", async () => {
    expect(await verifyCredentials({ email: EMAIL, password: "salah-sekali" })).toBeNull();
    expect(
      await verifyCredentials({ email: `tidak-ada-${createId()}@test.local`, password: PASSWORD }),
    ).toBeNull();
  });

  it("returns null for a suspended user", async () => {
    const suspendedId = await makeVerifiedUser(`suspended-${createId()}@test.local`, PASSWORD);
    await db.update(users).set({ status: "SUSPENDED" }).where(eq(users.id, suspendedId));
    const email = (await db.select({ email: users.email }).from(users).where(eq(users.id, suspendedId)).limit(1))[0]!
      .email;
    expect(await verifyCredentials({ email, password: PASSWORD })).toBeNull();
  });

  it("returns null for an unverified user", async () => {
    const unverifiedId = createId();
    const unverifiedEmail = `unverified-${createId()}@test.local`;
    await db.insert(users).values({
      id: unverifiedId,
      email: unverifiedEmail,
      emailVerified: false,
      status: "ACTIVE",
    });
    await db.insert(accounts).values({
      id: createId(),
      accountId: unverifiedId,
      providerId: "credential",
      userId: unverifiedId,
      password: await hashUserPassword(PASSWORD),
    });
    expect(await verifyCredentials({ email: unverifiedEmail, password: PASSWORD })).toBeNull();
  });
});

// ─── Sign out (the shell's POST — S1 regression guard) ──────────────────────
//
// security-standards.md line 14: "Logout mengakhiri session server-side, tidak
// hanya menghapus cookie." better-auth's /sign-out declares a JSON body, so a
// POST that carries a body with no Content-Type is answered 415 and the
// endpoint never runs — the session row survives behind a client-side
// redirect. The shell must send a JSON body; this pins that at the HTTP
// layer, independent of the component.
describe("POST /api/auth/sign-out — the shell's sign-out (S1)", () => {
  it("deletes the session row and expires the cookie when called correctly", async () => {
    // previous cases in this file may leave rows behind; isolate the count
    await db.delete(sessions).where(eq(sessions.userId, userId));

    const signedIn = await POST(json("/api/auth/sign-in/email", { email: EMAIL, password: PASSWORD }));
    const cookie = sessionCookieFrom(signedIn);
    expect(cookie).toBeTruthy();

    const before = await db.select().from(sessions).where(eq(sessions.userId, userId));
    expect(before.length).toBe(1);

    const response = await POST(
      new Request(`${BASE}/api/auth/sign-out`, {
        method: "POST",
        headers: {
          // Exactly what the fixed UserMenu sends.
          "content-type": "application/json",
          cookie: `better-auth.session_token=${cookie}`,
          "x-forwarded-for": nextClientIp(),
        },
        body: "{}",
      }),
    );

    expect(response.status).toBe(200);
    const after = await db.select().from(sessions).where(eq(sessions.userId, userId));
    expect(after.length).toBe(0);

    // The cookie is expired server-side, not merely cleared by the client.
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("better-auth.session_token=");
    expect(setCookie.toLowerCase()).toMatch(/expires=|max-age=0/);
  });

  it("answers 415 to a bodyless JSON POST — the original S1 failure", async () => {
    // The exact shape the buggy UserMenu issued: no Content-Type. With a body
    // present better-call throws 415 out of getBody, so the endpoint never
    // runs and the session survives. Kept as a guard so the component fix
    // cannot silently regress back to the broken call.
    const signedIn = await POST(json("/api/auth/sign-in/email", { email: EMAIL, password: PASSWORD }));
    const cookie = sessionCookieFrom(signedIn);
    expect(cookie).toBeTruthy();

    const response = await POST(
      new Request(`${BASE}/api/auth/sign-out`, {
        method: "POST",
        headers: {
          cookie: `better-auth.session_token=${cookie}`,
          "x-forwarded-for": nextClientIp(),
        },
        body: "",
      }),
    );

    expect(response.status).toBe(415);
    // And the session was NOT ended.
    const rows = await db.select().from(sessions).where(eq(sessions.userId, userId));
    expect(rows.length).toBeGreaterThan(0);
    await db.delete(sessions).where(eq(sessions.userId, userId));
  });
});
