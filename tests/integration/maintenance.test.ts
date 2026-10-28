// tests/integration/maintenance.test.ts — feature 11A Check When Done,
// proven end to end by running the REAL script (scripts/maintenance.mjs as a
// child process) against the test database and an isolated storage root:
//
//   - orphan cleanup: a file with NO database record is deleted (uploads tree
//     AND the generated-invoice PDFs tree); files WITH a record (UploadRecord
//     row, Invoice.pdfPath) survive untouched
//   - overdue recompute: eligible invoices past due become OVERDUE in bulk;
//     PAID/CANCELLED/DRAFT/REVISED are never touched; a due date equal to
//     today (Jakarta) stays ISSUED; an already-OVERDUE row is unchanged
//   - idempotency: a second run deletes 0 files and updates 0 invoices
//
// The storage root is a temp directory — never the shared .data-test fixture
// tree — so this sweep cannot eat another suite's files.

import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { parseCalendarDate, todayInJakarta } from "@/lib/date";
import { createCustomer, type CustomerFormInput } from "@/modules/customers/service";
import { createProfile } from "@/modules/profiles/service";
import { db } from "@/tests/helpers/test-db";
import { env } from "@/server/env";
import type { InvoiceStatus } from "@/db/enums";
import {
  addMembership,
  createOrganization,
  createUser,
  resetDatabase,
  type TestUser,
} from "../factories";
import { ctxFor } from "@/tests/helpers/context";

// 1×1 PNG — same fixture the storage tests use.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const PDF_BYTES = Buffer.from("%PDF-1.4\n% maintenance fixture\n%%EOF\n", "latin1");

let owner: TestUser;
let org: { id: string };
let profileId: string;
let customerId: string;

let storageRoot: string;

// Invoice fixtures — id per scenario, asserted after the run.
const ids: Record<string, string> = {};
// Due-date columns: UTC midnight of the calendar day (parseCalendarDate).
let todayUtc: Date;
let yesterdayUtc: Date;
let tomorrowUtc: Date;

let firstRunStdout = "";

async function seedInvoice(status: InvoiceStatus, dueDate: Date | null): Promise<string> {
  const row = await db.invoice.create({
    data: {
      organizationId: org.id,
      profileId,
      customerId,
      createdById: owner.id,
      invoiceType: "FULL",
      invoiceDate: todayUtc,
      dueDate,
      status,
      workValue: "1000000",
      itemsSubtotal: "1000000",
      billingBase: "1000000",
      grandTotal: "1000000",
    },
    select: { id: true },
  });
  return row.id;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function seedFile(relativePath: string, bytes: Buffer): Promise<void> {
  const absolute = join(storageRoot, relativePath);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, bytes);
}

/** Runs the real maintenance script (both jobs) against this suite's storage
 * root and the test database, returning its structured stdout. */
function runMaintenance(): string {
  return execFileSync(process.execPath, [join(process.cwd(), "scripts/maintenance.mjs")], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, STORAGE_ROOT: storageRoot },
  });
}

/**
 * Backdate a file past the orphan grace period. The grace guard (F-3) skips
 * files whose mtime is younger than 1 hour, because a fresh file's database
 * record may still be on its way. The fixtures here are seeded and swept in
 * the same tick, so an orphan that is *meant* to be stale must be aged past
 * the window — otherwise the sweep correctly skips it and the deletion
 * assertion proves nothing.
 */
async function agePastGrace(relativePath: string): Promise<void> {
  const absolute = join(storageRoot, relativePath);
  const stale = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2h > 1h grace
  await utimes(absolute, stale, stale);
}

function events(stdout: string, job: string, event: string): Record<string, unknown>[] {
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.job === job && entry.event === event);
}

