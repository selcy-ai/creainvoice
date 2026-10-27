// src/modules/invoices/issue-service.ts
// The ISSUE flow (feature 05): DRAFT → ISSUED. This is the only place a final
// invoice number is ever allocated and the only place the seven snapshots are
// written. Contract (feature 05 spec + architecture invariants 2–6):
//
//   1. Re-validate completeness (profile, customer, ≥1 item, billingBase > 0).
//   2. RECALCULATE every amount server-side from the persisted rows — the
//      client's totals are ignored (invariant 2).
//   3. Allocate the final number inside a SERIALIZABLE transaction that first
//      takes an EXCLUSIVE lock on "InvoiceSequence" (FIFO queue BEFORE the
//      MVCC snapshot exists — see the comment at the lock), then row-locks
//      the bucket (SELECT ... FOR UPDATE) with bounded retry on residual
//      conflict (invariant 3; at most 3 retries, then CONFLICT with the
//      invoice still a draft — total rollback).
//   4. Freeze the snapshots (invariant 4) and lock the financial columns.
//   5. DRAFT → ISSUED with issuedAt/issuedById/final number.
//   6. Write audit INVOICE_ISSUED and enqueue the PdfJob in the SAME
//      transaction (feature 06 processes it; feature 05 only enqueues).

import Decimal from "decimal.js";
import { AppError } from "@/lib/errors";
import { logger } from "@/server/logger";
import { db } from "@/server/db";
import {
  bankAccounts,
  customerContacts,
  customers,
  invoiceItems,
  invoiceProfiles,
  invoices,
  projectReferences,
  signers,
} from "@/db/schema";
import { and, asc, eq, sql } from "drizzle-orm";
import { log } from "@/modules/audit/service";
import { assertCan, requireOrgScope } from "@/modules/workspace/permissions";
import { allocateFinalNumber, buildNumberPreview } from "@/modules/invoices/numbering";
import { validateNumberPattern } from "@/modules/profiles/number-pattern";
import { sumBilledForProject } from "@/modules/invoices/billed";
import { calcFromRows, type InvoiceServiceContext } from "@/modules/invoices/service";
import { fullAccountNumber, toBankAccountView } from "@/modules/bank-accounts/service";
import { enqueuePdfJob } from "@/modules/pdf/service";
import type { InvoiceCalcResult } from "@/modules/invoices/calculation";
import type {
  BankSnapshot,
  CalculationSnapshot,
  ContactSnapshot,
  CustomerSnapshot,
  IssuerSnapshot,
  SignerSnapshot,
  TemplateSnapshot,
} from "@/modules/invoices/snapshots";
import { toJsonInput } from "@/modules/invoices/snapshots";
// Change 6: dropped Prisma (role tiers removed)

// ─── Retry on sequence / serialization conflict ───────────────────────────

/** Retries after the first attempt (spec: "retry terbatas (maks 3)"). */
export const ISSUE_MAX_RETRIES = 3;

/**
 * Conflict-shaped failures are worth retrying: P2034 (transaction write
 * conflict / deadlock), P2002 (unique violation — the number was taken) and
 * Postgres serialization failures surfacing through raw SQL. Business errors
 * (AppError) are NEVER retried: retrying a LOCKED invoice changes nothing.
 */
export function isRetryableIssueError(error: unknown): boolean {
  if (error instanceof AppError) return false;
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  if (code === "P2034" || code === "P2002") return true;
  const message = error instanceof Error ? error.message : "";
  return /could not serialize access|deadlock detected|SQLSTATE\s*40001|write conflict/i.test(
    message,
  );
}

