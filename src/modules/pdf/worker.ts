// src/modules/pdf/worker.ts
// The PdfJob queue worker (feature 06 spec item 5). Runs as an interval
// inside the APP process (architecture decision: single instance is enough
// for the MVP — no sidecar, no external queue; see architecture-standards
// "Anti premature optimization").
//
// One cycle ("runOnce"):
//   1. Atomically claim the oldest PENDING job — a single
//      `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED)` so two
//      processes (or two overlapping ticks) can never run the same job.
//      The claim also bumps `attempt`, so every try is counted.
//   2. requestRender → pdf-service renders the print route into the shared
//      storage volume.
//   3. Read the file back, verify magic bytes + sha256 against the reported
//      metadata, re-persist via StorageService.saveInvoicePdf (the app-side
//      source of truth for the path), write the InvoicePdf record, set
//      invoice.pdfPath, audit PDF_GENERATED.
//   4. Success → SUCCESS + duration. Failure → PENDING again for another
//      attempt (the 5s poll IS the backoff) until attempt > 3 → FAILED with
//      a clear, secret-free errorMessage. The invoice stays ISSUED — a PDF
//      failure never un-issues a document.
//
// pdf-service being down therefore surfaces as: PENDING → (3 tries) → FAILED
// "Layanan PDF tidak dapat dihubungi..." and the invoice row is untouched.

import { createHash } from "node:crypto";
import { AppError, isAppError } from "@/lib/errors";
import { env } from "@/server/env";
import { logger } from "@/server/logger";
import { db } from "@/server/db";
import { invoicePdfs, invoices, pdfJobs } from "@/db/schema";
import { and, desc, eq, max, sql } from "drizzle-orm";
import { logAudit } from "@/modules/audit/service";
import { requestRender } from "@/modules/pdf/client";
import { getStorageService } from "@/modules/storage";

/** Attempts per job before it settles as FAILED (spec: retry maks 3). */
export const MAX_ATTEMPTS = 3;
/** Poll interval of the in-process loop (spec: poll interval 5s). */
export const POLL_INTERVAL_MS = 5_000;
/**
 * Minimum spacing between two attempts of the SAME job. Without it a failed
 * job (back to PENDING) would be re-claimed by the very same cycle and burn
 * all three attempts in one go — no backoff, no chance for pdf-service to
 * recover. With it, retries spread across polls (5s in production, and this
 * cooldown bounds same-cycle hammering). Tests import it to wait it out.
 */
export const RETRY_COOLDOWN_MS = 1_000;
/** A RUNNING claim older than this belongs to a dead process — requeue it. */
const STALE_RUNNING_MS = 600_000;
/** Safety valve so one cycle cannot spin forever on a hot queue. */
const MAX_JOBS_PER_CYCLE = 20;

interface ClaimedJob {
  id: string;
  invoiceId: string;
  attempt: number;
}

/** Shape of the raw SQL claim row (values arrive as string from the driver). */
interface ClientClaimedRow {
  id: string | number;
  invoiceId: string | number;
  attempt: string | number;
}

/**
 * Atomically claims the oldest claimable PENDING job (status → RUNNING,
 * attempt++). A job that just failed is skipped until RETRY_COOLDOWN_MS has
 * passed since its last claim. Returns null when nothing is claimable.
 * Raw SQL because Prisma has no `UPDATE ... SKIP LOCKED` sugar; this is the
 * lock the spec asks for.
 */
export async function claimNextJob(): Promise<ClaimedJob | null> {
  // Raw SQL because neither Prisma nor Drizzle has `UPDATE ... SKIP LOCKED`
  // sugar; this is the lock the spec asks for.
  const rows = await db.execute(sql`
    WITH claimed AS (
      UPDATE "pdf_job"
      SET "status" = 'RUNNING',
          "attempt" = "attempt" + 1,
          "started_at" = now()
      WHERE "id" = (
        SELECT "id" FROM "pdf_job"
        WHERE "status" = 'PENDING'
          AND ("started_at" IS NULL
               OR "started_at" < now() - (${RETRY_COOLDOWN_MS}::int * interval '1 millisecond'))
        ORDER BY "created_at" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id", "invoice_id" AS "invoiceId", "attempt"
    )
    SELECT "id", "invoiceId", "attempt" FROM claimed
  `);
  const row = rows.rows[0] as unknown as ClientClaimedRow | undefined;
  return row
    ? { id: String(row.id), invoiceId: String(row.invoiceId), attempt: Number(row.attempt) }
    : null;
}

