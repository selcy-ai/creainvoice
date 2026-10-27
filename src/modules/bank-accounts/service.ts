// src/modules/bank-accounts/service.ts
// Bank account domain. Feature 02 built the onboarding default account;
// feature 10 completes multi-account CRUD (create/update/delete/set-default,
// paginated list, authorized reveal of the full number).
//
// Account numbers are encrypted at rest (AES-256-GCM, crypto.ts) and only ever
// leave this module MASKED — with exactly two exceptions, both named by spec 10:
//   • `getBankAccountDetail` reveals the plaintext when the caller holds
//     bankAccount.update ("halaman berizin — detail bank dengan permission";
//     VIEWER gets null),
//   • `fullAccountNumber` feeds the issue-time snapshot ("nomor lengkap hanya
//     di invoice (snapshot)") — never a client payload.

import { log } from "@/modules/audit/service";
import { AppError } from "@/lib/errors";
import type { WorkspaceScope } from "@/modules/workspace/service";
import { assertCan, can } from "@/modules/workspace/permissions";
import {
  accountNumberLast4,
  decryptAccountNumber,
  encryptAccountNumber,
  maskAccountNumber,
  normalizeAccountNumber,
} from "@/modules/bank-accounts/crypto";
import { BANK_ACCOUNTS_PAGE_SIZE, type BankAccountInput } from "@/modules/bank-accounts/schema";
import { db, type Database } from "@/server/db";
import { bankAccounts, invoiceProfiles } from "@/db/schema";
import { and, asc, count, desc, eq, isNotNull, ne } from "drizzle-orm";

type BankAccount = typeof bankAccounts.$inferSelect;

export { maskAccountNumber, normalizeAccountNumber } from "@/modules/bank-accounts/crypto";
// The schema lives in the client-safe module (feature 07 rule); re-exported
// here so the onboarding action's feature-02 import path keeps working.
export { bankAccountSchema, type BankAccountFormValues, type BankAccountInput } from "@/modules/bank-accounts/schema";

export interface BankAccountServiceContext {
  scope: WorkspaceScope;
  request?: Request | null;
}

export interface BankAccountView {
  id: string;
  bankName: string;
  bankCode: string | null;
  accountHolder: string;
  branch: string | null;
  /** e.g. "**** **** 3449" — decrypted server-side, masked before leaving. */
  maskedNumber: string;
  last4: string;
  currency: string;
  isDefault: boolean;
  isActive: boolean;
  /** ISO timestamp — management list column. */
  createdAt: string;
}

export function toBankAccountView(account: BankAccount): BankAccountView {
  return {
    id: account.id,
    bankName: account.bankName,
    bankCode: account.bankCode,
    accountHolder: account.accountHolder,
    branch: account.branch,
    maskedNumber: maskAccountNumber(
      decryptAccountNumber(account.accountNumberEncrypted),
    ),
    last4: account.accountNumberLast4,
    currency: account.currency,
    isDefault: account.isDefault,
    isActive: account.isActive,
    createdAt: account.createdAt.toISOString(),
  };
}

/**
 * Full plaintext number — ISSUE-TIME SNAPSHOT ONLY (spec 10: the invoice
 * document is the one place the real number appears besides an authorized
 * detail page). Never put this in a list payload, log, or audit metadata.
 */
export function fullAccountNumber(account: BankAccount): string {
  return decryptAccountNumber(account.accountNumberEncrypted);
}

