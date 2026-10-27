// tests/integration/pdf-render.test.ts
// Feature 06 "Check When Done" — the PDF acceptance suite. Two layers in one
// file because they only mean something together:
//
//   1. PRINT ROUTE: token gate (401 without / expired / wrong invoice, 404
//      for drafts) and the standalone HTML (Corporate Blue markup + print CSS
//      + <base> for fonts) served from the issued snapshots.
//   2. REAL pdf-service: the actual Node child process with Playwright
//      Chromium, rendering that print-route HTML through the signed /render
//      contract (health 200, unsigned → 401, expired → 401), then asserting
//      on the BYTES: A4 size, page count, selectable text (pdf-parse, never a
//      screenshot), PDF metadata (Title/Author), the acceptance sample
//      (DOWN PAYMENT 50%, totals, terbilang, PO footer, Halaman 1 dari 1)
//      and the 30-item multi-page document (repeated table header on page 2,
//      Halaman 2 dari 2, no blank page).
//
// Requires build output (`.next/static`) or a reachable dev/prod app for the
// stylesheet links; assertions are written so text always holds either way.

import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { PDFParse } from "pdf-parse";
import { env } from "@/server/env";
import { createProfile } from "@/modules/profiles/service";
import { saveBankAccount } from "@/modules/bank-accounts/service";
import { saveSigner } from "@/modules/signers/service";
import { createCustomer } from "@/modules/customers/service";
import { createDraft } from "@/modules/invoices/service";
import type { InvoiceDraftFormOutput } from "@/modules/invoices/schema";
import { issueInvoice } from "@/modules/invoices/issue-service";
import { invoicePdfFooter } from "@/modules/pdf/client";
import {
  PDF_TOKEN_TTL_MS,
  signPdfToken,
  type RenderTokenPayload,
} from "@/modules/pdf/token";
import { GET as printRouteGet } from "@/app/print/invoices/[id]/route";
import {
  addMembership,
  createOrganization,
  createUser,
  resetDatabase,
  type TestUser,
} from "../factories";
import { ctxFor } from "@/tests/helpers/context";

let owner: TestUser;
let org: { id: string };
let profileId: string;
let customerId: string;
let bankId: string;
let signerId: string;
/** Acceptance sample (DP 50% + PO) and the 30-item multi-page document. */
let sampleInvoiceId: string;
let multipageInvoiceId: string;

const ownerCtx = () => ctxFor(org.id, owner.id);

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

/** Whitespace-insensitive comparison — PDF text extraction adds stray breaks. */
function normalized(text: string): string {
  return text.replace(/\s+/g, "");
}
function lowerNormalized(text: string): string {
  return normalized(text).toLowerCase();
}

async function callPrintRoute(invoiceId: string, token?: string): Promise<Response> {
  const query = token ? `?token=${encodeURIComponent(token)}` : "";
  return printRouteGet(
    new Request(`http://localhost:3000/print/invoices/${invoiceId}${query}`),
    { params: Promise.resolve({ id: invoiceId }) },
  );
}

function printToken(invoiceId: string, expiry = Date.now() + PDF_TOKEN_TTL_MS): string {
  return signPdfToken({ p: "print", invoiceId, expiry }, env.INTERNAL_PDF_SECRET);
}

// ─── pdf-service child process ──────────────────────────────────────────────

let pdfChild: ChildProcess | null = null;
let pdfPort = 0;
/** Serves the REAL print route to pdf-service (stands in for the app). */
let appSim: http.Server;
let appSimPort = 0;

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return typeof address === "object" && address ? address.port : 0;
}

