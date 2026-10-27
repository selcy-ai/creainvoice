// tests/integration/pdf-worker.test.ts
// Feature 06 "Check When Done" at the service layer:
//   • issue → PdfJob PENDING → worker runOnce → file on disk + InvoicePdf
//     record + invoice.pdfPath + audit PDF_GENERATED
//   • download: session scope + permission, Content-Disposition filename from
//     the invoice number, audit PDF_DOWNLOADED, foreign org 404, VIEWER ok
//   • pdf-service unreachable → attempt counter climbs to 3 → FAILED with a
//     clear errorMessage, invoice stays ISSUED (no half-states)
//
// pdf-service is faked by an HTTP server that performs the REAL contract:
// verify the signed render token (shared module), write the bytes to the
// signed storagePath under STORAGE_ROOT, answer with metadata. That keeps the
// test hermetic (no Chromium) while exercising token payloads end to end.

import { createHash } from "node:crypto";
import http from "node:http";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AppError, isAppError } from "@/lib/errors";
import { env } from "@/server/env";
import { db } from "@/tests/helpers/test-db";
import { createProfile } from "@/modules/profiles/service";
import { saveBankAccount } from "@/modules/bank-accounts/service";
import { saveSigner } from "@/modules/signers/service";
import { createCustomer } from "@/modules/customers/service";
import { createDraft } from "@/modules/invoices/service";
import type { InvoiceDraftFormOutput } from "@/modules/invoices/schema";
import { issueInvoice } from "@/modules/invoices/issue-service";
import { getInvoiceDetail } from "@/modules/invoices/detail-service";
import {
  downloadOfficialPdf,
  getOfficialPdf,
  type PdfServiceContext,
} from "@/modules/pdf/service";
import { verifyPdfToken, type RenderTokenPayload } from "@/modules/pdf/token";
import { runOnce, RETRY_COOLDOWN_MS } from "@/modules/pdf/worker";
import {
  addMembership,
  createOrganization,
  createUser,
  resetDatabase,
  type TestUser,
} from "../factories";
import { ctxFor } from "@/tests/helpers/context";

const PDF_BYTES = Buffer.from(
  "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n",
  "utf8",
);
const PDF_SHA = createHash("sha256").update(PDF_BYTES).digest("hex");

let owner: TestUser;
let staff: TestUser;
let viewer: TestUser;
let org: { id: string };
let foreignOrg: { id: string };
let profileId: string;
let customerId: string;
let bankId: string;
let signerId: string;

/** The fake pdf-service — verifies the token, writes, answers metadata. */
let fakeService: http.Server;
let fakePort = 0;
const originalPdfServiceUrl = env.PDF_SERVICE_URL;
/** Every /render the fake received (printUrl is proof the app signed it). */
const receivedPrintUrls: string[] = [];

// Change 6: role tiers are gone — ctxFor comes from the shared test helper.
const ownerCtx = () => ctxFor(org.id, owner.id);
const staffCtx = () => ctxFor(org.id, staff.id);
const viewerCtx = () => ctxFor(org.id, viewer.id);
const foreignCtx = () => ctxFor(foreignOrg.id, owner.id);

function draftValues(overrides: Partial<InvoiceDraftFormOutput> = {}): InvoiceDraftFormOutput {
  return {
    profileId,
    customerId,
    bankAccountId: bankId,
    signerId,
    invoiceType: "FULL",
    billingMode: "PERCENT",
    invoiceDate: "2026-07-01",
    items: [
      {
        description: "Pemasangan bracket frame",
        quantity: "5",
        unit: "Unit",
        unitPrice: "900000",
        discountAmount: "0",
      },
    ],
    ...overrides,
  } as InvoiceDraftFormOutput;
}

async function expectAppFailure(promise: Promise<unknown>, code: string): Promise<AppError> {
  let caught: unknown = null;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(isAppError(caught)).toBe(true);
  const appError = caught as AppError;
  expect(appError.code).toBe(code);
  return appError;
}

