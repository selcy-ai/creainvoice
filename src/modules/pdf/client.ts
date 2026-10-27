// src/modules/pdf/client.ts
// App → pdf-service client (feature 06 spec item 4):
//   requestRender(invoiceId) → signed render token (HMAC + expiry 60s) →
//   POST {PDF_SERVICE_URL}/render → metadata { storagePath, filename,
//   sizeBytes, mimeType, sha256 }.
//
// pdf-service does NOT receive HTML inline: it fetches the app's print route
// with the signed PRINT token baked into `printUrl` (architecture decision —
// HTML always comes from the app, token auth is exercised end to end). Every
// value pdf-service needs travels inside the SIGNED payload, so nothing in
// the JSON body has to be trusted.

import { AppError } from "@/lib/errors";
import { db } from "@/server/db";
import { customers, invoices } from "@/db/schema";
import { eq } from "drizzle-orm";
import { env } from "@/server/env";
import { logger } from "@/server/logger";
import { signPdfToken, PDF_TOKEN_TTL_MS, type RenderTokenPayload } from "@/modules/pdf/token";

export interface RenderMetadata {
  storagePath: string;
  filename: string;
  sizeBytes: number;
  mimeType: string;
  sha256: string;
}

/** Generous budget: pdf-service's own render is 30s, plus print-route fetch
 *  retries (3 × 10s + backoff) inside it — the worker is background anyway. */
const RENDER_TIMEOUT_MS = 90_000;

/**
 * Safe download filename derived from the invoice number:
 * `INV/SB/VII/2026/001` → `INV-SB-VII-2026-001.pdf`. Only [A-Za-z0-9._-]
 * survives, length is bounded, and an unusable number falls back to the
 * invoice id — the name never comes from raw user input (path-traversal rule).
 */
export function safePdfFilename(invoiceId: string, number: string | null): string {
  const base = (number ?? "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80);
  return base ? `${base}.pdf` : `invoice-${invoiceId}.pdf`;
}

/**
 * The reference line pdf-service draws under every page (feature 06 spec:
 * `Invoice ini dibuat berdasarkan Purchase Order {customer} Nomor {ref}.`
 * otherwise `Invoice ini diterbitkan oleh {profile}.`). Exported for tests.
 */
export function invoicePdfFooter(input: {
  referenceType: string | null;
  referenceNumber: string | null;
  customerName: string | null;
  issuerName: string;
}): string {
  const isPurchaseOrder =
    input.referenceType === "PURCHASE_ORDER" && input.referenceNumber;
  if (isPurchaseOrder && input.customerName) {
    return `Invoice ini dibuat berdasarkan Purchase Order ${input.customerName} Nomor ${input.referenceNumber}.`;
  }
  return `Invoice ini diterbitkan oleh ${input.issuerName}.`;
}

interface IssuerSnapshotShape {
  name?: string;
}

/**
 * Asks pdf-service to render ONE issued invoice. Reads the row itself (org
 * scope verified against the row: a foreign id answers 404, never a render).
 */
export async function requestRender(invoiceId: string): Promise<RenderMetadata> {
  const rows = await db
    .select({
      id: invoices.id,
      organizationId: invoices.organizationId,
      number: invoices.number,
      status: invoices.status,
      invoiceDate: invoices.invoiceDate,
      referenceType: invoices.referenceType,
      referenceNumber: invoices.referenceNumber,
      issuerSnapshot: invoices.issuerSnapshot,
      customerCompany: customers.companyName,
    })
    .from(invoices)
    .leftJoin(customers, eq(customers.id, invoices.customerId))
    .where(eq(invoices.id, invoiceId))
    .limit(1);
  const invoice = rows[0];
  if (!invoice) {
    throw new AppError("NOT_FOUND", "Invoice tidak ditemukan.");
  }
  if (!invoice.number || invoice.status === "DRAFT") {
    throw new AppError("VALIDATION_ERROR", "Invoice belum diterbitkan — PDF hanya untuk invoice terbit.");
  }

  const issuer = (invoice.issuerSnapshot ?? {}) as IssuerSnapshotShape;
  const issuerName = issuer.name?.trim() || "creainvoice";

  const filename = safePdfFilename(invoice.id, invoice.number);
  const year = invoice.invoiceDate.getUTCFullYear();
  const storagePath = `invoices/organizations/${invoice.organizationId}/${year}/${filename}`;

  const now = Date.now();
  const printToken = signPdfToken(
    {
      p: "print",
      invoiceId: invoice.id,
      expiry: now + PDF_TOKEN_TTL_MS,
    },
    env.INTERNAL_PDF_SECRET,
  );
  const renderPayload: RenderTokenPayload = {
    p: "render",
    printUrl: `${env.INTERNAL_APP_URL}/print/invoices/${invoice.id}?token=${encodeURIComponent(printToken)}`,
    storagePath,
    filename,
    footer: invoicePdfFooter({
      referenceType: invoice.referenceType,
      referenceNumber: invoice.referenceNumber,
      customerName: invoice.customerCompany ?? null,
      issuerName,
    }),
    title: invoice.number,
    author: issuerName,
    expiry: now + PDF_TOKEN_TTL_MS,
  };
  const bearer = signPdfToken(renderPayload, env.INTERNAL_PDF_SECRET);

  let response: Response;
  try {
    response = await fetch(`${env.PDF_SERVICE_URL}/render`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(RENDER_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(
      { module: "pdf", invoiceId, err: message },
      "pdf-service tidak dapat dihubungi",
    );
    throw new AppError(
      "INTERNAL_ERROR",
      "Layanan PDF tidak dapat dihubungi. Percobaan berikutnya akan dijalankan otomatis.",
    );
  }

  if (!response.ok) {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: string; message?: string };
      detail = body.error ?? body.message ?? "";
    } catch {
      // Non-JSON error body — status alone is enough for the job message.
    }
    logger.warn(
      { module: "pdf", invoiceId, status: response.status },
      "pdf-service menolak permintaan render",
    );
    throw new AppError(
      "INTERNAL_ERROR",
      response.status === 401
        ? "Layanan PDF menolak tanda tangan permintaan (401) — periksa INTERNAL_PDF_SECRET."
        : `Layanan PDF merespons ${response.status}${detail ? `: ${detail}` : ""}.`,
    );
  }

  const metadata = (await response.json()) as Partial<RenderMetadata>;
  if (
    !metadata ||
    typeof metadata.storagePath !== "string" ||
    typeof metadata.filename !== "string" ||
    typeof metadata.sha256 !== "string" ||
    typeof metadata.sizeBytes !== "number" ||
    typeof metadata.mimeType !== "string"
  ) {
    throw new AppError("INTERNAL_ERROR", "Layanan PDF mengembalikan metadata yang tidak lengkap.");
  }
  if (metadata.storagePath !== storagePath) {
    throw new AppError("INTERNAL_ERROR", "Layanan PDF menyimpan file di luar tujuan yang diminta.");
  }
  return metadata as RenderMetadata;
}