/**
 * Queue hygiene: a RUNNING row whose claim is ancient means the process died
 * mid-render. Requeue it (the attempt was already counted at claim time, so
 * a crash loop still settles as FAILED after MAX_ATTEMPTS).
 */
export async function recoverStaleJobs(): Promise<void> {
  await db.execute(sql`
    UPDATE "pdf_job"
    SET "status" = 'PENDING',
        "error_message" = 'Render terputus (proses berhenti) — diantre ulang.'
    WHERE "status" = 'RUNNING'
      AND "started_at" < now() - (${STALE_RUNNING_MS}::int * interval '1 millisecond')
  `);
}

async function finishJob(
  jobId: string,
  outcome: "SUCCESS" | "FAILED" | "PENDING",
  durationMs: number,
  errorMessage: string | null,
): Promise<void> {
  if (outcome === "PENDING") {
    // Retry: back to the queue (the 5s poll is the backoff), keep the last
    // error visible on the row.
    await db
      .update(pdfJobs)
      .set({ status: "PENDING", errorMessage })
      .where(eq(pdfJobs.id, jobId));
    return;
  }
  await db
    .update(pdfJobs)
    .set({ status: outcome, errorMessage, finishedAt: new Date(), durationMs })
    .where(eq(pdfJobs.id, jobId));
}

/** Verify the bytes pdf-service wrote, then persist them as the app's own. */
async function persistPdf(
  invoiceId: string,
  metadata: { storagePath: string; filename: string; sizeBytes: number; sha256: string },
): Promise<{ pdfId: string; storagePath: string; version: number; sizeBytes: number }> {
  const invoiceRows = await db
    .select({
      id: invoices.id,
      organizationId: invoices.organizationId,
      invoiceDate: invoices.invoiceDate,
      issuedById: invoices.issuedById,
      createdById: invoices.createdById,
      issuerSnapshot: invoices.issuerSnapshot,
    })
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .limit(1);
  const invoice = invoiceRows[0];
  if (!invoice) {
    throw new AppError("NOT_FOUND", "Invoice tidak ditemukan untuk job PDF ini.");
  }

  const storage = getStorageService();
  const { data } = await storage.read(metadata.storagePath);
  if (data.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw new AppError("INTERNAL_ERROR", "File hasil render bukan PDF yang valid.");
  }
  const sha256 = createHash("sha256").update(data).digest("hex");
  if (sha256 !== metadata.sha256 || data.length !== metadata.sizeBytes) {
    throw new AppError(
      "INTERNAL_ERROR",
      "File hasil render tidak cocok dengan metadata (sha256/ukuran) — render ulang.",
    );
  }

  // saveInvoicePdf re-validates the path shape + magic bytes and returns the
  // canonical app-side path (identical to where pdf-service wrote, by design:
  // both sides share STORAGE_ROOT).
  const year = invoice.invoiceDate.getUTCFullYear();
  const saved = await storage.saveInvoicePdf(data, {
    orgId: invoice.organizationId,
    year,
    filename: metadata.filename,
  });
  if (saved.path !== metadata.storagePath) {
    throw new AppError("INTERNAL_ERROR", "Tujuan penyimpanan PDF tidak sesuai.");
  }

  const latestRows = await db
    .select({ latest: max(invoicePdfs.version) })
    .from(invoicePdfs)
    .where(eq(invoicePdfs.invoiceId, invoiceId));
  const version = (latestRows[0]?.latest ?? 0) + 1;

  const issuer = (invoice.issuerSnapshot ?? {}) as { templateKey?: string };
  const created = await db
    .insert(invoicePdfs)
    .values({
      invoiceId,
      version,
      storagePath: saved.path,
      originalFilename: metadata.filename,
      mimeType: "application/pdf",
      sizeBytes: BigInt(saved.size),
      sha256: saved.sha256,
      templateVersion: `${issuer.templateKey ?? "corporate-blue"}@1`,
      generatedById: invoice.issuedById ?? invoice.createdById ?? "",
      generatedAt: new Date(),
      isOfficial: true,
    })
    .returning();
  const pdf = created[0];
  if (!pdf) throw new AppError("INTERNAL_ERROR", "InvoicePdf gagal disimpan.");

  // Org-scoped update (IDOR-safe by construction: WHERE organizationId).
  await db
    .update(invoices)
    .set({ pdfPath: saved.path })
    .where(
      and(eq(invoices.id, invoiceId), eq(invoices.organizationId, invoice.organizationId)),
    );

  await logAudit({
    actorUserId: pdf.generatedById,
    organizationId: invoice.organizationId,
    action: "PDF_GENERATED",
    entityType: "Invoice",
    entityId: invoiceId,
    metadata: {
      pdfId: pdf.id,
      version,
      filename: metadata.filename,
      sizeBytes: saved.size,
      sha256: saved.sha256,
      storagePath: saved.path,
    },
  });

  return { pdfId: pdf.id, storagePath: saved.path, version, sizeBytes: saved.size };
}