beforeAll(async () => {
  await resetDatabase();

  owner = await createUser({ username: "pdf.owner" });
  staff = await createUser({ username: "pdf.staff" });
  viewer = await createUser({ username: "pdf.viewer" });
  org = await createOrganization("CreaInvoice Studio");
  foreignOrg = await createOrganization("Org Lain");
  await addMembership(owner.id, org.id, "OWNER");
  await addMembership(staff.id, org.id, "STAFF");
  await addMembership(viewer.id, org.id, "VIEWER");

  const profile = await createProfile(ownerCtx(), { name: "CreaInvoice Studio", code: "SB" });
  profileId = profile.id;

  const customer = await createCustomer(
    {
      companyName: "PT Cipta Karya Nusantara",
      legalName: "PT Cipta Karya Nusantara",
      businessType: "Manufaktur",
      taxId: "01.2345.6789.000005",
      address: "Jl. Industri No. 7",
      city: "Bekasi",
      province: "Jawa Barat",
      postalCode: "17111",
      country: "Indonesia",
      phone: "0215550177",
      whatsapp: "",
      email: "ap@ciptakarya.co.id",
      isActive: true,
    },
    ownerCtx(),
  );
  customerId = customer.id;

  const bank = await saveBankAccount(
    {
      bankName: "Bank Uji",
      accountNumber: "1234567890123456",
      accountHolder: "PT CreaInvoice Studio",
      branch: "KCP Sudirman",
    },
    ownerCtx(),
  );
  bankId = bank.id;
  const signer = await saveSigner(
    { name: "CreaInvoice Studio", title: "Direktur", location: "Yogyakarta" },
    ownerCtx(),
  );
  signerId = signer.id;

  // ── Fake pdf-service: same contract as the real one ──────────────────────
  fakeService = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/render") {
      res.writeHead(404).end();
      return;
    }
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const payload = verifyPdfToken<RenderTokenPayload>(token, env.INTERNAL_PDF_SECRET, "render");
    if (!payload) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    receivedPrintUrls.push(payload.printUrl);
    void (async () => {
      const absolute = path.resolve(env.STORAGE_ROOT, payload.storagePath);
      if (!absolute.startsWith(path.resolve(env.STORAGE_ROOT) + path.sep)) {
        res.writeHead(400).end();
        return;
      }
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, PDF_BYTES);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          storagePath: payload.storagePath,
          filename: payload.filename,
          sizeBytes: PDF_BYTES.length,
          mimeType: "application/pdf",
          sha256: PDF_SHA,
        }),
      );
    })().catch(() => {
      res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => fakeService.listen(0, "127.0.0.1", resolve));
  const address = fakeService.address();
  fakePort = typeof address === "object" && address ? address.port : 0;
  env.PDF_SERVICE_URL = `http://127.0.0.1:${fakePort}`;
}, 60_000);

afterEach(() => {
  env.PDF_SERVICE_URL = `http://127.0.0.1:${fakePort}`;
});

afterAll(async () => {
  env.PDF_SERVICE_URL = originalPdfServiceUrl;
  await new Promise<void>((resolve) => fakeService.close(() => resolve()));
});

// ─── Happy path: issue → worker → file + record + audit ────────────────────