beforeAll(async () => {
  await resetDatabase();
  owner = await createUser({ username: "maint11a" });
  org = await createOrganization("Organisasi Maintenance");
  await addMembership(owner.id, org.id, "OWNER");

  const ownerCtx = ctxFor(org.id, owner.id);
  profileId = (await createProfile(ownerCtx, { name: "Organisasi Maintenance", code: "OM" })).id;
  customerId = (
    await createCustomer({ companyName: "PT Maintenance Nusantara" } as CustomerFormInput, ownerCtx)
  ).id;

  const day = todayInJakarta();
  todayUtc = parseCalendarDate(day)!;
  yesterdayUtc = new Date(todayUtc.getTime() - 24 * 60 * 60 * 1000);
  tomorrowUtc = new Date(todayUtc.getTime() + 24 * 60 * 60 * 1000);

  // ── Invoice fixtures ────────────────────────────────────────────────────
  ids.issuedPast = await seedInvoice("ISSUED", yesterdayUtc);
  ids.sentPast = await seedInvoice("SENT", yesterdayUtc);
  ids.partialPast = await seedInvoice("PARTIALLY_PAID", yesterdayUtc);
  ids.issuedToday = await seedInvoice("ISSUED", todayUtc); // boundary: stays ISSUED
  ids.issuedFuture = await seedInvoice("ISSUED", tomorrowUtc);
  ids.issuedNoDue = await seedInvoice("ISSUED", null);
  ids.paidPast = await seedInvoice("PAID", yesterdayUtc);
  ids.cancelledPast = await seedInvoice("CANCELLED", yesterdayUtc);
  ids.draftPast = await seedInvoice("DRAFT", yesterdayUtc);
  ids.revisedPast = await seedInvoice("REVISED", yesterdayUtc);
  ids.alreadyOverdue = await seedInvoice("OVERDUE", yesterdayUtc);

  // ── Storage fixtures (isolated root) ────────────────────────────────────
  storageRoot = await mkdtemp(join("/tmp/opencode", "maintenance-"));

  // Orphan: no record anywhere → must be deleted. Aged past the grace period
  // — a real orphan is by definition a file that has been unreferenced for a
  // while, not one written a millisecond ago.
  ids.orphanUpload = `uploads/organizations/${org.id}/logos/orphan.png`;
  await seedFile(ids.orphanUpload, PNG);
  // Orphan in the generated-PDFs tree: no InvoicePdf / Invoice.pdfPath → deleted.
  ids.orphanPdf = `invoices/organizations/${org.id}/2026/orphan.pdf`;
  await seedFile(ids.orphanPdf, PDF_BYTES);
  await agePastGrace(ids.orphanUpload);
  await agePastGrace(ids.orphanPdf);

  // With a record (UploadRecord row) → must survive.
  ids.keptUpload = `uploads/organizations/${org.id}/logos/kept.png`;
  await seedFile(ids.keptUpload, PNG);
  await db.uploadRecord.create({
    data: {
      organizationId: org.id,
      path: ids.keptUpload,
      sizeBytes: BigInt(PNG.length),
      mimeType: "image/png",
      kind: "logos",
    },
  });

  // With a record in ANOTHER table (Invoice.pdfPath — PDFs are never in
  // UploadRecord) → must survive too.
  ids.keptPdf = `invoices/organizations/${org.id}/2026/kept.pdf`;
  await seedFile(ids.keptPdf, PDF_BYTES);
  await db.invoice.update({ where: { id: ids.issuedPast }, data: { pdfPath: ids.keptPdf } });

  firstRunStdout = runMaintenance();
}, 60_000);

afterAll(async () => {
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
});

describe("maintenance script — orphan file cleanup", () => {
  it("deletes files that have no database record (uploads and invoice PDFs)", async () => {
    expect(await fileExists(join(storageRoot, ids.orphanUpload!))).toBe(false);
    expect(await fileExists(join(storageRoot, ids.orphanPdf!))).toBe(false);

    const summaries = events(firstRunStdout, "orphan-cleanup", "summary");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.deleted).toBe(2);
    expect(summaries[0]?.failed).toBe(0);
  });

  it("keeps files that have a record (UploadRecord and Invoice.pdfPath)", async () => {
    expect(await fileExists(join(storageRoot, ids.keptUpload!))).toBe(true);
    expect(await fileExists(join(storageRoot, ids.keptPdf!))).toBe(true);

    const record = await db.uploadRecord.findUnique({ where: { path: ids.keptUpload! } });
    expect(record).not.toBeNull();
    expect(record?.organizationId).toBe(org.id);
    const invoice = await db.invoice.findUniqueOrThrow({ where: { id: ids.issuedPast! } });
    expect(invoice.pdfPath).toBe(ids.keptPdf);
  });

  it("never deletes a fresh orphan inside the grace period (TOCTOU guard)", async () => {
    // A file written milliseconds ago may simply not have its database row
    // yet — the sweep must leave it alone and catch it on a later pass.
    const fresh = `uploads/organizations/${org.id}/logos/fresh.png`;
    await seedFile(fresh, PNG);

    const stdout = runMaintenance();
    expect(await fileExists(join(storageRoot, fresh))).toBe(true);

    const summaries = events(stdout, "orphan-cleanup", "summary");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.deleted).toBe(0);
  });
});

