// src/lib/clerk.ts — Clerk session helpers (Change 6).
//
// All auth is delegated to Clerk: sign-in/up, organizations, invitations and
// sessions. This module is the single place the app reads the Clerk session
// (`auth()` + `currentUser()`); every authorization decision that matters
// still runs in the service layer against the workspace scope resolved from
// the local database mirror.
//
// The Clerk webhook (src/app/api/clerk/webhook/route.ts) mirrors Clerk users
// and organization memberships into this database; the workspace scope
// (modules/workspace) re-validates that mirror on every read — fail closed.

import { auth, currentUser } from "@clerk/nextjs/server";
import { AppError } from "@/lib/errors";

/**
 * The Clerk auth object (session claims) — userId, orgId, isAuthenticated…
 * `user` is NOT on it; use the richer `AuthSession` below when a handler
 * needs the user record.
 */
export type ClerkAuth = Awaited<ReturnType<typeof auth>>;

/** Session shape this app consumes: auth claims + the Backend User object. */
export interface AuthSession {
  userId: string | null;
  orgId: string | null;
  isAuthenticated: boolean;
  user: Awaited<ReturnType<typeof currentUser>>;
}

/**
 * Current Clerk session for the request, or null when absent/expired.
 * Reads `auth()` + `currentUser()` — the Next.js App Router helpers that
 * inspect the request cookies/headers.
 */
export async function getSession(): Promise<AuthSession | null> {
  try {
    const clerk = await auth();
    if (!clerk?.userId) return null;
    return {
      userId: clerk.userId,
      orgId: clerk.orgId ?? null,
      isAuthenticated: clerk.isAuthenticated ?? true,
      user: await currentUser(),
    };
  } catch {
    return null;
  }
}

/** Throws UNAUTHORIZED when there is no valid Clerk session. */
export async function requireSession(): Promise<NonNullable<AuthSession>> {
  const session = await getSession();
  if (!session || !session.userId || !session.user) {
    throw new AppError(
      "UNAUTHORIZED",
      "Sesi Anda sudah berakhir. Silakan masuk kembali.",
    );
  }
  return session;
}

/**
 * The active Clerk organization id, or null when the user has none selected.
 * Clerk Organizations are the workspace container (flat — every member is a
 * full admin, Change 6 removed role tiers).
 */
export function activeOrganizationId(session: AuthSession | null): string | null {
  return session?.orgId ?? null;
}
