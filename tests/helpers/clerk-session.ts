// tests/helpers/clerk-session.ts — in-process Clerk session for action tests.
//
// Server actions resolve the caller through `requireSession()` in src/lib/clerk,
// which reads Clerk's `auth()` (itself backed by next/headers). The integration
// suite cannot run a real Clerk session, so this module mocks @clerk/nextjs/server
// to return the user the test signed in as — replacing the old better-auth
// cookie jar (tests/helpers/auth.ts) with the same effect: the action layer
// sees a REAL authenticated session with a REAL organization id, and
// requireWorkspaceScope() re-validates the membership against the database.
//
// Usage:
//   vi.mock("@clerk/nextjs/server", () => clerkSessionMock());   // hoisted
//   setCurrentUser(user);       // "sign in"
//   setCurrentUser(null);       // "sign out"
//
// `orgId` in the session is what activeOrganizationId() reads; the membership
// row must exist in the database for requireWorkspaceScope to accept it.

import { vi } from "vitest";

export interface ClerkMockUser {
  id: string;
  orgId: string | null;
}

const holder = vi.hoisted(() => ({ current: null as ClerkMockUser | null }));

/** The mock factory: pass to vi.mock("@clerk/nextjs/server", ...). */
export function clerkSessionMock() {
  return {
    auth: async () => {
      const cur = holder.current;
      if (!cur) {
        return {
          userId: null,
          orgId: null,
          isAuthenticated: false,
        } satisfies { userId: string | null; orgId: string | null; isAuthenticated: boolean };
      }
      return {
        userId: cur.id,
        orgId: cur.orgId,
        isAuthenticated: true,
      } satisfies { userId: string | null; orgId: string | null; isAuthenticated: boolean };
    },
    currentUser: async () => {
      const cur = holder.current;
      if (!cur) return null;
      return { id: cur.id } satisfies { id: string };
    },
  };
}

/** "Signs in" as a user (optionally with an active organization). */
export function setCurrentUser(user: ClerkMockUser | null): void {
  holder.current = user;
}

/** The currently mocked user — tests assert against it directly. */
export function currentUser(): ClerkMockUser | null {
  return holder.current;
}