async function waitForHealth(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok) return;
      lastError = `status ${res.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`pdf-service /health tidak siap: ${lastError}`);
}

const renderLogs: string[] = [];

async function startPdfService(): Promise<void> {
  // Reserve a free port, then hand it to the child (small TOCTOU race —
  // acceptable for a test helper).
  pdfPort = await new Promise<number>((resolve) => {
    const probe = http.createServer();
    probe.once("listening", () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
    probe.listen(0, "127.0.0.1");
  });

  pdfChild = spawn(process.execPath, ["pdf-service/src/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(pdfPort),
      STORAGE_ROOT: env.STORAGE_ROOT,
      INTERNAL_PDF_SECRET: env.INTERNAL_PDF_SECRET,
      NODE_ENV: "production",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  pdfChild.stdout?.on("data", (chunk: Buffer) => renderLogs.push(chunk.toString()));
  pdfChild.stderr?.on("data", (chunk: Buffer) => renderLogs.push(chunk.toString()));
  await waitForHealth(pdfPort);
}

/** POST /render with the signed payload — the client's exact request shape. */
async function postRender(
  payload: RenderTokenPayload,
  options: { bearer?: string; useExpiredPayload?: boolean } = {},
): Promise<Response> {
  const token =
    options.bearer ??
    signPdfToken(
      options.useExpiredPayload
        ? { ...payload, expiry: Date.now() - 1 }
        : payload,
      env.INTERNAL_PDF_SECRET,
    );
  return fetch(`http://127.0.0.1:${pdfPort}/render`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(60_000),
  });
}

function renderPayloadFor(input: {
  invoiceId: string;
  number: string;
  referenceType: string | null;
  referenceNumber: string | null;
}): RenderTokenPayload {
  const issuerName = "CreaInvoice Studio";
  return {
    p: "render",
    printUrl: `http://127.0.0.1:${appSimPort}/print/invoices/${input.invoiceId}?token=placeholder`,
    storagePath: `invoices/organizations/${org.id}/2026/${input.number.replace(/\//g, "-")}.pdf`,
    filename: `${input.number.replace(/\//g, "-")}.pdf`,
    footer: invoicePdfFooter({
      referenceType: input.referenceType,
      referenceNumber: input.referenceNumber,
      customerName: "PT Cipta Karya Nusantara",
      issuerName,
    }),
    title: input.number,
    author: issuerName,
    expiry: Date.now() + PDF_TOKEN_TTL_MS,
  };
}

beforeAll(async () => {
  await resetDatabase();

  owner = await createUser({ username: "render.owner" });
  org = await createOrganization("CreaInvoice Studio");
  await addMembership(owner.id, org.id, "OWNER");

  const profile = await createProfile(ownerCtx(), { name: "CreaInvoice Studio", code: "SB" });
  profileId = profile.id;

  const customer = await createCustomer(
    {
      companyName: "PT Cipta Karya Nusantara",
      legalName: "PT Cipta Karya Nusantara",
      businessType: "Manufaktur",
      taxId: "01.2345.6789.000007",
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
      bankName: "Bank Mandiri",
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

  // ── Acceptance sample: DP 50% against a PO (master prompt bagian 33) ────
  const sample = await createDraft(
    draftValues({
      invoiceType: "DOWN_PAYMENT",
      billingPercent: "50",
      referenceType: "PURCHASE_ORDER",
      referenceNumber: "5198021181",
      stampMode: "E_METERAI",
      paymentTerms: "Termin 50% saat PO diterima",
    }),
    ownerCtx(),
  );
  await issueInvoice(sample.id, ownerCtx());
  sampleInvoiceId = sample.id;

  // ── Multi-page: 30 items force a second A4 page (spec: 30+ item →
  // halaman 2 ada header berulang + "Halaman 2 dari 2") — short single-line
  // descriptions so exactly two pages are produced. ──────────────────────
  const manyItems = Array.from({ length: 30 }, (_, index) => ({
    description: `Pekerjaan tahap ${index + 1}`,
    quantity: "1",
    unit: "Lot",
    unitPrice: "150000",
    discountAmount: "0",
  }));
  const multipage = await createDraft(draftValues({ items: manyItems }), ownerCtx());
  await issueInvoice(multipage.id, ownerCtx());
  multipageInvoiceId = multipage.id;

  // App simulator: pdf-service fetches the REAL print route from here.
  appSim = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const match = /^\/print\/invoices\/([^/]+)$/.exec(url.pathname);
      if (!match?.[1]) {
        res.writeHead(404).end("not found");
        return;
      }
      const invoiceId = match[1];
      const token = printToken(invoiceId);
      const response = await callPrintRoute(invoiceId, token);
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      res.writeHead(response.status, headers);
      res.end(await response.text());
    })().catch(() => {
      res.writeHead(500).end("print simulator error");
    });
  });
  appSimPort = await listen(appSim);

  await startPdfService();
}, 120_000);

