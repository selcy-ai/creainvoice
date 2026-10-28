// src/modules/profiles/actions.ts
// Server actions for /profiles and /profiles/[id]: full profile edit, logo
// upload/remove, and default-profile creation. Each authorizes in the service
// layer (assertCan org.settings.update) and answers ActionResult.

"use server";

import { actionRequest, formDataString, toActionError, zodFailure } from "@/lib/action";
import { apiFailure, apiOk, type ActionResult } from "@/lib/api-response";
import { requireSession } from "@/lib/auth";
import { requireWorkspaceScope } from "@/modules/workspace/service";
import {
  ensureProfile,
  getProfileForScope,
  profileUpdateSchema,
  removeLogo,
  replaceLogo,
  toProfileView,
  updateProfile,
  type ProfileView,
} from "@/modules/profiles/service";
import { z } from "zod";

const profileIdSchema = z.string().min(1, "Profil invoice tidak valid.");

/** Edit page: full-field update (identity, contact, appearance, tax, stamp). */
export async function updateProfileAction(
  form: FormData,
): Promise<ActionResult<{ profile: ProfileView }>> {
  try {
    const session = await requireSession();
    const scope = await requireWorkspaceScope(session);
    const ctx = { scope, request: await actionRequest() };

    const profileId = profileIdSchema.safeParse(formDataString(form, "profileId"));
    if (!profileId.success) return zodFailure(profileId.error);

    const parsed = profileUpdateSchema.safeParse({
      name: formDataString(form, "name"),
      code: formDataString(form, "code"),
      legalName: formDataString(form, "legalName"),
      address: formDataString(form, "address"),
      taxId: formDataString(form, "taxId"),
      phone: formDataString(form, "phone"),
      whatsapp: formDataString(form, "whatsapp"),
      fax: formDataString(form, "fax"),
      email: formDataString(form, "email"),
      website: formDataString(form, "website"),
      primaryColor: formDataString(form, "primaryColor"),
      numberPattern: formDataString(form, "numberPattern"),
      sequenceResetPolicy: formDataString(form, "sequenceResetPolicy"),
      defaultTaxMode: formDataString(form, "defaultTaxMode"),
      defaultTaxPercent: formDataString(form, "defaultTaxPercent"),
      defaultStampMode: formDataString(form, "defaultStampMode"),
      defaultNotes: formDataString(form, "defaultNotes"),
    });
    if (!parsed.success) return zodFailure(parsed.error);

    const updated = await updateProfile(profileId.data, parsed.data, ctx);
    return apiOk({ profile: toProfileView(updated) });
  } catch (error) {
    return toActionError("profiles.actions", error);
  }
}

/** Logo upload: size/MIME decided server-side (magic bytes), random filename. */
export async function uploadLogoAction(
  form: FormData,
): Promise<ActionResult<{ profile: ProfileView }>> {
  try {
    const session = await requireSession();
    const scope = await requireWorkspaceScope(session);
    const ctx = { scope, request: await actionRequest() };

    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return apiFailure("VALIDATION_ERROR", "File logo wajib dipilih.");
    }

    const profileId = formDataString(form, "profileId");
    const profile = profileId
      ? await getProfileForScope(profileId, ctx)
      : await ensureProfile(ctx);

    const updated = await replaceLogo(profile.id, file, ctx);
    return apiOk({ profile: toProfileView(updated) });
  } catch (error) {
    return toActionError("profiles.actions", error);
  }
}

export async function removeLogoAction(
  form: FormData,
): Promise<ActionResult<{ profile: ProfileView }>> {
  try {
    const session = await requireSession();
    const scope = await requireWorkspaceScope(session);
    const ctx = { scope, request: await actionRequest() };

    const profileId = profileIdSchema.safeParse(formDataString(form, "profileId"));
    if (!profileId.success) return zodFailure(profileId.error);

    const updated = await removeLogo(profileId.data, ctx);
    return apiOk({ profile: toProfileView(updated) });
  } catch (error) {
    return toActionError("profiles.actions", error);
  }
}

/** /profiles list entry when the org has no profile yet (real create). */
export async function createDefaultProfileAction(): Promise<ActionResult<{ profileId: string }>> {
  try {
    const session = await requireSession();
    const scope = await requireWorkspaceScope(session);
    const profile = await ensureProfile({ scope, request: await actionRequest() });
    return apiOk({ profileId: profile.id });
  } catch (error) {
    return toActionError("profiles.actions", error);
  }
}
