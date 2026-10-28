// src/modules/workspace/service.ts — organization scope (Change 6; Change 14
// removed the Clerk mirror).
//
// Replaces the old modules/organizations + modules/permissions pair. The
// workspace is FLAT: every member of an organization is a full admin
// (PlatformRole and OrganizationRole tiers were removed). The better-auth
// session row carries the active organization id (Change 14); this service
// re-validates the membership against the database on every read — fail
// closed — which is the invariant that keeps cross-tenant queries
// impossible.
//
// Change 14: organizations and memberships are local rows owned by this
// app; there is no external auth organization and no webhook mirror.

import { db } from "@/server/db";
import { memberships, organizations, users } from "@/db/schema";
import { activeOrganizationId, type AuthSession } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { and, asc, eq } from "drizzle-orm";

/** Verified workspace scope for one request. */
export interface WorkspaceScope {
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  organizationStatus: "ACTIVE" | "SUSPENDED";
  userId: string;
  /** Change 6: always true — flat workspace, every member is a full admin. */
  isAdmin: true;
}

/**
 * Resolves the active organization from the better-auth session and
 * RE-VALIDATES the membership every time (ACTIVE membership in an ACTIVE
 * organization). The session value is set by this app (Change 14: the
 * session row's activeOrganizationId), so scope is never trusted without
 * this check.
 */
export async function resolveWorkspaceScope(
  session: AuthSession,
): Promise<WorkspaceScope | null> {
  const orgId = activeOrganizationId(session);
  const userId = session?.userId;
  if (!orgId || !userId) return null;

  const rows = await db
    .select({
      membershipStatus: memberships.status,
      orgId: organizations.id,
      orgName: organizations.name,
      orgSlug: organizations.slug,
      orgStatus: organizations.status,
    })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .where(
      and(
        eq(memberships.userId, userId),
        eq(memberships.organizationId, orgId),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row || row.membershipStatus !== "ACTIVE") return null;

  return {
    organizationId: row.orgId,
    organizationName: row.orgName,
    organizationSlug: row.orgSlug,
    organizationStatus: row.orgStatus,
    userId,
    isAdmin: true,
  };
}

/**
 * Throwing wrapper for organization-scoped work: FORBIDDEN when the session
 * has no active, membership-verified organization.
 */
export async function requireWorkspaceScope(
  session: AuthSession,
): Promise<WorkspaceScope> {
  const scope = await resolveWorkspaceScope(session);
  if (!scope) {
    throw new AppError(
      "FORBIDDEN",
      "Tidak ada organisasi aktif. Pilih organisasi terlebih dahulu.",
    );
  }
  return scope;
}

/** Active memberships for the workspace switcher (INVITED/REMOVED excluded). */
export async function listMembershipsForUser(userId: string) {
  return db
    .select({
      id: memberships.id,
      userId: memberships.userId,
      organizationId: memberships.organizationId,
      status: memberships.status,
      joinedAt: memberships.joinedAt,
      organization: {
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        status: organizations.status,
      },
    })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .where(and(eq(memberships.userId, userId), eq(memberships.status, "ACTIVE")))
    .orderBy(asc(memberships.joinedAt));
}

export interface WorkspaceOverview {
  memberships: Awaited<ReturnType<typeof listMembershipsForUser>>;
  activeOrganizationId: string | null;
}

/**
 * Memberships + the active organization for the shell. The active org comes
 * from the better-auth session row (Change 14); when it is not a verified
 * membership the first membership is used as a fallback.
 */
export async function getWorkspaceOverview(
  session: AuthSession,
): Promise<WorkspaceOverview> {
  const membershipsRows = await listMembershipsForUser(session?.userId ?? "");
  const requested = activeOrganizationId(session);
  const resolvedActive =
    requested && membershipsRows.some((m) => m.organization.id === requested)
      ? requested
      : (membershipsRows[0]?.organization.id ?? null);
  return { memberships: membershipsRows, activeOrganizationId: resolvedActive };
}

/**
 * Ensures a user row exists for a non-auth path (Change 14: better-auth
 * creates the row at sign-up; some onboarding reads may run before that —
 * idempotent upsert).
 */
export async function ensureUser(input: {
  id: string;
  email: string;
  name?: string | null;
  username?: string | null;
  imageUrl?: string | null;
}): Promise<void> {
  await db
    .insert(users)
    .values({
      id: input.id,
      email: input.email,
      name: input.name ?? null,
      username: input.username ?? null,
      imageUrl: input.imageUrl ?? null,
    })
    .onConflictDoNothing({ target: users.id });
}