afterAll(async () => {
  if (pdfChild?.pid) {
    pdfChild.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    if (pdfChild.exitCode === null) pdfChild.kill("SIGKILL");
  }
  await new Promise<void>((resolve) => appSim?.close(() => resolve()));
  await rm(path.join(env.STORAGE_ROOT, "invoices", "organizations", org?.id ?? "_none_"), {
    recursive: true,
    force: true,
  });
});

// ─── Print route ───────────────────────────────────────────────────────────

describe("print route token gate", () => {
  it("answers 401 without a token", async () => {
    const response = await callPrintRoute(sampleInvoiceId);
    expect(response.status).toBe(401);
  });

  it("answers 401 for an expired token", async () => {
    const response = await callPrintRoute(sampleInvoiceId, printToken(sampleInvoiceId, Date.now() - 1));
    expect(response.status).toBe(401);
  });

  it("answers 401 for a token issued for another invoice", async () => {
    const response = await callPrintRoute(sampleInvoiceId, printToken(multipageInvoiceId));
    expect(response.status).toBe(401);
  });

  it("answers 404 for a draft invoice (never renders an un-issued document)", async () => {
    const draft = await createDraft(draftValues(), ownerCtx());
    const response = await callPrintRoute(draft.id, printToken(draft.id));
    expect(response.status).toBe(404);
  });

  it("serves the Corporate Blue document of the issued snapshot", async () => {
    const response = await callPrintRoute(sampleInvoiceId, printToken(sampleInvoiceId));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const html = await response.text();

    // Document identity (rendered from the snapshot, not live relations).
    expect(html).toContain("INV/SB/VII/2026/001");
    expect(html).toContain("PT Cipta Karya Nusantara");
    expect(html).toContain("DOWN PAYMENT 50%");
    expect(html).toContain("5198021181");
    expect(html).toContain("Dua juta dua ratus lima puluh ribu rupiah");
    expect(html).toContain("Rp 2.250.000");
    expect(html).toContain("Slot E-Meterai");

    // Print environment: A4 page rule, repeated table header, no app chrome,
    // base href so fonts resolve for the headless browser.
    expect(html).toContain("@page { size: A4");
    expect(html).toContain("display: table-header-group");
    expect(html).toContain('<base href="http://localhost:3000/"');
    expect(html).toContain('aria-label="Pratinjau invoice"');
    // No app shell chrome in the print document.
    expect(html).not.toContain("<aside");
    expect(html).not.toContain("<nav");
  });
});

// ─── pdf-service: contract + real Chromium render ──────────────────────────

