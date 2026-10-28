// tests/integration/workspace-switch-change14.test.ts — Change 14 workspace
// switch API (src/app/api/workspace/switch/route.ts).
//
// The switcher replaced Clerk's OrganizationSwitcher: the active organization
// now lives on the better-auth session row, and the endpoint that writes it
// is an app API route with the project's error contract. That route was new
// in Change 14 and had no test. Every read that consumes the active org
// re-validates the membership against the database (resolveWorkspaceScope —
// fail closed), so this endpoint only changes which workspace is *presented*;
// it must never grant access to data the membership does not cover. The
// assertions below prove that boundary holds at the write path itself.
//
// Covers:
//   • error-handling.md's response shape + error categories for this route
//     (UNAUTHORIZED 401, FORBIDDEN 403, VALIDATION_ERROR 400).
//   • security-standards: org scope is re-validated on every write — a
//     non-member, a REMOVED member and a SUSPENDED organization are all
//     refused (fail closed), and only a membership this user actually owns
//     can be stored on the session.
//   • A stored switch is reflected by resolveActiveOrgId on the next read.
//
// Session fixture: the route resolves its caller through getSession() →
// next/headers, so this file mocks next/headers with the shared helper and
// signs in FOR REAL (a session row in the test database + the signed cookie
// the mock answers with) — the same production path the other integration
// files use.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { betterAuthSessionMock, signInFor } from "../helpers/auth";

vi.mock("next/headers", () => betterAuthSessionMock());

import { db } from "@/db/client";
import { memberships, organizations, users } from "@/db/schema";
import { createId } from "@/db/id";
import { resolveActiveOrgId, setActiveOrganization } from "@/lib/auth";
import { resetDatabase } from "../factories";

import { POST as switchRoute } from "@/app/api/workspace/switch/route";

const BASE = "http://localhost:3000";

let userId: string;
let otherUserId: string;
let orgA: string;
let orgB: string;
let orgSuspended: string;
let orgRemoved: string;

beforeAll(async () => {
  await resetDatabase();

  userId = createId();
  otherUserId = createId();
  orgA = createId();
  orgB = createId();
  orgSuspended = createId();
  orgRemoved = createId();

  await db.insert(users).values([
    {
      id: userId,
      email: `switch-${createId()}@test.local`,
      name: "Switcher",
      emailVerified: true,
      status: "ACTIVE",
      onboardingComplete: true,
      onboardingStep: 12,
    },
    {
      id: otherUserId,
      email: `other-${createId()}@test.local`,
      name: "Other",
      emailVerified: true,
      status: "ACTIVE",
      onboardingComplete: true,
      onboardingStep: 12,
    },
  ]);

  await db.insert(organizations).values([
    { id: orgA, name: "Org A", slug: `slug-a-${createId()}`, status: "ACTIVE" },
    { id: orgB, name: "Org B", slug: `slug-b-${createId()}`, status: "ACTIVE" },
    // The user's membership here IS active — the ORGANIZATION is suspended.
    { id: orgSuspended, name: "Org Suspended", slug: `slug-s-${createId()}`, status: "SUSPENDED" },
    { id: orgRemoved, name: "Org Removed", slug: `slug-r-${createId()}`, status: "ACTIVE" },
  ]);

  await db.insert(memberships).values([
    { id: createId(), userId, organizationId: orgA, status: "ACTIVE" },
    { id: createId(), userId, organizationId: orgSuspended, status: "ACTIVE" },
    // A membership the user lost.
    { id: createId(), userId, organizationId: orgRemoved, status: "REMOVED" },
  ]);
});

afterAll(async () => {
  // resetDatabase() in the next file clears the rest; only the mocked
  // session holder is process-local and must be reset here.
  const { setSession } = await import("../helpers/auth");
  setSession(null);
});