export interface IssueRetryOptions {
  maxRetries?: number;
  /** Injected in tests — production waits with setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  backoffMs?: (attempt: number) => number;
}

/**
 * Runs `run` and retries ONLY conflict-shaped failures, with exponential
 * backoff (25ms → 50ms → 100ms). When the retries are exhausted the caller
 * gets CONFLICT (409) — the issue transaction rolled back, so the invoice is
 * still a draft with no number burned (feature 05 spec step 9).
 */
export async function withIssueRetry<T>(
  run: () => Promise<T>,
  options: IssueRetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? ISSUE_MAX_RETRIES;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const backoffMs = options.backoffMs ?? ((attempt: number) => 25 * 2 ** attempt);

  let retry = 0;
  for (;;) {
    try {
      return await run();
    } catch (error) {
      if (!isRetryableIssueError(error)) throw error;
      if (retry >= maxRetries) {
        logger.error(
          { module: "invoices", action: "issue", retries: retry },
          "issue gagal setelah semua retry konflik — invoice tetap draft",
        );
        throw new AppError("CONFLICT", "Nomor invoice bentrok saat penerbitan. Coba lagi.");
      }
      logger.warn(
        { module: "invoices", action: "issue", retry: retry + 1 },
        "konflik transaksi penerbitan — mencoba lagi",
      );
      await sleep(backoffMs(retry));
      retry += 1;
    }
  }
}

// ─── Row shape ────────────────────────────────────────────────────────────

const issueInclude = {
  profile: true,
  customer: true,
  customerContact: true,
  projectReference: true,
  bankAccount: true,
  signer: true,
  items: { orderBy: { position: "asc" as const } },
};

export interface IssueInvoiceRow {
  invoice: typeof invoices.$inferSelect;
  profile: typeof invoiceProfiles.$inferSelect | null;
  customer: typeof customers.$inferSelect | null;
  customerContact: typeof customerContacts.$inferSelect | null;
  projectReference: typeof projectReferences.$inferSelect | null;
  bankAccount: typeof bankAccounts.$inferSelect | null;
  signer: typeof signers.$inferSelect | null;
  items: Array<typeof invoiceItems.$inferSelect>;
}

async function loadDraftForIssue(
  invoiceId: string,
  ctx: InvoiceServiceContext,
): Promise<IssueInvoiceRow> {
  const invoiceRows = await db
    .select({
      invoice: invoices,
      profile: invoiceProfiles,
      customer: customers,
      customerContact: customerContacts,
      projectReference: projectReferences,
      bankAccount: bankAccounts,
      signer: signers,
    })
    .from(invoices)
    .leftJoin(invoiceProfiles, eq(invoiceProfiles.id, invoices.profileId))
    .leftJoin(customers, eq(customers.id, invoices.customerId))
    .leftJoin(customerContacts, eq(customerContacts.id, invoices.customerContactId))
    .leftJoin(projectReferences, eq(projectReferences.id, invoices.projectReferenceId))
    .leftJoin(bankAccounts, eq(bankAccounts.id, invoices.bankAccountId))
    .leftJoin(signers, eq(signers.id, invoices.signerId))
    .where(eq(invoices.id, invoiceId))
    .limit(1);
  const first = invoiceRows[0];
  if (!first) {
    throw new AppError("NOT_FOUND", "Invoice tidak ditemukan.");
  }
  const items = await db
    .select()
    .from(invoiceItems)
    .where(eq(invoiceItems.invoiceId, invoiceId))
    .orderBy(asc(invoiceItems.position));
  const invoice: IssueInvoiceRow = {
    invoice: first.invoice,
    profile: first.profile,
    customer: first.customer,
    customerContact: first.customerContact,
    projectReference: first.projectReference,
    bankAccount: first.bankAccount,
    signer: first.signer,
    items,
  };
  if (!invoice.invoice || invoice.invoice.organizationId !== ctx.scope.organizationId) {
    // IDOR guard: another org's invoice answers 404, never "exists elsewhere".
    throw new AppError("NOT_FOUND", "Invoice tidak ditemukan.");
  }
  if (invoice.invoice.status !== "DRAFT") {
    throw new AppError("LOCKED", "Invoice yang sudah terbit tidak dapat diterbitkan ulang.");
  }
  return invoice;
}

/**
 * Completeness re-validation (spec step 1). Every failure is a VALIDATION_ERROR
 * with an Indonesian message the user can act on — nothing is issued half-ready.
 */
function assertIssueComplete(invoice: IssueInvoiceRow): void {
  if (!invoice.profile || invoice.profile.organizationId !== invoice.invoice.organizationId) {
    throw new AppError("VALIDATION_ERROR", "Profil invoice tidak valid.");
  }
  if (!invoice.customer || invoice.customer.organizationId !== invoice.invoice.organizationId) {
    throw new AppError("VALIDATION_ERROR", "Customer tidak valid.");
  }
  if (invoice.items.length === 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Invoice minimal memiliki 1 item pekerjaan sebelum diterbitkan.",
    );
  }
}

