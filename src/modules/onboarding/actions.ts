// src/modules/onboarding/actions.ts
// Server actions for the 12-step onboarding wizard. Every action: requires an
// in-progress onboarding session, resolves the active workspace scope when it
// writes profile data, calls the domain service, then persists the furthest
// step reached (resume point). Nothing here trusts a client-computed total.
//
// Change 14: organizations are local rows again — step 1 INSERTs into
// `organizations` + `memberships` (role admin — flat workspace, no role
// tiers) inside a transaction, then stores the new organization on the
// better-auth session row so the wizard — and the shell — see it as the
// active workspace immediately. No third-party instance involved, so the
// "organisasi tidak aktif" failure cannot happen anymore.

"use server";

import { actionRequest, formDataString, toActionError, zodFailure } from "@/lib/action";
import { apiFailure, apiOk, type ActionResult } from "@/lib/api-response";
import { AppError } from "@/lib/errors";
import { getSessionToken, requireSession, type AuthSession } from "@/lib/auth";
import { db } from "@/server/db";
import { memberships, organizations } from "@/db/schema";
import { createId } from "@/db/id";
import { logAudit } from "@/modules/audit/service";
import {
  requireWorkspaceScope,
  resolveWorkspaceScope,
} from "@/modules/workspace/service";
import {
  advanceOnboardingStep,
  clampStep,
  completeOnboarding,
  getOnboardingState,
} from "@/modules/onboarding/service";
import {
  companyProfileSchema,
  contactProfileSchema,
  createProfile,
  ensureProfile,
  getProfileByOrg,
  numberingSchema,
  primaryColorSchema,
  profileIdentitySchema,
  stampModeSchema,
  toProfileView,
  updateProfile,
  type ProfileView,
} from "@/modules/profiles/service";
import {
  bankAccountSchema,
  saveBankAccount,
  toBankAccountView,
  type BankAccountView,
} from "@/modules/bank-accounts/service";
import { saveSigner, signerSchema, toSignerView, type SignerView } from "@/modules/signers/service";
import { z } from "zod";

// ─── Guards ───────────────────────────────────────────────────────────────

async function requireOnboardingSession(): Promise<AuthSession> {
  const session = await requireSession();
  const state = await getOnboardingState(session.userId ?? "");
  if (state.complete) {
    throw new AppError("CONFLICT", "Onboarding sudah selesai.");
  }
  return session;
}

async function requireScope(session: AuthSession) {
  const scope = await resolveWorkspaceScope(session);
  if (!scope) {
    throw new AppError(
      "FORBIDDEN",
      "Tidak ada organisasi aktif. Selesaikan langkah 1 terlebih dahulu.",
    );
  }
  return scope;
}

function stepFromForm(form: FormData): number {
  const raw = Number(formDataString(form, "step"));
  return clampStep(Number.isFinite(raw) ? raw : 1);
}

type WizardOk<T> = ActionResult<T>;

// ─── Step 1 — organization (created locally, Change 14) ────────────────────

const workspaceChoiceSchema = z.object({
  mode: z.enum(["create", "select"]),
  organizationId: z.string().optional(),
  name: z
    .string()
    .trim()
    .min(2, "Nama organisasi minimal 2 karakter.")
    .max(80, "Nama organisasi maksimal 80 karakter.")
    .optional(),
});

/**
 * Creates the organization + an ACTIVE admin membership locally, in one
 * transaction. Replaces the Clerk organization API (Change 14): no external
 * instance can refuse this row anymore. Also stores the new organization on
 * the session row so it is the active workspace from the very first read.
 *
 * The audit trail the Clerk webhook used to write (ORGANIZATION_CREATED +
 * MEMBERSHIP_CHANGED) is emitted here — the emit point now lives where the
 * rows are actually created (feature 01 audit invariant, kept alive).
 */