describe("pdf-service", () => {
  it("/health reports 200 with writable storage", async () => {
    const response = await fetch(`http://127.0.0.1:${pdfPort}/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; checks: { storage: string } };
    expect(body.status).toBe("ok");
    expect(body.checks.storage).toBe("ok");
  });

  it("/render without a signature answers 401", async () => {
    const response = await fetch(`http://127.0.0.1:${pdfPort}/render`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(401);
  });

  it("/render with an expired signature answers 401", async () => {
    const payload = renderPayloadFor({
      invoiceId: sampleInvoiceId,
      number: "INV/SB/VII/2026/001",
      referenceType: "PURCHASE_ORDER",
      referenceNumber: "5198021181",
    });
    const response = await postRender(payload, { useExpiredPayload: true });
    expect(response.status).toBe(401);
  });

  it("renders the acceptance sample: A4, 1 page, metadata, selectable text", async () => {
    const payload = renderPayloadFor({
      invoiceId: sampleInvoiceId,
      number: "INV/SB/VII/2026/001",
      referenceType: "PURCHASE_ORDER",
      referenceNumber: "5198021181",
    });
    const response = await postRender(payload);
    expect(response.status).toBe(200);
    const meta = (await response.json()) as {
      storagePath: string;
      filename: string;
      sizeBytes: number;
      mimeType: string;
      sha256: string;
    };
    expect(meta.storagePath).toBe(payload.storagePath);
    expect(meta.filename).toBe("INV-SB-VII-2026-001.pdf");
    expect(meta.mimeType).toBe("application/pdf");
    expect(meta.sizeBytes).toBeGreaterThan(1_000);

    const absolute = path.resolve(env.STORAGE_ROOT, meta.storagePath);
    expect(existsSync(absolute)).toBe(true);
    const bytes = await readFile(absolute);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const { createHash } = await import("node:crypto");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(meta.sha256);

    // Page geometry: exactly one A4 page (± 1pt for rounding).
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    const { width, height } = doc.getPage(0).getSize();
    expect(Math.abs(width - 595.28)).toBeLessThan(1.5);
    expect(Math.abs(height - 841.89)).toBeLessThan(1.5);

    // Metadata: Title = invoice number, Author = profile name.
    const parser = new PDFParse({ data: new Uint8Array(bytes) });
    const info = await parser.getInfo();
    expect(info.info?.Title).toBe("INV/SB/VII/2026/001");
    expect(info.info?.Author).toBe("CreaInvoice Studio");

    // Selectable text (bukan screenshot) — pdf-parse extracts the document.
    const text = await parser.getText();
    await parser.destroy();
    const flat = normalized(text.text);
    expect(flat).toContain("INV/SB/VII/2026/001");
    expect(flat).toContain(normalized("DOWN PAYMENT 50%"));
    expect(flat).toContain("900.000");
    expect(flat).toContain(normalized("Rp 4.500.000"));
    expect(flat).toContain(normalized("Rp 2.250.000"));
    expect(lowerNormalized(text.text)).toContain(
      lowerNormalized("Dua juta dua ratus lima puluh ribu rupiah"),
    );
    expect(flat).toContain("SlotE-Meterai");

    // Page footer from the PDF engine (bukan statis).
    expect(lowerNormalized(text.text)).toContain(
      lowerNormalized(
        "Invoice ini dibuat berdasarkan Purchase Order PT Cipta Karya Nusantara Nomor 5198021181.",
      ),
    );
    expect(flat).toContain(normalized("Halaman 1 dari 1"));
  }, 90_000);

  it("renders 30 items across two pages: repeated header, footer, no blank page", async () => {
    const payload = renderPayloadFor({
      invoiceId: multipageInvoiceId,
      number: "INV/SB/VII/2026/002",
      referenceType: null,
      referenceNumber: null,
    });
    const response = await postRender(payload);
    expect(response.status).toBe(200);
    const meta = (await response.json()) as { storagePath: string; sizeBytes: number };

    const bytes = await readFile(path.resolve(env.STORAGE_ROOT, meta.storagePath));
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");

    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(2);
    const page2 = doc.getPage(1).getSize();
    expect(Math.abs(page2.width - 595.28)).toBeLessThan(1.5);
    expect(Math.abs(page2.height - 841.89)).toBeLessThan(1.5);

    const parser = new PDFParse({ data: new Uint8Array(bytes) });
    const text = await parser.getText();
    await parser.destroy();

    // Every page carries content — no blank sheets.
    const page1Text = text.pages[0]?.text ?? "";
    const page2Text = text.pages[1]?.text ?? "";
    expect(page1Text.length).toBeGreaterThan(200);
    expect(page2Text.length).toBeGreaterThan(200);

    // The table header repeats on page 2 (thead + CSS table-header-group).
    expect(page2Text).toContain("Deskripsi");
    expect(page2Text).toContain("Harga Satuan");
    expect(page2Text).toContain("Jumlah");

    // Page numbers come from the engine: 2 dari 2.
    const flat = normalized(text.text);
    expect(flat).toContain(normalized("Halaman 2 dari 2"));
    // Issuer reference line (no PO on this one).
    expect(lowerNormalized(text.text)).toContain(
      lowerNormalized("Invoice ini diterbitkan oleh CreaInvoice Studio."),
    );
    // The grand total shows on page 2 with the signature block.
    expect(flat).toContain(normalized("Rp 4.500.000"));
    expect(page2Text).toContain("CreaInvoice Studio");
  }, 90_000);
});
