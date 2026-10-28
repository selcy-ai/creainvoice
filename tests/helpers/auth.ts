// tests/helpers/auth.ts — in-process better-auth session for action tests.
//
// Server actions resolve the caller through requireSession() in src/lib/auth,
// which reads better-auth's auth.api.getSession({ headers }) (itself backed by
// next/headers). The integration suite cannot run a real HTTP sign-in, so
// this module stubs next/headers with a cookie jar the test controls and
// seeds a REAL session row (better-auth resolveSession() reads the
// better-auth.session_token cookie, looks the row up in the `session` table
// and returns its user). The effect is exactly what the old Clerk mock had:
// the action layer sees a REAL authenticated session with a REAL
// organization id, and requireWorkspaceScope() re-validates the membership
// against the database.
//
// Usage:
//   vi.mock("next/headers", () => betterAuthSessionMock());   // hoisted
//   await signInFor(user, orgId);                              // "sign in"
//   setSession(null);                                          // "sign out"
//
// The membership row must exist in the database for requireWorkspaceScope to
// accept it.

import { vi } from "vitest";
import { db } from "@/db/client";
import { sessions, users } from "@/db/schema";
import { createId } from "@/db/id";
import { env } from "@/server/env";
import { eq } from "drizzle-orm";

/** What the mock answers next/headers with. */
export type MockSession = {
  userId: string;
  orgId: string | null;
  /** The session row token created by signInFor (null until signed in). */
  token: string | null;
};

const holder = vi.hoisted(() => ({ current: null as MockSession | null }));

/**
 * Signs a session token the way better-auth's setSignedCookie does:
 * `<token>.<base64 HMAC-SHA256(token)>`, URL-encoded. getSession() verifies
 * the signature before it looks the session row up (better-call's
 * getSignedCookie), so an unsigned token is invisible to it.
 */
async function signToken(token: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.BETTER_AUTH_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(token),
  );
  const encoded = btoa(String.fromCharCode(...new Uint8Array(signature)));
  return encodeURIComponent(`${token}.${encoded}`);
}

/** The mock factory: pass to vi.mock("next/headers", ...).
 *
 * `headers()` must return a REAL Headers instance: src/lib/action.ts builds a
 * Request from it (audit metadata) and better-auth's getSession walks the
 * cookie header to find the session row — a plain object breaks both. */
export function betterAuthSessionMock() {
  return {
    headers: async () => {
      const cur = holder.current;
      if (!cur || !cur.token) return new Headers();
      const h = new Headers();
      h.set("cookie", `better-auth.session_token=${await signToken(cur.token)}`);
      return h;
    },
    cookies: async () => {
      const cur = holder.current;
      if (!cur || !cur.token) {
        return {
          get: () => undefined as never,
          getAll: () => [] as never[],
        };
      }
      const value = await signToken(cur.token);
      return {
        get: () => ({ value }) as never,
        getAll: () => [{ value }] as never[],
      };
    },
  };
}

/** "Signs in" as a user (optionally with an active organization). */
export function setSession(session: MockSession | null): void {
  holder.current = session;
}

/** The currently mocked session — tests assert against it directly. */
export function currentSession(): MockSession | null {
  return holder.current;
}

/** The cookie value the current mock session answers with. */
export function currentSessionCookie(): string | null {
  const cur = holder.current;
  return cur?.token ?? null;
}

/**
 * Signs in FOR REAL from the database's point of view: creates a genuine
 * `session` row for the user (with activeOrganizationId set, when an org is
 * given) and points the next/headers mock at its token. Tests that exercise
 * the action layer then flow through the exact code path production uses:
 * cookie → auth.api.getSession → user + org resolution.
 */
export async function signInFor(
  userId: string,
  orgId: string | null = null,
): Promise<MockSession> {
  // The user row must exist for the join in verifyCredentials/getSession.
  const userRows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const user = userRows[0];
  if (!user) {
    throw new Error(`tests/helpers/auth: user ${userId} does not exist — create it first`);
  }

  const token = `test-session-${createId()}`;
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  await db.insert(sessions).values({
    id: createId(),
    token,
    userId,
    expiresAt,
    activeOrganizationId: orgId,
  });

  const session: MockSession = { userId, orgId, token };
  setSession(session);
  return session;
}

/** Removes every session row for the current test user (cleanup). */
export async function signOutCurrent(): Promise<void> {
  const cur = holder.current;
  if (!cur) return;
  await db.delete(sessions).where(eq(sessions.userId, cur.userId));
  setSession(null);
}