async function createOrganizationForMember(
  userId: string,
  name: string,
): Promise<{ organizationId: string }> {
  const organizationId = createId();
  const membershipId = createId();
  const slug = `org-${createId().toLowerCase()}`;

  await db.transaction(async (tx) => {
    await tx.insert(organizations).values({
      id: organizationId,
      name,
      slug,
      status: "ACTIVE",
    });
    await tx.insert(memberships).values({
      id: membershipId,
      userId,
      organizationId,
      status: "ACTIVE",
    });
  });

  // Audit rows are written outside the create transaction and are
  // best-effort (logAudit swallows its own failure): the workspace creation
  // must not roll back because the trail could not be recorded.
  await logAudit({
    action: "ORGANIZATION_CREATED",
    organizationId,
    actorUserId: userId,
    entityType: "organization",
    entityId: organizationId,
    metadata: { name, slug },
    request: null,
  }).catch(() => {
    // logAudit already logged the failure; never surface it to the wizard.
  });
  await logAudit({
    action: "MEMBERSHIP_CHANGED",
    organizationId,
    actorUserId: userId,
    entityType: "membership",
    entityId: membershipId,
    metadata: { change: "created", role: "admin" },
    request: null,
  }).catch(() => {
    // best-effort
  });

  return { organizationId };
}

/** Stores the active organization on the better-auth session row. */
async function activateWorkspaceOnSession(
  session: AuthSession,
  organizationId: string,
): Promise<void> {
  const token = await getSessionToken();
  if (!token) return; // the wizard still works; the next login picks it up
  try {
    const { setActiveOrganization } = await import("@/lib/auth");
    await setActiveOrganization(session.userId ?? "", token, organizationId);
  } catch {
    // The membership row was just written; a failed session write must not
    // block the wizard (resolveActiveOrgId falls back to the first org).
  }
}

export async function chooseWorkspaceAction(form: FormData): Promise<
  WizardOk<{ organizationId: string }>
> {
  try {
    const session = await requireOnboardingSession();
    const parsed = workspaceChoiceSchema.safeParse({
      mode: formDataString(form, "mode") || "create",
      organizationId: formDataString(form, "organizationId"),
      name: formDataString(form, "name"),
    });
    if (!parsed.success) return zodFailure(parsed.error);

    let organizationId: string;

    if (parsed.data.mode === "select") {
      if (!parsed.data.organizationId) {
        return apiFailure("VALIDATION_ERROR", "Pilih salah satu organisasi.", {
          organizationId: "Pilih salah satu organisasi.",
        });
      }
      // The membership (created at registration or by an admin) is verified
      // by resolveWorkspaceScope on the next read — here we only record the
      // choice on the session.
      organizationId = parsed.data.organizationId;
    } else {
      if (!parsed.data.name) {
        return apiFailure("VALIDATION_ERROR", "Nama organisasi wajib diisi.", {
          name: "Nama organisasi wajib diisi.",
        });
      }
      // Local INSERT: the app is the only source of truth (Change 14).
      const created = await createOrganizationForMember(session.userId ?? "", parsed.data.name);
      organizationId = created.organizationId;
    }

    await activateWorkspaceOnSession(session, organizationId);
    await advanceOnboardingStep(session.userId ?? "", 2);
    return apiOk({ organizationId });
  } catch (error) {
    return toActionError("onboarding.actions", error);
  }
}

// ─── Step 2 — company profile ─────────────────────────────────────────────

export async function saveCompanyProfileAction(form: FormData): Promise<
  WizardOk<{ profile: ProfileView }>
> {
  try {
    const session = await requireOnboardingSession();
    const scope = await requireScope(session);
    const ctx = { scope, request: await actionRequest() };
    const parsed = companyProfileSchema.safeParse({
      legalName: formDataString(form, "legalName"),
      address: formDataString(form, "address"),
      taxId: formDataString(form, "taxId"),
    });
    if (!parsed.success) return zodFailure(parsed.error);

    const existing = await getProfileByOrg(scope.organizationId);
    const profile = existing
      ? await updateProfile(existing.id, parsed.data, ctx)
      : await createProfile(ctx, parsed.data);
    await advanceOnboardingStep(session.userId ?? "", stepFromForm(form) + 1);
    return apiOk({ profile: toProfileView(profile) });
  } catch (error) {
    return toActionError("onboarding.actions", error);
  }
}