function describeFailure(error: unknown): { message: string; permanent: boolean } {
  if (isAppError(error)) {
    return {
      message: error.message,
      // Missing invoice / bad payload will not fix themselves — no point
      // burning the remaining attempts.
      permanent: error.code === "NOT_FOUND" || error.code === "VALIDATION_ERROR",
    };
  }
  const raw = error instanceof Error ? error.message : String(error);
  return { message: `Gagal membuat PDF: ${raw.slice(0, 300)}`, permanent: false };
}

/** Processes ONE claimed job. Never throws — failures settle the job row. */
export async function processClaimedJob(job: ClaimedJob): Promise<void> {
  const t0 = Date.now();
  try {
    const metadata = await requestRender(job.invoiceId);
    const saved = await persistPdf(job.invoiceId, metadata);
    await finishJob(job.id, "SUCCESS", Date.now() - t0, null);
    logger.info(
      {
        module: "pdf",
        jobId: job.id,
        invoiceId: job.invoiceId,
        attempt: job.attempt,
        pdfId: saved.pdfId,
        durationMs: Date.now() - t0,
      },
      "PDF invoice berhasil dibuat",
    );
  } catch (error) {
    const { message, permanent } = describeFailure(error);
    const exhausted = job.attempt >= MAX_ATTEMPTS || permanent;
    logger.warn(
      {
        module: "pdf",
        jobId: job.id,
        invoiceId: job.invoiceId,
        attempt: job.attempt,
        exhausted,
        err: message,
      },
      "PDF invoice gagal diproses",
    );
    await finishJob(job.id, exhausted ? "FAILED" : "PENDING", Date.now() - t0, message);
  }
}

/**
 * One poll cycle: drain the PENDING queue (bounded) and return how many jobs
 * were processed. Exported so tests drive the worker explicitly instead of
 * racing a timer (PDF_WORKER_ENABLED=false in tests/test.env).
 */
export async function runOnce(): Promise<number> {
  await recoverStaleJobs();
  let processed = 0;
  while (processed < MAX_JOBS_PER_CYCLE) {
    const job = await claimNextJob();
    if (!job) break;
    await processClaimedJob(job);
    processed += 1;
  }
  return processed;
}

// ─── In-process interval (single instance MVP) ───────────────────────────────

let interval: NodeJS.Timeout | null = null;
let ticking = false;

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await runOnce();
  } catch (error) {
    // A failed claim (DB blip) must never kill the loop.
    logger.error(
      { module: "pdf", err: error instanceof Error ? error.message : String(error) },
      "siklus worker PDF gagal",
    );
  } finally {
    ticking = false;
  }
}

/** Starts the poller (idempotent). No-op when PDF_WORKER_ENABLED=false. */
export function startPdfWorker(): void {
  if (interval) return;
  if (env.PDF_WORKER_ENABLED !== "true") {
    logger.info({ module: "pdf" }, "worker PDF dinonaktifkan (PDF_WORKER_ENABLED=false)");
    return;
  }
  interval = setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);
  // Never hold the process open just for the poller (tests, one-off scripts).
  interval.unref?.();
  logger.info(
    { module: "pdf", intervalMs: POLL_INTERVAL_MS },
    "worker PDF berjalan (interval di proses app)",
  );
  void tick(); // pick up jobs enqueued while the app was down
}

/** Stops the poller (tests / graceful shutdown). */
export function stopPdfWorker(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}