describe("maintenance script — OVERDUE recompute", () => {
  it("marks eligible past-due invoices OVERDUE in bulk (batched, logged)", async () => {
    for (const key of ["issuedPast", "sentPast", "partialPast"]) {
      const row = await db.invoice.findUniqueOrThrow({ where: { id: ids[key]! } });
      expect(row.status, key).toBe("OVERDUE");
    }

    const batches = events(firstRunStdout, "overdue-recompute", "batch");
    expect(batches.length).toBeGreaterThanOrEqual(1);
    expect(batches[0]?.batch).toBe(1);

    const summaries = events(firstRunStdout, "overdue-recompute", "summary");
    expect(summaries).toHaveLength(1);
    // Exactly the three eligible past-due rows — the sweep is a no-op for the
    // boundary/settled fixtures seeded above.
    expect(summaries[0]?.updated).toBe(3);
  });

  it("never touches PAID, CANCELLED, DRAFT, REVISED or future/boundary/no-due rows", async () => {
    const expected: Record<string, InvoiceStatus> = {
      issuedToday: "ISSUED", // due_date exactly today → boundary, not overdue
      issuedFuture: "ISSUED",
      issuedNoDue: "ISSUED",
      paidPast: "PAID",
      cancelledPast: "CANCELLED",
      draftPast: "DRAFT",
      revisedPast: "REVISED",
      alreadyOverdue: "OVERDUE",
    };
    for (const [key, status] of Object.entries(expected)) {
      const row = await db.invoice.findUniqueOrThrow({ where: { id: ids[key]! } });
      expect(row.status, key).toBe(status);
    }
  });
});

describe("maintenance script — idempotency (Check When Done: jalankan 2×)", () => {
  it("a second run deletes nothing and updates nothing", async () => {
    // Every invoice in the test DB is a fixture of this suite (resetDatabase).
    const before = await db.invoice.findMany({
      select: { id: true, status: true },
      orderBy: { id: "asc" },
    });
    expect(before.length).toBe(11);

    const second = runMaintenance();

    const orphan = events(second, "orphan-cleanup", "summary");
    expect(orphan[0]?.deleted).toBe(0);
    expect(orphan[0]?.failed).toBe(0);

    const overdue = events(second, "overdue-recompute", "summary");
    expect(overdue[0]?.updated).toBe(0);

    const after = await db.invoice.findMany({
      select: { id: true, status: true },
      orderBy: { id: "asc" },
    });
    expect(after).toEqual(before);
  });
});

describe("maintenance script — structured output", () => {
  it("prints parseable JSON lines and exits cleanly", () => {
    const lines = firstRunStdout.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(4);
    for (const line of lines) {
      const entry = JSON.parse(line) as Record<string, unknown>;
      expect(entry.module).toBe("maintenance");
      expect(typeof entry.at).toBe("string");
    }
    // The run finished with the done event (no secret ever printed).
    const serialized = JSON.stringify(firstRunStdout);
    expect(serialized).not.toContain(process.env.DATABASE_URL);
    // Change 14: auth is self-hosted better-auth; the DB url + encryption key
    // are the only credentials the maintenance run could ever leak, and they
    // are never on stdout.
    expect(serialized).not.toContain(env.BANK_ACCOUNT_ENCRYPTION_KEY);
  });
});