// ─── Step 5 — contact details ─────────────────────────────────────────────

export async function saveContactInfoAction(form: FormData): Promise<
  WizardOk<{ profile: ProfileView }>
> {
  try {
    const session = await requireOnboardingSession();
    const scope = await requireScope(session);
    const ctx = { scope, request: await actionRequest() };
    const parsed = contactProfileSchema.safeParse({
      phone: formDataString(form, "phone"),
      whatsapp: formDataString(form, "whatsapp"),
      fax: formDataString(form, "fax"),
      email: formDataString(form, "email"),
      website: formDataString(form, "website"),
    });
    if (!parsed.success) return zodFailure(parsed.error);

    const profile = await ensureProfile(ctx);
    const updated = await updateProfile(profile.id, parsed.data, ctx);
    await advanceOnboardingStep(session.userId ?? "", stepFromForm(form) + 1);
    return apiOk({ profile: toProfileView(updated) });
  } catch (error) {
    return toActionError("onboarding.actions", error);
  }
}

// ─── Step 4 — accent color ────────────────────────────────────────────────

const colorSchema = z.object({ primaryColor: primaryColorSchema });

export async function setPrimaryColorAction(form: FormData): Promise<
  WizardOk<{ profile: ProfileView }>
> {
  try {
    const session = await requireOnboardingSession();
    const scope = await requireScope(session);
    const ctx = { scope, request: await actionRequest() };
    const parsed = colorSchema.safeParse({
      primaryColor: formDataString(form, "primaryColor"),
    });
    if (!parsed.success) return zodFailure(parsed.error);

    const profile = await ensureProfile(ctx);
    const updated = await updateProfile(profile.id, parsed.data, ctx);
    await advanceOnboardingStep(session.userId ?? "", stepFromForm(form) + 1);
    return apiOk({ profile: toProfileView(updated) });
  } catch (error) {
    return toActionError("onboarding.actions", error);
  }
}

// ─── Step 6 — bank account ────────────────────────────────────────────────

export async function saveBankAccountAction(form: FormData): Promise<
  WizardOk<{ bank: BankAccountView }>
> {
  try {
    const session = await requireOnboardingSession();
    const scope = await requireScope(session);
    const parsed = bankAccountSchema.safeParse({
      bankName: formDataString(form, "bankName"),
      bankCode: formDataString(form, "bankCode"),
      accountNumber: formDataString(form, "accountNumber"),
      accountHolder: formDataString(form, "accountHolder"),
      branch: formDataString(form, "branch"),
    });
    if (!parsed.success) return zodFailure(parsed.error);

    const account = await saveBankAccount(parsed.data, {
      scope,
      request: await actionRequest(),
    });
    await advanceOnboardingStep(session.userId ?? "", stepFromForm(form) + 1);
    return apiOk({ bank: toBankAccountView(account) });
  } catch (error) {
    return toActionError("onboarding.actions", error);
  }
}

// ─── Step 7 — signer ─────────────────────────────────────────────────────

export async function saveSignerAction(form: FormData): Promise<
  WizardOk<{ signer: SignerView }>
> {
  try {
    const session = await requireOnboardingSession();
    const scope = await requireScope(session);
    const parsed = signerSchema.safeParse({
      name: formDataString(form, "name"),
      title: formDataString(form, "title"),
      location: formDataString(form, "location"),
    });
    if (!parsed.success) return zodFailure(parsed.error);

    const signature = form.get("signatureFile");
    const signatureFile =
      signature instanceof File && signature.size > 0 ? signature : null;

    const signer = await saveSigner(
      parsed.data,
      { scope, request: await actionRequest() },
      { signatureFile },
    );
    await advanceOnboardingStep(session.userId ?? "", stepFromForm(form) + 1);
    return apiOk({ signer: toSignerView(signer) });
  } catch (error) {
    return toActionError("onboarding.actions", error);
  }
}

// ─── Step 8 — invoice profile identity ───────────────────────────────────