/** The organization's default account (onboarding scope). */
export async function getDefaultBankAccount(
  organizationId: string,
): Promise<BankAccount | null> {
  const rows = await db
    .select()
    .from(bankAccounts)
    .where(
      and(
        eq(bankAccounts.organizationId, organizationId),
        eq(bankAccounts.isDefault, true),
        eq(bankAccounts.isActive, true),
      ),
    )
    .orderBy(asc(bankAccounts.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/** Active accounts only — the invoice editor's dropdown (masked view). */
export async function listBankAccounts(organizationId: string): Promise<BankAccountView[]> {
  const rows = await db
    .select()
    .from(bankAccounts)
    .where(and(eq(bankAccounts.organizationId, organizationId), eq(bankAccounts.isActive, true)))
    .orderBy(asc(bankAccounts.createdAt));
  return rows.map(toBankAccountView);
}

/** Management list: paginated, every row (inactive included, badge honest). */
export async function listBankAccountsPage(
  ctx: BankAccountServiceContext,
  options: { page?: number } = {},
): Promise<{
  rows: BankAccountView[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}> {
  assertCan("bankAccount.view", ctx.scope);
  const pageSize = BANK_ACCOUNTS_PAGE_SIZE;
  const where = eq(bankAccounts.organizationId, ctx.scope.organizationId);
  const totalRows = await db.select({ value: count() }).from(bankAccounts).where(where);
  const total = Number(totalRows[0]?.value ?? 0);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, options.page ?? 1), pageCount);
  const rows = await db
    .select()
    .from(bankAccounts)
    .where(where)
    .orderBy(desc(bankAccounts.isDefault), asc(bankAccounts.createdAt), asc(bankAccounts.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return { rows: rows.map(toBankAccountView), total, page, pageSize, pageCount };
}

export interface BankAccountDetail extends BankAccountView {
  /** Plaintext number when the caller may manage (STAFF+); null for VIEWER. */
  accountNumber: string | null;
}

/** Detail for the edit/read page — org-scoped (IDOR → NOT_FOUND). */
export async function getBankAccountDetail(
  id: string,
  ctx: BankAccountServiceContext,
): Promise<BankAccountDetail> {
  assertCan("bankAccount.view", ctx.scope);
  const rows = await db
    .select()
    .from(bankAccounts)
    .where(
      and(eq(bankAccounts.id, id), eq(bankAccounts.organizationId, ctx.scope.organizationId)),
    )
    .limit(1);
  const row = rows[0];
  if (!row) throw new AppError("NOT_FOUND", "Rekening bank tidak ditemukan.");
  const mayReveal = can("bankAccount.update", ctx.scope);
  return {
    ...toBankAccountView(row),
    accountNumber: mayReveal ? decryptAccountNumber(row.accountNumberEncrypted) : null,
  };
}

const ACCOUNT_NUMBER_FORMAT = "Nomor rekening harus 6–34 digit angka.";

function digitsOf(accountNumber: string | undefined): string {
  return accountNumber ? normalizeAccountNumber(accountNumber) : "";
}

function assertDigits(digits: string): void {
  if (digits && !/^\d{6,34}$/.test(digits)) {
    throw new AppError("VALIDATION_ERROR", ACCOUNT_NUMBER_FORMAT);
  }
}

/** Profile defaults follow the org default (feature 02 pattern: the editor
 * prefills from `InvoiceProfile.defaultBankAccountId`, and with one profile per
 * organisation — recorded feature-08 decision — the two must not drift). */
async function pointProfilesAtBank(
  client: Pick<Database, "update">,
  organizationId: string,
  bankAccountId: string | null,
  onlyProfilesPointingAt?: string,
): Promise<void> {
  await client
    .update(invoiceProfiles)
    .set({ defaultBankAccountId: bankAccountId })
    .where(
      and(
        eq(invoiceProfiles.organizationId, organizationId),
        onlyProfilesPointingAt
          ? eq(invoiceProfiles.defaultBankAccountId, onlyProfilesPointingAt)
          : isNotNull(invoiceProfiles.id),
      ),
    );
}

/** Becoming the default clears the flag on every other account of the org. */
async function clearOtherDefaults(
  client: Pick<Database, "update">,
  organizationId: string,
  keepId: string,
): Promise<void> {
  await client
    .update(bankAccounts)
    .set({ isDefault: false })
    .where(
      and(
        eq(bankAccounts.organizationId, organizationId),
        eq(bankAccounts.isDefault, true),
        ne(bankAccounts.id, keepId),
      ),
    );
}

export async function createBankAccount(
  input: BankAccountInput,
  ctx: BankAccountServiceContext,
): Promise<BankAccount> {
  assertCan("bankAccount.create", ctx.scope);
  const digits = digitsOf(input.accountNumber);
  assertDigits(digits);
  if (!digits) {
    throw new AppError("VALIDATION_ERROR", "Nomor rekening wajib diisi.");
  }

  const organizationId = ctx.scope.organizationId;
  const defaultRows = await db
    .select({ id: bankAccounts.id })
    .from(bankAccounts)
    .where(
      and(eq(bankAccounts.organizationId, organizationId), eq(bankAccounts.isDefault, true)),
    )
    .limit(1);
  // First account is always the default; afterwards the checkbox decides.
  const makeDefault = input.isDefault === true || defaultRows.length === 0;

  let account: BankAccount | undefined;
  await db.transaction(async (tx) => {
    // Row does not exist yet, so clearing "the default" clears every row.
    if (makeDefault) {
      await tx
        .update(bankAccounts)
        .set({ isDefault: false })
        .where(
          and(eq(bankAccounts.organizationId, organizationId), eq(bankAccounts.isDefault, true)),
        );
    }
    const created = await tx
      .insert(bankAccounts)
      .values({
        organizationId,
        bankName: input.bankName,
        bankCode: input.bankCode ?? null,
        accountNumberEncrypted: encryptAccountNumber(digits),
        accountNumberLast4: accountNumberLast4(digits),
        accountHolder: input.accountHolder,
        branch: input.branch ?? null,
        currency: "IDR",
        isDefault: makeDefault,
        isActive: input.isActive ?? true,
      })
      .returning();
    account = created[0];
    if (account && makeDefault) await pointProfilesAtBank(tx, organizationId, account.id);
  });
  if (!account) throw new AppError("INTERNAL_ERROR", "Rekening gagal dibuat.");
  const created = account;

  // Audit metadata never carries the number — only non-sensitive identifiers.
  await log({
    actorUserId: ctx.scope.userId,
    organizationId,
    action: "PROFILE_CHANGED",
    entityType: "bankAccount",
    entityId: created.id,
    metadata: { change: "created", bankName: created.bankName, isDefault: makeDefault },
    request: ctx.request ?? null,
  });
  return account;
}

export async function updateBankAccount(
  id: string,
  input: BankAccountInput,
  ctx: BankAccountServiceContext,
): Promise<BankAccount> {
  assertCan("bankAccount.update", ctx.scope);
  const organizationId = ctx.scope.organizationId;
  const existingRows = await db
    .select()
    .from(bankAccounts)
    .where(and(eq(bankAccounts.id, id), eq(bankAccounts.organizationId, organizationId)))
    .limit(1);
  const existing = existingRows[0];
  if (!existing) throw new AppError("NOT_FOUND", "Rekening bank tidak ditemukan.");

  const digits = digitsOf(input.accountNumber);
  assertDigits(digits);

  // Absent flag = leave the current default state untouched (the form always
  // sends an explicit value; a bare service call must not silently un-default).
  const wantDefault = input.isDefault ?? existing.isDefault;
  const becameDefault = wantDefault && !existing.isDefault;
  const unsetDefault = !wantDefault && existing.isDefault;

  let account: BankAccount | undefined;
  await db.transaction(async (tx) => {
    if (becameDefault) await clearOtherDefaults(tx, organizationId, id);
    const updated = await tx
      .update(bankAccounts)
      .set({
        bankName: input.bankName,
        bankCode: input.bankCode ?? null,
        // Empty number on edit keeps the stored ciphertext: the plaintext is
        // never round-tripped through the client for this path.
        ...(digits
          ? {
              accountNumberEncrypted: encryptAccountNumber(digits),
              accountNumberLast4: accountNumberLast4(digits),
            }
          : {}),
        accountHolder: input.accountHolder,
        branch: input.branch ?? null,
        isActive: input.isActive ?? existing.isActive,
        isDefault: wantDefault,
      })
      .where(eq(bankAccounts.id, existing.id))
      .returning();
    account = updated[0];
    if (account && becameDefault) await pointProfilesAtBank(tx, organizationId, id);
    if (account && unsetDefault) {
      await pointProfilesAtBank(tx, organizationId, null, id);
    }
  });
  if (!account) throw new AppError("INTERNAL_ERROR", "Rekening gagal diperbarui.");
  const updatedRow = account;

  await log({
    actorUserId: ctx.scope.userId,
    organizationId,
    action: "PROFILE_CHANGED",
    entityType: "bankAccount",
    entityId: updatedRow.id,
    metadata: {
      change: becameDefault || unsetDefault ? "defaultChanged" : "updated",
      bankName: updatedRow.bankName,
      isDefault: updatedRow.isDefault,
    },
    request: ctx.request ?? null,
  });
  return account;
}

/** "Jadikan rekening utama" — idempotent; also what the edit checkbox does. */
export async function setDefaultBankAccount(
  id: string,
  ctx: BankAccountServiceContext,
): Promise<BankAccount> {
  assertCan("bankAccount.update", ctx.scope);
  const organizationId = ctx.scope.organizationId;
  const existingRows = await db
    .select()
    .from(bankAccounts)
    .where(and(eq(bankAccounts.id, id), eq(bankAccounts.organizationId, organizationId)))
    .limit(1);
  const existing = existingRows[0];
  if (!existing) throw new AppError("NOT_FOUND", "Rekening bank tidak ditemukan.");
  if (existing.isDefault) return existing;

  let account: BankAccount | undefined;
  await db.transaction(async (tx) => {
    await clearOtherDefaults(tx, organizationId, id);
    const updated = await tx
      .update(bankAccounts)
      .set({ isDefault: true })
      .where(eq(bankAccounts.id, existing.id))
      .returning();
    account = updated[0];
    if (account) await pointProfilesAtBank(tx, organizationId, account.id);
  });
  if (!account) throw new AppError("INTERNAL_ERROR", "Rekening gagal diubah.");
  const setDefault = account;

  await log({
    actorUserId: ctx.scope.userId,
    organizationId,
    action: "PROFILE_CHANGED",
    entityType: "bankAccount",
    entityId: setDefault.id,
    metadata: { change: "defaultChanged", bankName: setDefault.bankName, isDefault: true },
    request: ctx.request ?? null,
  });
  return account;
}

/**
 * Hard delete (data-model: soft delete exists only for Customer). The schema's
 * FKs are SetNull on Invoice.bankAccountId and InvoiceProfile.defaultBankAccountId,
 * so issued documents keep their frozen snapshot and the profile default simply
 * clears; if the org default was removed, the next create auto-claims it.
 */
export async function deleteBankAccount(
  id: string,
  ctx: BankAccountServiceContext,
): Promise<void> {
  assertCan("bankAccount.delete", ctx.scope);
  const organizationId = ctx.scope.organizationId;
  const existingRows = await db
    .select()
    .from(bankAccounts)
    .where(and(eq(bankAccounts.id, id), eq(bankAccounts.organizationId, organizationId)))
    .limit(1);
  const existing = existingRows[0];
  if (!existing) throw new AppError("NOT_FOUND", "Rekening bank tidak ditemukan.");

  await db.delete(bankAccounts).where(eq(bankAccounts.id, existing.id));

  await log({
    actorUserId: ctx.scope.userId,
    organizationId,
    action: "PROFILE_CHANGED",
    entityType: "bankAccount",
    entityId: existing.id,
    metadata: { change: "deleted", bankName: existing.bankName, wasDefault: existing.isDefault },
    request: ctx.request ?? null,
  });
}

/**
 * Creates the default account, or replaces the existing default's fields
 * (onboarding step 6 — feature 02 path, kept behaviorally intact). The
 * plaintext number never leaves this module: only ciphertext is stored,
 * only the last4 is kept in the clear for masking.
 */
export async function saveBankAccount(
  input: BankAccountInput,
  ctx: BankAccountServiceContext,
): Promise<BankAccount> {
  assertCan("org.settings.update", ctx.scope);

  const existing = await getDefaultBankAccount(ctx.scope.organizationId);

  const digits = digitsOf(input.accountNumber);
  assertDigits(digits);

  let encrypted: string;
  let last4: string;
  if (digits) {
    encrypted = encryptAccountNumber(digits);
    last4 = accountNumberLast4(digits);
  } else if (existing) {
    encrypted = existing.accountNumberEncrypted;
    last4 = existing.accountNumberLast4;
  } else {
    throw new AppError("VALIDATION_ERROR", "Nomor rekening wajib diisi.");
  }

  let account: BankAccount | undefined;
  if (existing) {
    const updated = await db
      .update(bankAccounts)
      .set({
        bankName: input.bankName,
        bankCode: input.bankCode ?? null,
        accountNumberEncrypted: encrypted,
        accountNumberLast4: last4,
        accountHolder: input.accountHolder,
        branch: input.branch ?? null,
      })
      .where(eq(bankAccounts.id, existing.id))
      .returning();
    account = updated[0];
  } else {
    const created = await db
      .insert(bankAccounts)
      .values({
        organizationId: ctx.scope.organizationId,
        bankName: input.bankName,
        bankCode: input.bankCode ?? null,
        accountNumberEncrypted: encrypted,
        accountNumberLast4: last4,
        accountHolder: input.accountHolder,
        branch: input.branch ?? null,
        currency: "IDR",
        isDefault: true,
        isActive: true,
      })
      .returning();
    account = created[0];
  }
  if (!account) throw new AppError("INTERNAL_ERROR", "Rekening gagal disimpan.");
  const saved = account;

  // Link as the profile's default payment account when a profile exists yet
  // (onboarding step 6 runs after step 2, so this normally holds).
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
      .set({ defaultBankAccountId: saved.id })
      .where(eq(invoiceProfiles.id, profileRows[0].id));
  }

  await log({
    actorUserId: ctx.scope.userId,
    organizationId: ctx.scope.organizationId,
    action: "PROFILE_CHANGED",
    entityType: "bankAccount",
    entityId: saved.id,
    metadata: {
      change: existing ? "updated" : "created",
      bankName: saved.bankName,
      isDefault: true,
    },
    request: ctx.request ?? null,
  });
  return account;
}
