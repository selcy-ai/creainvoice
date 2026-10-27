// src/modules/signers/service.ts
// Signer domain. Feature 02 built the onboarding default signer; feature 10
// completes management CRUD (create/update/delete/set-default, paginated
// list). Optional signature images reuse the company-logo pipeline: resized,
// MIME-sniffed from content, random filename, recorded for storage usage.
//
// Placement note (ratified 2026-10-09, see context/.sdd-state.md): Signer
// stays in `modules/signers` per spec 10 item 3 — the architecture-standards
// row naming `modules/bank-accounts` as its owner is reported stale for a
// separate bundle sync; this builder does not edit context/standards files.

import { log } from "@/modules/audit/service";
import { AppError } from "@/lib/errors";
import type { WorkspaceScope } from "@/modules/workspace/service";
import { prepareImageUpload } from "@/lib/image";
import { assertCan } from "@/modules/workspace/permissions";
import { SIGNERS_PAGE_SIZE, type SignerInput } from "@/modules/signers/schema";
import { getStorageService } from "@/modules/storage";
import { logger } from "@/server/logger";
import { db, type Database } from "@/server/db";
import { invoiceProfiles, signers } from "@/db/schema";

type Signer = typeof signers.$inferSelect;
import { and, asc, count, desc, eq, isNotNull, ne } from "drizzle-orm";

export {
  signerSchema,
  type SignerFormValues,
  type SignerInput,
} from "@/modules/signers/schema";

export interface SignerServiceContext {
  scope: WorkspaceScope;
  request?: Request | null;
}

export interface SignerView {
  id: string;
  name: string;
  title: string | null;
  location: string | null;
  signaturePath: string | null;
  hasSignature: boolean;
  isDefault: boolean;
  isActive: boolean;
  /** ISO timestamp — management list column. */
  createdAt: string;
}

export function toSignerView(signer: Signer): SignerView {
  return {
    id: signer.id,
    name: signer.name,
    title: signer.title,
    location: signer.location,
    signaturePath: signer.signatureImagePath,
    hasSignature: Boolean(signer.signatureImagePath),
    isDefault: signer.isDefault,
    isActive: signer.isActive,
    createdAt: signer.createdAt.toISOString(),
  };
}

