// src/modules/workspace/permissions.ts — authorization for the flat workspace.
//
// Change 6 removed modules/permissions (the OWNER/ADMIN/STAFF/VIEWER matrix
// and PlatformRole). Every member of an organization is a FULL ADMIN of that
// workspace, so there are no role tiers to compare: `can()` is now the single
// door that answers "does this caller have a verified, active organization
// scope?" — plus the suspended-organization rule (reads stay open, new
// mutations are refused), which was ratified in feature 09 and preserved by
// Change 6.
//
// The call API (can / assertCan / requireOrgScope) is intentionally identical
// to the old service so the feature modules keep authorizing at their entry
// points; what changed is that no role string exists anywhere.

import { AppError } from "@/lib/errors";

/** Context the permission door reads. `scope` comes from resolveWorkspaceScope. */
export interface PermissionContext {
  organizationId?: string | null;
  userId?: string | null;
  organizationStatus?: "ACTIVE" | "SUSPENDED" | null;
}

/**
 * Actions that only READ data — the only ones still allowed in a suspended
 * organization (ratified feature 09: "suspend blocks new mutations only;
 * reads/downloads remain allowed", preserved by Change 6).
 */
export const READ_ACTIONS: readonly string[] = [
  "org.view",
  "org.audit.view",
  "invoice.view",
  "invoice.download",
  "invoice.preview",
  "invoice.export",
  "invoice.draft.read",
  "customer.view",
  "project.view",
  "payment.view",
  "bankAccount.view",
  "signer.view",
  "report.view",
];

export const ORG_SUSPENDED_MESSAGE =
  "Organisasi ini ditangguhkan. Aksi baru tidak diizinkan.";

/** True when the context belongs to a suspended organization. */
export function isOrgSuspended(ctx: PermissionContext): boolean {
  return ctx.organizationStatus === "SUSPENDED";
}

/**
 * The one authorization decision. Flat workspace (Change 6): a caller with a
 * verified organization scope may do everything inside it; a suspended
 * organization grants read actions only. No scope → no permission (fail
 * closed).
 */
export function can(_action: string, ctx: PermissionContext): boolean {
  if (!ctx.organizationId || !ctx.userId) return false;
  if (isOrgSuspended(ctx) && !READ_ACTIONS.includes(_action)) return false;
  return true;
}

export interface OrgScope extends PermissionContext {
  organizationId: string;
  userId: string;
}

/**
 * Guard for org-scoped service functions: throws FORBIDDEN unless the context
 * carries an active organization and user.
 */
export function requireOrgScope(ctx: PermissionContext): asserts ctx is OrgScope {
  if (!ctx.organizationId) {
    throw new AppError(
      "FORBIDDEN",
      "Tidak ada organisasi aktif. Pilih organisasi terlebih dahulu.",
    );
  }
  if (!ctx.userId) {
    throw new AppError("FORBIDDEN", "Anda bukan anggota organisasi ini.");
  }
}

/** Throwing variant of can() for mutation entry points. */
export function assertCan(action: string, ctx: PermissionContext): void {
  requireOrgScope(ctx);
  if (can(action, ctx)) return;
  if (isOrgSuspended(ctx) && !READ_ACTIONS.includes(action)) {
    throw new AppError("FORBIDDEN", ORG_SUSPENDED_MESSAGE);
  }
  throw new AppError("FORBIDDEN", "Anda tidak memiliki izin untuk melakukan aksi ini.");
}
