// src/modules/storage/record.ts
// Feature 09 — UploadRecord bookkeeping: every upload/deleted file under
// `uploads/organizations/{orgId}/{kind}/` gets a row so the admin storage page
// can sum real usage from the database (spec: sum from DB records, not a
// scan-per-read).
//
// Writes are BEST-EFFORT (same contract as audit writes: an action never fails
// because of bookkeeping) and `reconcileUploadRecords()` is the safety net —
// it idempotently inserts rows for files that predate this feature or whose
// row write failed, so the totals self-heal before they are read. It only
// INSERTS: rows are removed through `delete()`, never by guessing from a scan.

import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { db } from "@/server/db";
import { organizations, uploadRecords } from "@/db/schema";
import { env } from "@/server/env";
import { eq, inArray, sql } from "drizzle-orm";
import { logger } from "@/server/logger";
import type {
  SaveInvoicePdfOptions,
  StorageService,
  StoredContent,
  StoredObject,
  UploadOptions,
} from "@/modules/storage/types";

/** Same segment policy as LocalStorageService path building. */
const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;
const UPLOAD_PREFIX = "uploads/organizations/";

/** Extensions LocalStorageService can write (sniffed, never client-declared). */
const EXTENSION_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

export function mimeFromExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  const ext = dot >= 0 ? filename.slice(dot).toLowerCase() : "";
  return EXTENSION_MIME[ext] ?? "application/octet-stream";
}

export interface ReconcileResult {
  /** Files found on disk under uploads/organizations. */
  scanned: number;
  /** Rows inserted for files that had none. */
  inserted: number;
}

/** Best-effort row for a fresh upload — `reconcileUploadRecords` heals a miss. */
export async function recordUpload(input: {
  organizationId: string;
  path: string;
  size: number;
  mimeType: string;
  kind: string;
}): Promise<void> {
  try {
    await db
      .insert(uploadRecords)
      .values({
        organizationId: input.organizationId,
        path: input.path,
        sizeBytes: BigInt(input.size),
        mimeType: input.mimeType,
        kind: input.kind,
      })
      .onConflictDoUpdate({
        target: uploadRecords.path,
        set: {
          sizeBytes: BigInt(input.size),
          mimeType: input.mimeType,
          kind: input.kind,
        },
      });
  } catch (error) {
    logger.error(
      { module: "storage", path: input.path, err: error instanceof Error ? error.message : String(error) },
      "pencatatan UploadRecord gagal (reconcile akan memperbaikinya)",
    );
  }
}

/** Best-effort removal of the row when the file itself is deleted. */
export async function recordDelete(path: string): Promise<void> {
  if (!path.startsWith(UPLOAD_PREFIX)) return;
  try {
    await db.delete(uploadRecords).where(eq(uploadRecords.path, path));
  } catch (error) {
    logger.error(
      { module: "storage", path, err: error instanceof Error ? error.message : String(error) },
      "penghapusan UploadRecord gagal",
    );
  }
}

/**
 * Walks `{STORAGE_ROOT}/uploads/organizations/{orgId}/{kind}/{file}` and
 * inserts a row for every file that has none (idempotent via the unique
 * `path` index + `skipDuplicates`). Missing root = nothing to reconcile.
 */
export async function reconcileUploadRecords(): Promise<ReconcileResult> {
  const root = resolve(env.STORAGE_ROOT, "uploads", "organizations");
  const rows: Array<{
    organizationId: string;
    path: string;
    sizeBytes: bigint;
    mimeType: string;
    kind: string;
  }> = [];
  let scanned = 0;

  const orgDirs = await listDirs(root);
  if (!orgDirs) return { scanned: 0, inserted: 0 };
  for (const orgDir of orgDirs) {
    if (!SAFE_SEGMENT.test(orgDir)) continue;
    const kindDirs = await listDirs(join(root, orgDir));
    if (!kindDirs) continue;
    for (const kind of kindDirs) {
      if (!SAFE_SEGMENT.test(kind)) continue;
      const kindPath = join(root, orgDir, kind);
      let names: string[];
      try {
        names = await readdir(kindPath);
      } catch {
        continue;
      }
      for (const name of names) {
        const filePath = join(kindPath, name);
        let info;
        try {
          info = await stat(filePath);
        } catch {
          continue;
        }
        if (!info.isFile()) continue;
        scanned += 1;
        rows.push({
          organizationId: orgDir,
          path: `${UPLOAD_PREFIX}${orgDir}/${kind}/${name}`,
          sizeBytes: BigInt(info.size),
          mimeType: mimeFromExtension(name),
          kind,
        });
      }
    }
  }

  if (rows.length === 0) return { scanned, inserted: 0 };

  // Only organizations that still exist: a file whose org was deleted (or a
  // leftover test fixture) has no parent row and would fail the FK — skipping
  // it keeps the reconcile idempotent instead of breaking the whole batch.
  const knownRows = await db.select({ id: organizations.id }).from(organizations);
  const known = new Set(knownRows.map((row) => row.id));
  const insertable = rows.filter((row) => known.has(row.organizationId));
  if (insertable.length === 0) return { scanned, inserted: 0 };

  try {
    // onConflictDoNothing emulates Prisma's createMany(skipDuplicates) over
    // the unique `path` index.
    const created = await db
      .insert(uploadRecords)
      .values(insertable)
      .onConflictDoNothing({ target: uploadRecords.path });
    return { scanned, inserted: created.rowCount ?? 0 };
  } catch (error) {
    logger.error(
      { module: "storage", err: error instanceof Error ? error.message : String(error) },
      "reconcile UploadRecord gagal",
    );
    return { scanned, inserted: 0 };
  }
}

/** Subdirectory names, or null when the directory does not exist. */
async function listDirs(path: string): Promise<string[] | null> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    logger.error(
      { module: "storage", path, err: error instanceof Error ? error.message : String(error) },
      "gagal membaca direktori uploads",
    );
    return null;
  }
}

/**
 * StorageService decorator that keeps UploadRecord in sync. `getStorageService`
 * returns this wrapper, so no caller (profiles, signers, projects, payments)
 * had to change — the architecture's single DI point stays the single
 * bookkeeping point.
 */
export class RecordingStorageService implements StorageService {
  public constructor(private readonly inner: StorageService) {}

  async upload(file: File, options: UploadOptions): Promise<StoredObject> {
    const stored = await this.inner.upload(file, options);
    await recordUpload({
      organizationId: options.orgId,
      path: stored.path,
      size: stored.size,
      mimeType: stored.mimeType,
      kind: options.kind,
    });
    return stored;
  }

  async delete(path: string): Promise<void> {
    await this.inner.delete(path);
    await recordDelete(path);
  }

  async read(path: string): Promise<StoredContent> {
    return this.inner.read(path);
  }

  /** PDFs are tracked by InvoicePdf (feature 06), never by UploadRecord. */
  async saveInvoicePdf(data: Buffer, options: SaveInvoicePdfOptions): Promise<StoredObject> {
    return this.inner.saveInvoicePdf(data, options);
  }
}
