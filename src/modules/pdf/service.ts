// src/modules/pdf/service.ts
// PdfJob queue, client side (feature 05 spec item 5). Feature 05 only
// ENQUEUES a PENDING job when an invoice is issued and reports its honest
// status in the UI — the worker that picks the job up, calls pdf-service and
// writes the InvoicePdf row is feature 06.
//
// Contract with the invoices module (architecture-standards "Cross Module
// Contracts"): issue flow calls `enqueuePdfJob()` INSIDE its transaction, so a
// job row exists exactly when an ISSUED row exists — no orphan jobs, no
// missing job after a rollback.

import { AppError } from "@/lib/errors";
import type { WorkspaceScope } from "@/modules/workspace/service";
import { logAudit } from "@/modules/audit/service";
import { assertCan, requireOrgScope } from "@/modules/workspace/permissions";
import { getStorageService } from "@/modules/storage";
import { safePdfFilename } from "@/modules/pdf/client";
import { db, type Database } from "@/server/db";
import { invoicePdfs, invoices, pdfJobs } from "@/db/schema";
import type { PdfJobStatus } from "@/db/enums";
import { and, desc, eq } from "drizzle-orm";

type PdfJob = typeof pdfJobs.$inferSelect;

export interface PdfServiceContext {
  scope: WorkspaceScope;
  request?: Request | null;
}

/** Latest job for an invoice (newest first) — used for the honest status UI. */
export interface PdfJobView {
  status: PdfJobStatus;
  attempt: number;
  errorMessage: string | null;
  createdAt: string;
}

export const PDF_STATUS_LABELS: Record<PdfJobStatus, string> = {
  PENDING: "PDF menunggu",
  RUNNING: "PDF sedang dibuat",
  SUCCESS: "PDF siap",
  FAILED: "PDF gagal dibuat",
};

/**
 * Enqueue the official-PDF job for an issued invoice. Pass `tx` to join the
 * issue transaction (feature 05 does — the job row commits atomically with
 * the issue). Org-scoped read first: a foreign invoice id answers 404.
 */
type DbLike = Pick<Database, "select" | "insert">;

async function requireInvoiceInScope(
  invoiceId: string,
  organizationId: string,
  client: Pick<Database, "select">,
) {
  const rows = await client
    .select({ id: invoices.id, organizationId: invoices.organizationId })
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .limit(1);
  const invoice = rows[0];
  if (!invoice || invoice.organizationId !== organizationId) {
    throw new AppError("NOT_FOUND", "Invoice tidak ditemukan.");
  }
  return invoice;
}

export async function enqueuePdfJob(
  invoiceId: string,
  ctx: PdfServiceContext,
  tx?: DbLike,
): Promise<PdfJob> {
  requireOrgScope(ctx.scope);
  const client = tx ?? db;
  const invoice = await requireInvoiceInScope(invoiceId, ctx.scope.organizationId, client);
  const created = await client
    .insert(pdfJobs)
    .values({ invoiceId: invoice.id, status: "PENDING", attempt: 0 })
    .returning();
  const job = created[0];
  if (!job) throw new AppError("INTERNAL_ERROR", "Job PDF gagal dibuat.");
  return job;
}

/**
 * The invoice's newest PDF job, org-scoped (IDOR guard → 404). `null` means
 * no job was ever queued — the UI says so honestly instead of pretending a
 * file exists (feature 05 scope: no rendering, no fake download).
 */
export async function getPdfJob(
  invoiceId: string,
  ctx: PdfServiceContext,
  tx?: Pick<Database, "select">,
): Promise<PdfJobView | null> {
  requireOrgScope(ctx.scope);
  const client = tx ?? db;
  await requireInvoiceInScope(invoiceId, ctx.scope.organizationId, client);
  const rows = await client
    .select({
      status: pdfJobs.status,
      attempt: pdfJobs.attempt,
      errorMessage: pdfJobs.errorMessage,
      createdAt: pdfJobs.createdAt,
    })
    .from(pdfJobs)
    .where(eq(pdfJobs.invoiceId, invoiceId))
    .orderBy(desc(pdfJobs.createdAt))
    .limit(1);
  const job = rows[0];
  if (!job) return null;
  return {
    status: job.status,
    attempt: job.attempt,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt.toISOString(),
  };
}