// ─── Snapshots (frozen document state, invariant 4) ───────────────────────

export interface IssueSnapshots {
  issuer: IssuerSnapshot;
  customer: CustomerSnapshot;
  contact: ContactSnapshot | null;
  bank: BankSnapshot | null;
  signer: SignerSnapshot | null;
  calculation: CalculationSnapshot;
  template: TemplateSnapshot;
}

/**
 * Builds the seven snapshots from the row read for issue. The bank number
 * stays MASKED (it is encrypted at rest — security-standards) and every value
 * is captured once: later edits to profile/customer/bank/signer never reach a
 * document that has been issued.
 */
export function buildSnapshots(
  invoice: IssueInvoiceRow,
  calc: InvoiceCalcResult,
  previouslyBilled: string,
): IssueSnapshots {
  const profile = invoice.profile;
  const customer = invoice.customer;
  if (!profile || !customer) {
    throw new AppError("VALIDATION_ERROR", "Profil atau customer tidak valid.");
  }

  const issuer: IssuerSnapshot = {
    profileId: profile.id,
    name: profile.name,
    legalName: profile.legalName,
    code: profile.code,
    logoPath: profile.logoPath,
    primaryColor: profile.primaryColor,
    address: profile.address,
    phone: profile.phone,
    whatsapp: profile.whatsapp,
    fax: profile.fax,
    email: profile.email,
    website: profile.website,
    taxId: profile.taxId,
    numberPattern: profile.numberPattern,
    templateKey: profile.templateKey,
  };

  const customerSnapshot: CustomerSnapshot = {
    customerId: customer.id,
    companyName: customer.companyName,
    legalName: customer.legalName,
    businessType: customer.businessType,
    taxId: customer.taxId,
    address: customer.address,
    city: customer.city,
    province: customer.province,
    postalCode: customer.postalCode,
    country: customer.country,
    phone: customer.phone,
    whatsapp: customer.whatsapp,
    email: customer.email,
  };

  const contact = invoice.customerContact;
  const contactSnapshot: ContactSnapshot | null = contact
    ? {
        contactId: contact.id,
        name: contact.name,
        title: contact.title,
        division: contact.division,
        email: contact.email,
        phone: contact.phone,
        whatsapp: contact.whatsapp,
      }
    : null;

  const bankSnapshot: BankSnapshot | null = invoice.bankAccount
    ? (() => {
        const view = toBankAccountView(invoice.bankAccount);
        return {
          bankAccountId: view.id,
          bankName: view.bankName,
          bankCode: view.bankCode,
          accountHolder: view.accountHolder,
          branch: view.branch,
          currency: view.currency,
          maskedNumber: view.maskedNumber,
          // Feature 10 policy: the issued document carries the real number
          // ("nomor lengkap hanya di invoice (snapshot)"); nothing else does.
          accountNumber: fullAccountNumber(invoice.bankAccount),
          last4: view.last4,
        };
      })()
    : null;

  const signer = invoice.signer;
  const signerSnapshot: SignerSnapshot | null = signer
    ? {
        signerId: signer.id,
        name: signer.name,
        title: signer.title,
        location: signer.location,
        signaturePath: signer.signatureImagePath,
      }
    : null;

  const calculation: CalculationSnapshot = {
    invoiceType: invoice.invoice.invoiceType,
    billingMode: invoice.invoice.billingMode,
    billingPercent: invoice.invoice.billingPercent?.toString() ?? null,
    billingAmount: invoice.invoice.billingAmount?.toString() ?? null,
    workValue: calc.workValue,
    itemsSubtotal: calc.itemsSubtotal,
    previouslyBilled,
    billingBase: calc.billingBase,
    discountAmount: calc.discountAmount,
    additionalAmount: calc.additionalAmount,
    taxMode: invoice.invoice.taxMode,
    taxPercent: invoice.invoice.taxPercent?.toString() ?? null,
    taxAmount: calc.taxAmount,
    roundingAmount: calc.roundingAmount,
    grandTotal: calc.grandTotal,
    remainingAfter: calc.grandTotal,
    calc,
    items: invoice.items.map((item) => ({
      position: item.position,
      description: item.description,
      details: item.details,
      quantity: item.quantity.toString(),
      unit: item.unit,
      unitPrice: item.unitPrice.toString(),
      discountAmount: item.discountAmount.toString(),
      lineAmount: item.lineAmount.toString(),
    })),
  };

  const template: TemplateSnapshot = {
    templateKey: profile.templateKey,
    primaryColor: profile.primaryColor,
    stampMode: invoice.invoice.stampMode,
    numberPattern: profile.numberPattern,
  };

  return {
    issuer,
    customer: customerSnapshot,
    contact: contactSnapshot,
    bank: bankSnapshot,
    signer: signerSnapshot,
    calculation,
    template,
  };
}