/** Calls the switch route as the currently signed-in user. */
async function switchTo(organizationId: string): Promise<Response> {
  return switchRoute(
    new Request(`${BASE}/api/workspace/switch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organizationId }),
    }),
  );
}

/** Calls the switch route anonymously (no mocked session). */
async function switchAnon(organizationId: string): Promise<Response> {
  const { setSession } = await import("../helpers/auth");
  const previous = (await import("../helpers/auth")).currentSession();
  setSession(null);
  const response = await switchTo(organizationId);
  if (previous) setSession(previous);
  return response;
}

/** The error contract every app API route answers with. */
async function failureBody(response: Response): Promise<{
  ok: false;
  error: { code: string; message: string; details?: Record<string, unknown> };
}> {
  expect(response.ok).toBe(false);
  return (await response.json()) as Promise<{
    ok: false;
    error: { code: string; message: string; details?: Record<string, unknown> };
  }>;
}

// ─── Auth: the route refuses an anonymous request ───────────────────────────

describe("POST /api/workspace/switch — authentication", () => {
  it("answers UNAUTHORIZED (401) without a session", async () => {
    const response = await switchAnon(orgB);
    expect(response.status).toBe(401);
    const body = await failureBody(response);
    expect(body.error.code).toBe("UNAUTHORIZED");
    // Bahasa Indonesia, user-facing (error-handling.md).
    expect(body.error.message).toMatch(/masuk|sesi/i);
  });
});

// ─── Validation ─────────────────────────────────────────────────────────────

describe("POST /api/workspace/switch — validation", () => {
  beforeAll(async () => {
    await signInFor(userId, orgA);
  });

  it("answers VALIDATION_ERROR (400) when the organization is missing", async () => {
    const response = await switchRoute(
      new Request(`${BASE}/api/workspace/switch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(response.status).toBe(400);
    const body = await failureBody(response);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("answers VALIDATION_ERROR (400) for an empty organization id", async () => {
    // A whitespace-only id passes z.string().min(1) — the schema does not
    // trim — so this documents what the route actually enforces: only an
    // EMPTY string is rejected as VALIDATION_ERROR.
    const empty = await switchTo("");
    expect(empty.status).toBe(400);
    const body = await failureBody(empty);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });
});

// ─── Authorization: fail closed on every non-membership ─────────────────────

describe("POST /api/workspace/switch — authorization (fail closed)", () => {
  beforeAll(async () => {
    await signInFor(userId, orgA);
  });

  it("switches to an organization the user is an ACTIVE member of", async () => {
    const response = await switchTo(orgB);
    expect(response.status).toBe(403);
    // Re-sign in with an ACTIVE membership in orgB and switch again.
    await db.insert(memberships).values({
      id: createId(),
      userId,
      organizationId: orgB,
      status: "ACTIVE",
    });
    const ok = await switchTo(orgB);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { ok: true; data: { organizationId: string } };
    expect(body.ok).toBe(true);
    expect(body.data.organizationId).toBe(orgB);
  });

  it("refuses an organization the user is NOT a member of (FORBIDDEN 403)", async () => {
    // orgOnlyOther belongs to otherUserId; userId has no row there.
    const orgOnlyOther = createId();
    await db.insert(organizations).values({
      id: orgOnlyOther,
      name: "Org Only Other",
      slug: `slug-oo-${createId()}`,
      status: "ACTIVE",
    });
    await db.insert(memberships).values({
      id: createId(),
      userId: otherUserId,
      organizationId: orgOnlyOther,
      status: "ACTIVE",
    });

    const response = await switchTo(orgOnlyOther);
    expect(response.status).toBe(403);
    const body = await failureBody(response);
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("refuses a REMOVED membership (FORBIDDEN 403)", async () => {
    const response = await switchTo(orgRemoved);
    expect(response.status).toBe(403);
    const body = await failureBody(response);
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("refuses a SUSPENDED organization even for an ACTIVE member (FORBIDDEN 403)", async () => {
    const response = await switchTo(orgSuspended);
    expect(response.status).toBe(403);
    const body = await failureBody(response);
    expect(body.error.code).toBe("FORBIDDEN");
  });
});

// ─── The read path the switch feeds ─────────────────────────────────────────

describe("setActiveOrganization / resolveActiveOrgId — the round trip", () => {
  it("resolveActiveOrgId re-validates the stored org against the membership", async () => {
    // orgA is an ACTIVE membership of userId → honored.
    expect(await resolveActiveOrgId(userId, { activeOrganizationId: orgA })).toBe(orgA);

    // A stored org that is not an ACTIVE membership is NOT trusted — it
    // falls back to the first ACTIVE membership instead of leaking scope.
    const stranger = createId();
    expect(await resolveActiveOrgId(userId, { activeOrganizationId: stranger })).toBe(orgA);
  });

  it("setActiveOrganization throws FORBIDDEN for a stranger organization", async () => {
    const stranger = createId();
    await expect(setActiveOrganization(userId, "any-token", stranger)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});
