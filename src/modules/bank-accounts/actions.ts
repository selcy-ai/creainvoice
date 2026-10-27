// src/modules/bank-accounts/actions.ts
// Server actions for /bank-accounts (feature 10). FormData in (the form shape
// step 06 established for bank fields), Zod re-validated at the boundary, and
// the service layer authorizes with assertCan — a crafted request from a
// VIEWER answers 403, a foreign id answers 404 (IDOR guard), and the plaintext
// number never appears in an audit row or an error message.

"use server";

import { actionRequest, formDataString, toActionError, zodFailure } from "@/lib/action";
import { apiFailure, apiOk, type ActionResult } from "@/lib/api-response";
import { requireSession } from "@/lib/clerk";
import { requireWorkspaceScope } from "@/modules/workspace/service";
import { bankAccountSchema } from "@/modules/bank-accounts/schema";
import {
  createBankAccount,
  deleteBankAccount,
  setDefaultBankAccount,
  updateBankAccount,
} from "@/modules/bank-accounts/service";

async function serviceContext() {
  const session = await requireSession();
  const scope = await requireWorkspaceScope(session);
  return { scope, request: await actionRequest() };
}

function parseForm(form: FormData) {
  return bankAccountSchema.safeParse({
    bankName: formDataString(form, "bankName"),
    bankCode: formDataString(form, "bankCode"),
    accountNumber: formDataString(form, "accountNumber"),
    accountHolder: formDataString(form, "accountHolder"),
    branch: formDataString(form, "branch"),
    isDefault: formDataString(form, "isDefault") === "true",
    isActive: formDataString(form, "isActive") === "true",
  });
}

export async function createBankAccountAction(
  form: FormData,
): Promise<ActionResult<{ bankAccountId: string }>> {
  try {
    const ctx = await serviceContext();
    const parsed = parseForm(form);
    if (!parsed.success) return zodFailure(parsed.error);

    const account = await createBankAccount(parsed.data, ctx);
    return apiOk({ bankAccountId: account.id });
  } catch (error) {
    return toActionError("bank-accounts.actions", error);
  }
}

export async function updateBankAccountAction(
  form: FormData,
): Promise<ActionResult<{ bankAccountId: string }>> {
  try {
    const ctx = await serviceContext();
    const bankAccountId = formDataString(form, "bankAccountId");
    if (!bankAccountId) return apiFailure("VALIDATION_ERROR", "Rekening bank tidak valid.");

    const parsed = parseForm(form);
    if (!parsed.success) return zodFailure(parsed.error);

    const account = await updateBankAccount(bankAccountId, parsed.data, ctx);
    return apiOk({ bankAccountId: account.id });
  } catch (error) {
    return toActionError("bank-accounts.actions", error);
  }
}

export async function deleteBankAccountAction(
  form: FormData,
): Promise<ActionResult> {
  try {
    const ctx = await serviceContext();
    const bankAccountId = formDataString(form, "bankAccountId");
    if (!bankAccountId) return apiFailure("VALIDATION_ERROR", "Rekening bank tidak valid.");

    await deleteBankAccount(bankAccountId, ctx);
    return apiOk({});
  } catch (error) {
    return toActionError("bank-accounts.actions", error);
  }
}

export async function setDefaultBankAccountAction(
  form: FormData,
): Promise<ActionResult<{ bankAccountId: string }>> {
  try {
    const ctx = await serviceContext();
    const bankAccountId = formDataString(form, "bankAccountId");
    if (!bankAccountId) return apiFailure("VALIDATION_ERROR", "Rekening bank tidak valid.");

    const account = await setDefaultBankAccount(bankAccountId, ctx);
    return apiOk({ bankAccountId: account.id });
  } catch (error) {
    return toActionError("bank-accounts.actions", error);
  }
}