/** The stored official PDF of an invoice (feature 06) — honest null when the
 *  file does not exist yet; never a placeholder link. */
export interface OfficialPdfView {
  filename: string;
  storagePath: string;
  sizeBytes: number;
  sha256: string;
  version: number;
  generatedAt: string;
}

/** Org-scoped (IDOR guard → 404). Read-only; no audit — downloads audit. */
export async function getOfficialPdf(
  invoiceId: string,
  ctx: PdfServiceContext,
): Promise<OfficialPdfView | null> {
  requireOrgScope(ctx.scope);
  const invoiceRows = await db
    .select({
      id: invoices.id,
      organizationId: invoices.organizationId,
      pdfPath: invoices.pdfPath,
    })
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .limit(1);
  const invoice = invoiceRows[0];
  if (!invoice || invoice.organizationId !== ctx.scope.organizationId) {
    throw new AppError("NOT_FOUND", "Invoice tidak ditemukan.");
  }
  if (!invoice.pdfPath) return null;
  const pdfRows = await db
    .select({
      storagePath: invoicePdfs.storagePath,
      originalFilename: invoicePdfs.originalFilename,
      sizeBytes: invoicePdfs.sizeBytes,
      sha256: invoicePdfs.sha256,
      version: invoicePdfs.version,
      generatedAt: invoicePdfs.generatedAt,
    })
    .from(invoicePdfs)
    .where(eq(invoicePdfs.invoiceId, invoiceId))
    .orderBy(desc(invoicePdfs.version))
    .limit(1);
  const pdf = pdfRows[0];
  if (!pdf) return null;
  return {
    filename: pdf.originalFilename,
    storagePath: pdf.storagePath,
    sizeBytes: Number(pdf.sizeBytes),
    sha256: pdf.sha256,
    version: pdf.version,
    generatedAt: pdf.generatedAt.toISOString(),
  };
}

export interface PdfDownload {
  bytes: Buffer;
  filename: string;
  sizeBytes: number;
}

/**
 * Secure download (feature 06 spec): session org scope + `invoice.download`
 * permission + org ownership (foreign id → 404) + the file must actually
 * exist (no PDF yet → 404, never a stub). Writes PDF_DOWNLOADED with the
 * requesting user as actor. The bytes are re-verified as a real PDF before
 * they leave the server.
 */
export async function downloadOfficialPdf(
  invoiceId: string,
  ctx: PdfServiceContext,
): Promise<PdfDownload> {
  assertCan("invoice.download", ctx.scope);
  requireOrgScope(ctx.scope);

  const invoiceRows = await db
    .select({
      id: invoices.id,
      organizationId: invoices.organizationId,
      number: invoices.number,
      pdfPath: invoices.pdfPath,
    })
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .limit(1);
  const invoice = invoiceRows[0];
  if (!invoice || invoice.organizationId !== ctx.scope.organizationId) {
    throw new AppError("NOT_FOUND", "Invoice tidak ditemukan.");
  }
  if (!invoice.pdfPath) {
    throw new AppError("NOT_FOUND", "PDF invoice ini belum tersedia.");
  }

  const storage = getStorageService();
  const { data, mimeType } = await storage.read(invoice.pdfPath);
  if (mimeType !== "application/pdf" || data.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw new AppError("INTERNAL_ERROR", "File PDF tidak valid.");
  }

  const pdfRows = await db
    .select({ originalFilename: invoicePdfs.originalFilename, version: invoicePdfs.version })
    .from(invoicePdfs)
    .where(eq(invoicePdfs.invoiceId, invoiceId))
    .orderBy(desc(invoicePdfs.version))
    .limit(1);
  const pdf = pdfRows[0];
  const filename = pdf?.originalFilename ?? safePdfFilename(invoice.id, invoice.number);

  await logAudit({
    actorUserId: ctx.scope.userId,
    organizationId: invoice.organizationId,
    action: "PDF_DOWNLOADED",
    entityType: "InvoicePdf",
    entityId: invoiceId,
    metadata: {
      filename,
      sizeBytes: data.length,
      version: pdf?.version ?? null,
    },
    request: ctx.request ?? null,
  });

  return { bytes: data, filename, sizeBytes: data.length };
}