export async function saveInvoiceProfileAction(form: FormData): Promise<
  WizardOk<{ profile: ProfileView }>
> {
  try {
    const session = await requireOnboardingSession();
    const scope = await requireScope(session);
    const ctx = { scope, request: await actionRequest() };
    const parsed = profileIdentitySchema.safeParse({
      name: formDataString(form, "name"),
      code: formDataString(form, "code"),
    });
    if (!parsed.success) return zodFailure(parsed.error);

    const existing = await getProfileByOrg(scope.organizationId);
    const profile = existing
      ? await updateProfile(existing.id, parsed.data, ctx)
      : await createProfile(ctx, parsed.data);
    await advanceOnboardingStep(session.userId ?? "", stepFromForm(form) + 1);
    return apiOk({ profile: toProfileView(profile) });
  } catch (error) {
    return toActionError("onboarding.actions", error);
  }
}

// ─── Step 9 — numbering ──────────────────────────────────────────────────

export async function saveNumberingAction(form: FormData): Promise<
  WizardOk<{ profile: ProfileView }>
> {
  try {
    const session = await requireOnboardingSession();
    const scope = await requireScope(session);
    const ctx = { scope, request: await actionRequest() };
    const parsed = numberingSchema.safeParse({
      numberPattern: formDataString(form, "numberPattern"),
      sequenceResetPolicy: formDataString(form, "sequenceResetPolicy") || "YEARLY",
    });
    if (!parsed.success) return zodFailure(parsed.error);

    const profile = await ensureProfile(ctx);
    const updated = await updateProfile(profile.id, parsed.data, ctx);
    await advanceOnboardingStep(session.userId ?? "", stepFromForm(form) + 1);
    return apiOk({ profile: toProfileView(updated) });
  } catch (error) {
    return toActionError("onboarding.actions", error);
  }
}

// ─── Step 10 — stamp preference ───────────────────────────────────────────

const stampSchema = z.object({ defaultStampMode: stampModeSchema });

export async function saveStampPreferenceAction(form: FormData): Promise<
  WizardOk<{ profile: ProfileView }>
> {
  try {
    const session = await requireOnboardingSession();
    const scope = await requireScope(session);
    const ctx = { scope, request: await actionRequest() };
    const parsed = stampSchema.safeParse({
      defaultStampMode: formDataString(form, "defaultStampMode"),
    });
    if (!parsed.success) return zodFailure(parsed.error);

    const profile = await ensureProfile(ctx);
    const updated = await updateProfile(profile.id, parsed.data, ctx);
    await advanceOnboardingStep(session.userId ?? "", stepFromForm(form) + 1);
    return apiOk({ profile: toProfileView(updated) });
  } catch (error) {
    return toActionError("onboarding.actions", error);
  }
}

// ─── Step 11 → 12 navigation (no data written) ────────────────────────────

export async function advanceOnboardingStepAction(form: FormData): Promise<
  WizardOk<{ step: number }>
> {
  try {
    const session = await requireOnboardingSession();
    const state = await advanceOnboardingStep(
      session.userId ?? "",
      stepFromForm(form) + 1,
    );
    return apiOk({ step: state.step });
  } catch (error) {
    return toActionError("onboarding.actions", error);
  }
}

// ─── Step 12 — finish ─────────────────────────────────────────────────────

export async function finishOnboardingAction(): Promise<WizardOk<{ step: number }>> {
  try {
    const session = await requireOnboardingSession();
    // Defense in depth: completion requires a chosen org AND a saved profile —
    // legitimate users reach step 12 only after step 2, this proves it.
    const scope = await requireWorkspaceScope(session);
    const profile = await getProfileByOrg(scope.organizationId);
    if (!profile) {
      return apiFailure(
        "VALIDATION_ERROR",
        "Lengkapi profil perusahaan (langkah 2) sebelum menyelesaikan onboarding.",
      );
    }
    const state = await completeOnboarding(session.userId ?? "");
    return apiOk({ step: state.step });
  } catch (error) {
    return toActionError("onboarding.actions", error);
  }
}