describe("worker happy path", () => {
  it("processes the pending job into a stored official PDF", async () => {
    const draft = await createDraft(draftValues(), ownerCtx());
    const issued = await issueInvoice(draft.id, ownerCtx());
    expect(issued.number).toBe("INV/SB/VII/2026/001");

    const jobBefore = await db.pdfJob.findFirst({
      where: { invoiceId: draft.id },
      orderBy: { createdAt: "desc" },
    });
    expect(jobBefore?.status).toBe("PENDING");

    const processed = await runOnce();
    expect(processed).toBeGreaterThanOrEqual(1);

    const job = await db.pdfJob.findFirst({
      where: { invoiceId: draft.id },
      orderBy: { createdAt: "desc" },
    });
    expect(job?.status).toBe("SUCCESS");
    expect(job?.attempt).toBe(1);
    expect(job?.errorMessage).toBeNull();
    expect(job?.durationMs).toBeGreaterThanOrEqual(0);

    // The invoice points at the stored file.
    const invoice = await db.invoice.findUnique({ where: { id: draft.id } });
    expect(invoice?.pdfPath).toBe(
      `invoices/organizations/${org.id}/2026/INV-SB-VII-2026-001.pdf`,
    );

    // The file exists on disk and is a real PDF.
    const absolute = path.resolve(env.STORAGE_ROOT, invoice!.pdfPath!);
    expect(existsSync(absolute)).toBe(true);
    const bytes = await readFile(absolute);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");

    // InvoicePdf record: version 1, official, matching hash.
    const pdf = await db.invoicePdf.findFirst({
      where: { invoiceId: draft.id },
      orderBy: { version: "asc" },
    });
    expect(pdf).not.toBeNull();
    expect(pdf?.version).toBe(1);
    expect(pdf?.isOfficial).toBe(true);
    expect(pdf?.mimeType).toBe("application/pdf");
    expect(pdf?.originalFilename).toBe("INV-SB-VII-2026-001.pdf");
    expect(pdf?.sha256).toBe(PDF_SHA);
    expect(Number(pdf?.sizeBytes)).toBe(PDF_BYTES.length);

    // The app signed a PRINT token inside printUrl (not inline HTML).
    expect(receivedPrintUrls.at(-1)).toContain(`/print/invoices/${draft.id}?token=`);

    // Audit PDF_GENERATED with the requesting actor (the issuer).
    const audit = await db.auditLog.findFirst({
      where: { action: "PDF_GENERATED", entityId: draft.id },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
    expect(audit?.organizationId).toBe(org.id);
    expect(audit?.actorUserId).toBe(owner.id);
    expect((audit?.metadata as { filename?: string }).filename).toBe(
      "INV-SB-VII-2026-001.pdf",
    );

    // Detail view exposes the file (drives the real download button).
    const detail = await getInvoiceDetail(draft.id, ownerCtx());
    expect(detail.pdf).not.toBeNull();
    expect(detail.pdf?.filename).toBe("INV-SB-VII-2026-001.pdf");
  });
});

// ─── Secure download ───────────────────────────────────────────────────────

describe("secure download", () => {
  let issuedId: string;
  let issuedNumber: string | null;

  beforeAll(async () => {
    const draft = await createDraft(draftValues(), ownerCtx());
    await issueInvoice(draft.id, ownerCtx());
    await runOnce();
    const invoice = await db.invoice.findUnique({ where: { id: draft.id } });
    issuedId = draft.id;
    issuedNumber = invoice?.number ?? null;
  }, 60_000);

  it("returns the bytes with an attachment filename derived from the number", async () => {
    const download = await downloadOfficialPdf(issuedId, ownerCtx());
    expect(download.filename).toBe("INV-SB-VII-2026-002.pdf");
    expect(issuedNumber).toBe("INV/SB/VII/2026/002");
    expect(download.bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");

    const audit = await db.auditLog.findFirst({
      where: { action: "PDF_DOWNLOADED", entityId: issuedId },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
    expect(audit?.actorUserId).toBe(owner.id);
    expect((audit?.metadata as { filename?: string }).filename).toBe(
      "INV-SB-VII-2026-002.pdf",
    );
  });

  it("allows a VIEWER (matrix grants invoice.download)", async () => {
    const download = await downloadOfficialPdf(issuedId, viewerCtx());
    expect(download.filename).toContain(".pdf");
    expect(download.bytes.length).toBeGreaterThan(0);
  });

  it("allows a STAFF member (spec: STAFF+ bisa download)", async () => {
    const download = await downloadOfficialPdf(issuedId, staffCtx());
    expect(download.filename).toContain(".pdf");
    expect(download.bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("answers 404 for another organization's invoice (IDOR guard)", async () => {
    const error = await expectAppFailure(downloadOfficialPdf(issuedId, foreignCtx()), "NOT_FOUND");
    expect(error.message).toBe("Invoice tidak ditemukan.");
  });

  it("answers 404 when the file does not exist yet (honest, no stub)", async () => {
    const draft = await createDraft(draftValues(), ownerCtx());
    await issueInvoice(draft.id, ownerCtx()); // job PENDING — no worker run
    const error = await expectAppFailure(downloadOfficialPdf(draft.id, ownerCtx()), "NOT_FOUND");
    expect(error.message).toBe("PDF invoice ini belum tersedia.");
    expect(await getOfficialPdf(draft.id, ownerCtx())).toBeNull();
    // Queue hygiene for the failure test below: only ITS job may be pending.
    await db.pdfJob.deleteMany({ where: { invoiceId: draft.id } });
  });
});

// ─── Snapshot immutability of the stored PDF ───────────────────────────────

describe("official PDF immutability", () => {
  it("editing the profile after issue never touches the stored PDF", async () => {
    const draft = await createDraft(draftValues(), ownerCtx());
    await issueInvoice(draft.id, ownerCtx());
    await runOnce();

    const before = await db.invoice.findUnique({ where: { id: draft.id } });
    expect(before?.pdfPath).not.toBeNull();
    const bytesBefore = await readFile(path.resolve(env.STORAGE_ROOT, before!.pdfPath!));
    const pdfBefore = await db.invoicePdf.findFirst({
      where: { invoiceId: draft.id },
      orderBy: { version: "asc" },
    });

    // Mutate everything the document was rendered from.
    await saveBankAccount(
      { bankName: "Bank Sesudah Edit", accountNumber: "9999999999999999", accountHolder: "PT Baru" },
      ownerCtx(),
    );
    await saveSigner({ name: "Penanda Tangan Baru", title: "Manager", location: "Bandung" }, ownerCtx());

    // No new job exists (issue enqueued exactly one) — so nothing re-renders.
    expect(await runOnce()).toBe(0);

    const after = await db.invoice.findUnique({ where: { id: draft.id } });
    expect(after?.pdfPath).toBe(before?.pdfPath);
    const bytesAfter = await readFile(path.resolve(env.STORAGE_ROOT, after!.pdfPath!));
    expect(bytesAfter.equals(bytesBefore)).toBe(true);

    const pdfAfter = await db.invoicePdf.findFirst({
      where: { invoiceId: draft.id },
      orderBy: { version: "asc" },
    });
    expect(pdfAfter?.sha256).toBe(pdfBefore?.sha256);
    expect(pdfAfter?.version).toBe(pdfBefore?.version);
    // Still exactly one official record — the file is stored, never rebuilt.
    expect(await db.invoicePdf.count({ where: { invoiceId: draft.id } })).toBe(1);
  }, 60_000);
});

// ─── Failure path: pdf-service down → retry 3 → FAILED ─────────────────────

describe("failure handling", () => {
  it("retries a dead pdf-service up to 3 attempts then FAILS; invoice untouched", async () => {
    const draft = await createDraft(draftValues(), ownerCtx());
    await issueInvoice(draft.id, ownerCtx());

    // Nothing listens on this port — every render attempt fails fast.
    env.PDF_SERVICE_URL = "http://127.0.0.1:9";

    // The cooldown keeps ONE cycle from burning every attempt at once; each
    // runOnce below is one spaced retry, mirroring the production polls.
    const waitOutCooldown = () =>
      new Promise((resolve) => setTimeout(resolve, RETRY_COOLDOWN_MS + 100));

    await runOnce(); // attempt 1 → back to PENDING
    let job = await db.pdfJob.findFirst({
      where: { invoiceId: draft.id },
      orderBy: { createdAt: "desc" },
    });
    expect(job?.status).toBe("PENDING");
    expect(job?.attempt).toBe(1);
    expect(job?.errorMessage).toContain("tidak dapat dihubungi");

    await waitOutCooldown();
    await runOnce(); // attempt 2 → PENDING
    job = await db.pdfJob.findFirst({
      where: { invoiceId: draft.id },
      orderBy: { createdAt: "desc" },
    });
    expect(job?.status).toBe("PENDING");
    expect(job?.attempt).toBe(2);

    await waitOutCooldown();
    await runOnce(); // attempt 3 → FAILED
    job = await db.pdfJob.findFirst({
      where: { invoiceId: draft.id },
      orderBy: { createdAt: "desc" },
    });
    expect(job?.status).toBe("FAILED");
    expect(job?.attempt).toBe(3);
    expect(job?.errorMessage).toContain("tidak dapat dihubungi");
    expect(job?.finishedAt).not.toBeNull();

    // The invoice is still issued and has no file — a PDF failure never
    // un-issues or half-updates a document.
    const invoice = await db.invoice.findUnique({ where: { id: draft.id } });
    expect(invoice?.status).toBe("ISSUED");
    expect(invoice?.pdfPath).toBeNull();
    expect(await getOfficialPdf(draft.id, ownerCtx())).toBeNull();

    // A later runOnce does not resurrect the settled job.
    expect(await runOnce()).toBe(0);
  }, 60_000);
});