// ─── Issue ────────────────────────────────────────────────────────────────

export interface IssueOutcome {
  invoiceId: string;
  /** Final unique number, e.g. INV/SB/VII/2026/001. */
  number: string;
  issuedAt: string;
}

export async function issueInvoice(
  invoiceId: string,
  ctx: InvoiceServiceContext,
): Promise<IssueOutcome> {
  assertCan("invoice.issue", ctx.scope);
  requireOrgScope(ctx.scope);

  const invoice = await loadDraftForIssue(invoiceId, ctx);
  assertIssueComplete(invoice);

  // Pattern validity is checked BEFORE the transaction so a broken profile
  // pattern never burns a sequence value or half-issues an invoice.
  if (!invoice.profile) {
    throw new AppError("VALIDATION_ERROR", "Profil invoice tidak valid.");
  }
  const pattern = validateNumberPattern(invoice.profile.numberPattern);
  if (!pattern.ok) {
    throw new AppError("VALIDATION_ERROR", `Pola nomor invoice tidak valid: ${pattern.message}`);
  }

  // Server recalculation with the FRESH previouslyBilled (invariant 6 —
  // drafts/cancelled/revised invoices of this project do not count).
  const previouslyBilled = await sumBilledForProject(db, {
    organizationId: ctx.scope.organizationId,
    projectReferenceId: invoice.invoice.projectReferenceId,
    excludeInvoiceId: invoice.invoice.id,
  });
  const calc = calcFromRows(
    { ...invoice.invoice, ...invoice } as unknown as Parameters<typeof calcFromRows>[0],
    previouslyBilled,
  );
  if (new Decimal(calc.billingBase).lte(0)) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Nilai tagihan harus lebih dari 0 sebelum invoice diterbitkan.",
    );
  }
  if (new Decimal(calc.grandTotal).lte(0)) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Total tagihan harus lebih dari 0 sebelum invoice diterbitkan.",
    );
  }

  const snapshots = buildSnapshots(invoice, calc, previouslyBilled);
  const issuedAt = new Date();

  return withIssueRetry(async () =>
    db.transaction(
      async (tx) => {
        // Deterministic serialization: take an EXCLUSIVE lock on the sequence
        // table as the FIRST statement, BEFORE the transaction reads anything.
        // PostgreSQL establishes a SERIALIZABLE snapshot at the first table
        // access — so waiters block here with no snapshot yet, and their
        // snapshot is taken only after the previous issuer has committed.
        // That turns the classic "could not serialize access" (40001) abort
        // cascade into a clean FIFO queue: every issue either commits fully
        // or fails on business grounds (LOCKED), never on timing. The row
        // lock (allocateFinalNumber), the Serializable level and the unique
        // [organizationId, number] constraint below remain the safety net for
        // cross-instance races; the retry budget stays for residual conflicts
        // (P2002/deadlock). Reads (draft previews) take ACCESS SHARE and are
        // not blocked by this lock.
        await tx.execute(sql`LOCK TABLE "invoice_sequence" IN EXCLUSIVE MODE`);

        // Guard inside the transaction: a concurrent second attempt sees a
        // non-DRAFT row and aborts — the invoice can only be issued once
        // (total rollback, nothing half-written).
        const currentRows = await tx
          .select({
            id: invoices.id,
            organizationId: invoices.organizationId,
            status: invoices.status,
          })
          .from(invoices)
          .where(eq(invoices.id, invoiceId))
          .limit(1);
        const current = currentRows[0];
        if (!current || current.organizationId !== ctx.scope.organizationId) {
          throw new AppError("NOT_FOUND", "Invoice tidak ditemukan.");
        }
        if (current.status !== "DRAFT") {
          throw new AppError("LOCKED", "Invoice sudah terbit.");
        }

        // Row-locked allocation (SELECT ... FOR UPDATE on the sequence
        // bucket) — concurrent issues in the same profile/period serialize
        // here and can never share a number.
        const number = await allocateFinalNumber(
          tx,
          invoice.profile ?? { id: "", code: "", numberPattern: "", sequenceResetPolicy: "YEARLY" },
          invoice.invoice.invoiceDate,
        );
        if (!invoice.profile) {
          throw new AppError("VALIDATION_ERROR", "Profil invoice tidak valid.");
        }

        // Only a still-DRAFT row flips to ISSUED: guarded update + affected
        // row count, so a race loses to this transaction, not to the other.
        const issuedRows = await tx
          .update(invoices)
          .set({
            status: "ISSUED",
            number,
            issuedAt,
            issuedById: ctx.scope.userId,
            // Financial columns locked to the recalculated values; the draft
            // can no longer be edited (assertDraftEditable throws LOCKED).
            workValue: calc.workValue,
            itemsSubtotal: calc.itemsSubtotal,
            previouslyBilled: calc.previouslyBilled,
            billingBase: calc.billingBase,
            discountAmount: calc.discountAmount,
            additionalAmount: calc.additionalAmount,
            taxAmount: calc.taxAmount,
            roundingAmount: calc.roundingAmount,
            grandTotal: calc.grandTotal,
            // Spec: at issue the remaining amount IS the grand total
            // (feature 07 decrements it as payments land).
            remainingAfter: calc.grandTotal,
            issuerSnapshot: toJsonInput(snapshots.issuer),
            customerSnapshot: toJsonInput(snapshots.customer),
            // null = "there was genuinely no PIC/bank/signer at issue" — the
            // issued document must not pick up one added later.
            contactSnapshot: snapshots.contact ? toJsonInput(snapshots.contact) : null,
            bankSnapshot: snapshots.bank ? toJsonInput(snapshots.bank) : null,
            signerSnapshot: snapshots.signer ? toJsonInput(snapshots.signer) : null,
            calculationSnapshot: toJsonInput(snapshots.calculation),
            templateSnapshot: toJsonInput(snapshots.template),
          })
          .where(and(eq(invoices.id, invoiceId), eq(invoices.status, "DRAFT")))
          .returning({ id: invoices.id });
        if (issuedRows.length !== 1) {
          throw new AppError("LOCKED", "Invoice sudah terbit.");
        }

        // The draft preview number is obsolete once the final number exists —
        // keep both columns consistent for every later read.
        const numberPreview = await buildNumberPreview(
          invoice.profile,
          invoice.invoice.invoiceDate,
          tx,
        );
        await tx
          .update(invoices)
          .set({ numberPreview })
          .where(eq(invoices.id, invoiceId));

        // Audit + PDF job in the SAME transaction (spec steps 7–8): either
        // everything commits, or nothing does.
        await log(
          {
            actorUserId: ctx.scope.userId,
            organizationId: ctx.scope.organizationId,
            action: "INVOICE_ISSUED",
            entityType: "invoice",
            entityId: invoiceId,
            metadata: {
              number,
              invoiceType: invoice.invoice.invoiceType,
              grandTotal: calc.grandTotal,
              itemCount: invoice.items.length,
            },
            request: ctx.request ?? null,
          },
          tx,
        );
        await enqueuePdfJob(invoiceId, ctx, tx);

        return { invoiceId, number, issuedAt: issuedAt.toISOString() };
    }),
  );
}
