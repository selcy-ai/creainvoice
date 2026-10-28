// src/modules/signers/actions.ts
// Server actions for /signers (feature 10). FormData in — it carries the
// optional signature image as a File — Zod re-validated at the boundary, and
// the service layer authorizes with assertCan (VIEWER 403, foreign id 404).
// The image itself is sniffed from content by the storage pipeline; the
// filename and declared MIME type are never trusted.

"use server";

import { actionRequest, formDataString, toActionError, zodFailure } from "@/lib/action";
import { apiFailure, apiOk, type ActionResult } from "@/lib/api-response";
import { requireSession } from "@/lib/auth";
import { requireWorkspaceScope } from "@/modules/workspace/service";
import { signerSchema } from "@/modules/signers/schema";
import {
  createSigner,
  deleteSigner,
  setDefaultSigner,
  updateSigner,
} from "@/modules/signers/service";

async function serviceContext() {
  const session = await requireSession();
  const scope = await requireWorkspaceScope(session);
  return { scope, request: await actionRequest() };
}

function parseForm(form: FormData) {
  return signerSchema.safeParse({
    name: formDataString(form, "name"),
    title: formDataString(form, "title"),
    location: formDataString(form, "location"),
    isDefault: formDataString(form, "isDefault") === "true",
    isActive: formDataString(form, "isActive") === "true",
  });
}

function signatureFileOf(form: FormData): File | null {
  const file = form.get("signatureFile");
  return file instanceof File && file.size > 0 ? file : null;
}

export async function createSignerAction(
  form: FormData,
): Promise<ActionResult<{ signerId: string }>> {
  try {
    const ctx = await serviceContext();
    const parsed = parseForm(form);
    if (!parsed.success) return zodFailure(parsed.error);

    const signer = await createSigner(parsed.data, ctx, {
      signatureFile: signatureFileOf(form),
    });
    return apiOk({ signerId: signer.id });
  } catch (error) {
    return toActionError("signers.actions", error);
  }
}

export async function updateSignerAction(
  form: FormData,
): Promise<ActionResult<{ signerId: string }>> {
  try {
    const ctx = await serviceContext();
    const signerId = formDataString(form, "signerId");
    if (!signerId) return apiFailure("VALIDATION_ERROR", "Penanda tangan tidak valid.");

    const parsed = parseForm(form);
    if (!parsed.success) return zodFailure(parsed.error);

    const signer = await updateSigner(signerId, parsed.data, ctx, {
      signatureFile: signatureFileOf(form),
    });
    return apiOk({ signerId: signer.id });
  } catch (error) {
    return toActionError("signers.actions", error);
  }
}

export async function deleteSignerAction(form: FormData): Promise<ActionResult> {
  try {
    const ctx = await serviceContext();
    const signerId = formDataString(form, "signerId");
    if (!signerId) return apiFailure("VALIDATION_ERROR", "Penanda tangan tidak valid.");

    await deleteSigner(signerId, ctx);
    return apiOk({});
  } catch (error) {
    return toActionError("signers.actions", error);
  }
}

export async function setDefaultSignerAction(
  form: FormData,
): Promise<ActionResult<{ signerId: string }>> {
  try {
    const ctx = await serviceContext();
    const signerId = formDataString(form, "signerId");
    if (!signerId) return apiFailure("VALIDATION_ERROR", "Penanda tangan tidak valid.");

    const signer = await setDefaultSigner(signerId, ctx);
    return apiOk({ signerId: signer.id });
  } catch (error) {
    return toActionError("signers.actions", error);
  }
}
