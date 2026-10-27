// tests/helpers/context.ts — service contexts for the flat workspace (Change 6).
//
// Change 6 removed OrganizationRole: every member of an organization is a full
// admin, so WorkspaceScope no longer carries `role` but does carry
// organizationName/organizationSlug/organizationStatus/isAdmin (the fields
// resolveWorkspaceScope fills by re-validating the membership).
//
// Test files used to define their own `ctxFor(organizationId, role, userId)`.
// The role argument no longer exists, so they now import `ctxFor` from here:
// `ctxFor(orgId, userId)` returns a context whose scope is exactly the shape
// resolveWorkspaceScope would have produced for an active member. The
// role-tier assertions the old suite made (VIEWER cannot write, STAFF cannot
// issue) were removed together with the role tiers — the flat workspace grants
// every member every action, which is what the services now enforce.
//
// `request` is always null; the services only read it for audit metadata.

import type { WorkspaceScope } from "@/modules/workspace/service";

export interface TestServiceContext {
  scope: WorkspaceScope;
  request: null;
}

/**
 * A service context for one user in one organization. The name/slug/status
 * fields are synthetic but valid — src reads only scope.organizationId and
 * scope.userId for its queries, and scope.organizationStatus only for the
 * suspended-organization rule (feature 09), which these contexts keep ACTIVE.
 */
export function ctxFor(
  organizationId: string,
  userId: string,
): TestServiceContext {
  return {
    scope: {
      organizationId,
      organizationName: "Organisasi Uji",
      organizationSlug: `org-${organizationId.slice(-8)}`,
      organizationStatus: "ACTIVE",
      userId,
      isAdmin: true,
    },
    request: null,
  };
}

/** Same as ctxFor but with a SUSPENDED organization (feature 09 rule). */
export function suspendedCtx(organizationId: string, userId: string): TestServiceContext {
  return {
    scope: {
      organizationId,
      organizationName: "Organisasi Uji",
      organizationSlug: `org-${organizationId.slice(-8)}`,
      organizationStatus: "SUSPENDED",
      userId,
      isAdmin: true,
    },
    request: null,
  };
}
