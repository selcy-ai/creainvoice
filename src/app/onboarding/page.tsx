// src/app/onboarding/page.tsx
// The 12-step wizard, outside the dashboard shell. Everything the steps need
// is loaded server-side: resume step, the Clerk organizations the user may
// select, and the already-saved profile/bank/signer snapshots.
//
// Change 6: organizations come from CLERK (the webhook mirrors memberships
// locally). Creating one happens through Clerk, so step 1 offers the Clerk
// <OrganizationList> for creation/selection plus the local mirror list.

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { OnboardingWizard } from "@/components/onboarding/wizard";
import { getOnboardingState } from "@/modules/onboarding/service";
import { getWorkspaceOverview } from "@/modules/workspace/service";
import { getProfileByOrg, toProfileView } from "@/modules/profiles/service";
import { getDefaultBankAccount, toBankAccountView } from "@/modules/bank-accounts/service";
import { getDefaultSigner, toSignerView } from "@/modules/signers/service";
import { getSession } from "@/lib/clerk";
import { env } from "@/server/env";

export const metadata: Metadata = {
  title: "Onboarding — CreaInvoice",
};

export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const session = await getSession();
  if (!session?.userId) redirect("/login");

  const state = await getOnboardingState(session.userId);
  if (state.complete) redirect("/dashboard");

  const overview = await getWorkspaceOverview(session);
  const activeOrganizationId = overview.activeOrganizationId;
  const hasScope = activeOrganizationId !== null;

  // With an active workspace we resume at the furthest saved step. Without
  // one, no later step can write (server scope guard says "pilih organisasi"),
  // so the honest resume position is step 1 — after choosing, the wizard
  // jumps back to the saved step.
  const initialStep = hasScope ? state.step : 1;

  const memberships = overview.memberships.map((membership) => ({
    id: membership.organization.id,
    name: membership.organization.name,
    slug: membership.organization.slug,
  }));

  const profile = activeOrganizationId
    ? await getProfileByOrg(activeOrganizationId).then((row) => (row ? toProfileView(row) : null))
    : null;
  const bank = activeOrganizationId
    ? await getDefaultBankAccount(activeOrganizationId).then((row) => (row ? toBankAccountView(row) : null))
    : null;
  const signer = activeOrganizationId
    ? await getDefaultSigner(activeOrganizationId).then((row) => (row ? toSignerView(row) : null))
    : null;

  return (
    <main className="min-h-screen bg-background">
      <OnboardingWizard
        initialStep={initialStep}
        resumeStep={state.step}
        maxMb={Math.round(env.UPLOAD_MAX_MB)}
        memberships={memberships}
        profile={profile}
        bank={bank}
        signer={signer}
        hasScope={hasScope}
      />
    </main>
  );
}
