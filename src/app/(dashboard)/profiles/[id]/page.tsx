// src/app/(dashboard)/profiles/[id]/page.tsx
// Full edit surface for the org's invoice profile: identity, company, contact,
// appearance (logo + accent), numbering, tax, stamp, notes. Cross-org ids get
// the same 404 as missing rows (IDOR guard lives in getProfileForScope).

import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { ProfileEditForm } from "@/components/profiles/profile-edit-form";
import { Badge } from "@/components/ui/badge";
import { isAppError } from "@/lib/errors";
import { resolveWorkspaceScope } from "@/modules/workspace/service";
import { getProfileForScope, toProfileView } from "@/modules/profiles/service";
import { getDefaultBankAccount, toBankAccountView } from "@/modules/bank-accounts/service";
import { getDefaultSigner, toSignerView } from "@/modules/signers/service";
import { getSession } from "@/lib/clerk";
import { env } from "@/server/env";

export const metadata: Metadata = {
  title: "Edit Profil Invoice — creainvoice",
};

export const dynamic = "force-dynamic";

export default async function ProfileEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getSession();
  if (!session) redirect("/login");

  const scope = await resolveWorkspaceScope(session);
  if (!scope) redirect("/profiles");

  let profile;
  try {
    profile = await getProfileForScope(id, { scope });
  } catch (error) {
    // Wrong organization and unknown id answer identically: 404.
    if (isAppError(error) && error.code === "NOT_FOUND") notFound();
    throw error;
  }

  const mayEdit = Boolean(scope);
  const bankRow = await getDefaultBankAccount(scope.organizationId);
  const signerRow = await getDefaultSigner(scope.organizationId);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Profil Invoice</h1>
          <p className="text-sm text-muted-foreground">
            {profile.name} · perubahan tercatat di audit log sebagai PROFILE_CHANGED.
          </p>
        </div>
        {!mayEdit ? <Badge variant="outline">Mode lihat saja</Badge> : null}
      </div>

      <ProfileEditForm
        profile={toProfileView(profile)}
        bank={bankRow ? toBankAccountView(bankRow) : null}
        signer={signerRow ? toSignerView(signerRow) : null}
        canEdit={mayEdit}
        maxMb={Math.round(env.UPLOAD_MAX_MB)}
      />
    </div>
  );
}