export async function getDefaultSigner(organizationId: string): Promise<Signer | null> {
  const rows = await db
    .select()
    .from(signers)
    .where(
      and(
        eq(signers.organizationId, organizationId),
        eq(signers.isDefault, true),
        eq(signers.isActive, true),
      ),
    )
    .orderBy(asc(signers.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/** Active signers only — the invoice editor's dropdown. */
export async function listSigners(organizationId: string): Promise<SignerView[]> {
  const rows = await db
    .select()
    .from(signers)
    .where(and(eq(signers.organizationId, organizationId), eq(signers.isActive, true)))
    .orderBy(asc(signers.createdAt));
  return rows.map(toSignerView);
}

/** Management list: paginated, every row (inactive included, badge honest). */
export async function listSignersPage(
  ctx: SignerServiceContext,
  options: { page?: number } = {},
): Promise<{
  rows: SignerView[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}> {
  assertCan("signer.view", ctx.scope);
  const pageSize = SIGNERS_PAGE_SIZE;
  const where = eq(signers.organizationId, ctx.scope.organizationId);
  const totalRows = await db.select({ value: count() }).from(signers).where(where);
  const total = Number(totalRows[0]?.value ?? 0);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, options.page ?? 1), pageCount);
  const rows = await db
    .select()
    .from(signers)
    .where(where)
    .orderBy(desc(signers.isDefault), asc(signers.createdAt), asc(signers.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return { rows: rows.map(toSignerView), total, page, pageSize, pageCount };
}

/** Org-scoped read for the detail page (IDOR → NOT_FOUND). Signer carries no
 * secret — VIEWER sees the same fields as an editor. */
export async function getSignerDetail(
  id: string,
  ctx: SignerServiceContext,
): Promise<SignerView> {
  assertCan("signer.view", ctx.scope);
  const rows = await db
    .select()
    .from(signers)
    .where(and(eq(signers.id, id), eq(signers.organizationId, ctx.scope.organizationId)))
    .limit(1);
  if (!rows[0]) throw new AppError("NOT_FOUND", "Penanda tangan tidak ditemukan.");
  return toSignerView(rows[0]);
}

/** Storage pipeline for the optional image: undefined = "keep the stored
 * path" (never silently erased), null = explicitly none. */
async function uploadSignatureImage(
  file: File | null | undefined,
  organizationId: string,
): Promise<string | null | undefined> {
  if (!file || file.size === 0) return undefined;
  const { file: prepared } = await prepareImageUpload(file, { maxWidth: 600 });
  const stored = await getStorageService().upload(prepared, {
    orgId: organizationId,
    kind: "signature",
    allowedMimeTypes: ["image/png", "image/jpeg", "image/webp"],
  });
  return stored.path;
}

async function deleteStoredImage(path: string | null): Promise<void> {
  if (!path) return;
  await getStorageService()
    .delete(path)
    .catch((error: unknown) =>
      logger.warn(
        { module: "signers", err: error instanceof Error ? error.message : String(error) },
        "gambar tanda tangan lama gagal dihapus",
      ),
    );
}

/** Profile defaults follow the org default (feature 02 pattern: the editor
 * prefills from `InvoiceProfile.defaultSignerId`, and with one profile per
 * organisation — recorded feature-08 decision — the two must not drift). */
async function pointProfilesAtSigner(
  client: Pick<Database, "update">,
  organizationId: string,
  signerId: string | null,
  onlyProfilesPointingAt?: string,
): Promise<void> {
  await client
    .update(invoiceProfiles)
    .set({ defaultSignerId: signerId })
    .where(
      and(
        eq(invoiceProfiles.organizationId, organizationId),
        onlyProfilesPointingAt
          ? eq(invoiceProfiles.defaultSignerId, onlyProfilesPointingAt)
          : isNotNull(invoiceProfiles.id),
      ),
    );
}

async function clearOtherDefaults(
  client: Pick<Database, "update">,
  organizationId: string,
  keepId: string,
): Promise<void> {
  await client
    .update(signers)
    .set({ isDefault: false })
    .where(
      and(
        eq(signers.organizationId, organizationId),
        eq(signers.isDefault, true),
        ne(signers.id, keepId),
      ),
    );
}

export async function createSigner(
  input: SignerInput,
  ctx: SignerServiceContext,
  options: { signatureFile?: File | null } = {},
): Promise<Signer> {
  assertCan("signer.create", ctx.scope);
  const organizationId = ctx.scope.organizationId;

  const defaultRows = await db
    .select({ id: signers.id })
    .from(signers)
    .where(and(eq(signers.organizationId, organizationId), eq(signers.isDefault, true)))
    .limit(1);
  // First signer is always the default; afterwards the checkbox decides.
  const makeDefault = input.isDefault === true || defaultRows.length === 0;

  // Upload before the transaction: storage is not transactional (feature 07
  // rule) — a failed tx leaves no orphan row, only a stray file we do not link.
  const signaturePath = (await uploadSignatureImage(options.signatureFile, organizationId)) ?? null;

  let signer: Signer | undefined;
  await db.transaction(async (tx) => {
    if (makeDefault) {
      await tx
        .update(signers)
        .set({ isDefault: false })
        .where(and(eq(signers.organizationId, organizationId), eq(signers.isDefault, true)));
    }
    const created = await tx
      .insert(signers)
      .values({
        organizationId,
        name: input.name,
        title: input.title ?? null,
        location: input.location ?? null,
        signatureImagePath: signaturePath,
        isDefault: makeDefault,
        isActive: input.isActive ?? true,
      })
      .returning();
    signer = created[0] ?? null;
    if (signer && makeDefault) await pointProfilesAtSigner(tx, organizationId, signer.id);
  });
  if (!signer) throw new AppError("INTERNAL_ERROR", "Penanda tangan gagal dibuat.");

  await log({
    actorUserId: ctx.scope.userId,
    organizationId,
    action: "PROFILE_CHANGED",
    entityType: "signer",
    entityId: signer.id,
    metadata: {
      change: "created",
      name: signer.name,
      isDefault: makeDefault,
      hasSignature: Boolean(signer.signatureImagePath),
    },
    request: ctx.request ?? null,
  });
  return signer;
}

export async function updateSigner(
  id: string,
  input: SignerInput,
  ctx: SignerServiceContext,
  options: { signatureFile?: File | null } = {},
): Promise<Signer> {
  assertCan("signer.update", ctx.scope);
  const organizationId = ctx.scope.organizationId;
  const existingRows = await db
    .select()
    .from(signers)
    .where(and(eq(signers.id, id), eq(signers.organizationId, organizationId)))
    .limit(1);
  const existing = existingRows[0];
  if (!existing) throw new AppError("NOT_FOUND", "Penanda tangan tidak ditemukan.");

  const wantDefault = input.isDefault ?? existing.isDefault;
  const becameDefault = wantDefault && !existing.isDefault;
  const unsetDefault = !wantDefault && existing.isDefault;

  const signaturePath = await uploadSignatureImage(options.signatureFile, organizationId);
  const nextSignature = signaturePath === undefined ? existing.signatureImagePath : signaturePath;
  const replacedSignature = signaturePath !== undefined && signaturePath !== existing.signatureImagePath;

  let signer: Signer | undefined;
  await db.transaction(async (tx) => {
    if (becameDefault) await clearOtherDefaults(tx, organizationId, id);
    const updated = await tx
      .update(signers)
      .set({
        name: input.name,
        title: input.title ?? null,
        location: input.location ?? null,
        signatureImagePath: nextSignature,
        isActive: input.isActive ?? existing.isActive,
        isDefault: wantDefault,
      })
      .where(eq(signers.id, existing.id))
      .returning();
    signer = updated[0] ?? null;
    if (signer && becameDefault) await pointProfilesAtSigner(tx, organizationId, id);
    if (signer && unsetDefault) await pointProfilesAtSigner(tx, organizationId, null, id);
  });
  if (!signer) throw new AppError("INTERNAL_ERROR", "Penanda tangan gagal diperbarui.");

  // The replaced file can only be removed once the row no longer points at it.
  if (replacedSignature) await deleteStoredImage(existing.signatureImagePath);

  await log({
    actorUserId: ctx.scope.userId,
    organizationId,
    action: "PROFILE_CHANGED",
    entityType: "signer",
    entityId: signer.id,
    metadata: {
      change: becameDefault || unsetDefault ? "defaultChanged" : "updated",
      name: signer.name,
      isDefault: signer.isDefault,
      hasSignature: Boolean(signer.signatureImagePath),
    },
    request: ctx.request ?? null,
  });
  return signer;
}

/** "Jadikan penanda tangan utama" — idempotent; also what the edit checkbox does. */
export async function setDefaultSigner(
  id: string,
  ctx: SignerServiceContext,
): Promise<Signer> {
  assertCan("signer.update", ctx.scope);
  const organizationId = ctx.scope.organizationId;
  const existingRows = await db
    .select()
    .from(signers)
    .where(and(eq(signers.id, id), eq(signers.organizationId, organizationId)))
    .limit(1);
  const existing = existingRows[0];
  if (!existing) throw new AppError("NOT_FOUND", "Penanda tangan tidak ditemukan.");
  if (existing.isDefault) return existing;

  let signer: Signer | undefined;
  await db.transaction(async (tx) => {
    await clearOtherDefaults(tx, organizationId, id);
    const updated = await tx
      .update(signers)
      .set({ isDefault: true })
      .where(eq(signers.id, existing.id))
      .returning();
    signer = updated[0] ?? null;
    if (signer) await pointProfilesAtSigner(tx, organizationId, id);
  });
  if (!signer) throw new AppError("INTERNAL_ERROR", "Penanda tangan gagal diubah.");

  await log({
    actorUserId: ctx.scope.userId,
    organizationId,
    action: "PROFILE_CHANGED",
    entityType: "signer",
    entityId: signer.id,
    metadata: { change: "defaultChanged", name: signer.name, isDefault: true },
    request: ctx.request ?? null,
  });
  return signer;
}

/**
 * Hard delete (data-model: soft delete exists only for Customer). The FK on
 * InvoiceProfile.defaultSignerId is SetNull, so profile links clear on their
 * own; issued documents keep their frozen signerSnapshot. The stored image is
 * removed best-effort after the row is gone.
 */
export async function deleteSigner(
  id: string,
  ctx: SignerServiceContext,
): Promise<void> {
  assertCan("signer.delete", ctx.scope);
  const organizationId = ctx.scope.organizationId;
  const existingRows = await db
    .select()
    .from(signers)
    .where(and(eq(signers.id, id), eq(signers.organizationId, organizationId)))
    .limit(1);
  const existing = existingRows[0];
  if (!existing) throw new AppError("NOT_FOUND", "Penanda tangan tidak ditemukan.");

  await db.delete(signers).where(eq(signers.id, existing.id));
  await deleteStoredImage(existing.signatureImagePath);

  await log({
    actorUserId: ctx.scope.userId,
    organizationId,
    action: "PROFILE_CHANGED",
    entityType: "signer",
    entityId: existing.id,
    metadata: { change: "deleted", name: existing.name, wasDefault: existing.isDefault },
    request: ctx.request ?? null,
  });
}

/**
 * Creates the default signer or updates the existing default (onboarding
 * step 7 — feature 02 path, kept behaviorally intact). When `signatureFile` is
 * given it is MIME-sniffed, resized and stored first; a stored path is kept
 * when no new file is supplied (never silently erased).
 */
export async function saveSigner(
  input: SignerInput,
  ctx: SignerServiceContext,
  options: { signatureFile?: File | null } = {},
): Promise<Signer> {
  assertCan("org.settings.update", ctx.scope);

  const signaturePath = await uploadSignatureImage(options.signatureFile, ctx.scope.organizationId);

  const existing = await getDefaultSigner(ctx.scope.organizationId);

  let signer: Signer | undefined;
  if (existing) {
    const updated = await db
      .update(signers)
      .set({
        name: input.name,
        title: input.title ?? null,
        location: input.location ?? null,
        ...(signaturePath ? { signatureImagePath: signaturePath } : {}),
      })
      .where(eq(signers.id, existing.id))
      .returning();
    signer = updated[0] ?? null;
    if (signaturePath && existing.signatureImagePath && signaturePath !== existing.signatureImagePath) {
      await deleteStoredImage(existing.signatureImagePath);
    }
  } else {
    const created = await db
      .insert(signers)
      .values({
        organizationId: ctx.scope.organizationId,
        name: input.name,
        title: input.title ?? null,
        location: input.location ?? null,
        signatureImagePath: signaturePath ?? null,
        isDefault: true,
        isActive: true,
      })
      .returning();
    signer = created[0] ?? null;
  }
  if (!signer) throw new AppError("INTERNAL_ERROR", "Penanda tangan gagal disimpan.");

  // Link as the profile's default signer when a profile exists yet (mirrors
  // saveBankAccount: feature 06 reads defaultSignerId when rendering).
  const profileRows = await db
    .select({ id: invoiceProfiles.id })
    .from(invoiceProfiles)
    .where(
      and(
        eq(invoiceProfiles.organizationId, ctx.scope.organizationId),
        eq(invoiceProfiles.isActive, true),
      ),
    )
    .limit(1);
  if (profileRows[0]) {
    await db
      .update(invoiceProfiles)
      .set({ defaultSignerId: signer.id })
      .where(eq(invoiceProfiles.id, profileRows[0].id));
  }

  await log({
    actorUserId: ctx.scope.userId,
    organizationId: ctx.scope.organizationId,
    action: "PROFILE_CHANGED",
    entityType: "signer",
    entityId: signer.id,
    metadata: {
      change: existing ? "updated" : "created",
      name: signer.name,
      hasSignature: Boolean(signer.signatureImagePath),
    },
    request: ctx.request ?? null,
  });
  return signer;
}

/** Guard used by callers that expect a signer to already exist. */
export function assertSigner(signer: Signer | null): Signer {
  if (!signer) {
    throw new AppError("NOT_FOUND", "Penanda tangan tidak ditemukan.");
  }
  return signer;
}
