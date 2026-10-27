// src/app/(dashboard)/profiles/page.tsx
// The org has at most one invoice profile (data-model rule), so this entry
// sends members straight to /profiles/[id] when it exists and offers a real
// create when it doesn't — no fake list rows.

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { CreateProfileButton } from "@/components/profiles/create-profile-button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getProfileByOrg } from "@/modules/profiles/service";
import { resolveWorkspaceScope } from "@/modules/workspace/service";
import { getSession } from "@/lib/clerk";

export const metadata: Metadata = {
  title: "Profil Invoice — creainvoice",
};

export const dynamic = "force-dynamic";

export default async function ProfilesPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const scope = await resolveWorkspaceScope(session);
  if (scope) {
    const profile = await getProfileByOrg(scope.organizationId);
    if (profile) redirect(`/profiles/${profile.id}`);
  }

  const mayEdit = scope ? Boolean(scope) : false;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">Profil Invoice</h1>
        <p className="text-sm text-muted-foreground">
          Pengaturan identitas, tampilan, penomoran, pajak, dan meterai untuk invoice Anda.
        </p>
      </div>

      {!scope ? (
        <Card className="ring-border shadow-xs">
          <CardHeader>
            <CardTitle>Belum ada workspace aktif</CardTitle>
            <CardDescription>
              Pilih atau buat organisasi terlebih dahulu sebelum mengatur profil invoice.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <Card className="ring-border shadow-xs">
          <CardHeader>
            <CardTitle>Belum ada profil invoice</CardTitle>
            <CardDescription>
              Buat profil untuk mulai mengatur logo, warna brand, pola nomor, dan preferensi
              meterai.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {mayEdit ? (
              <CreateProfileButton />
            ) : (
              <p className="text-sm text-muted-foreground">
                Hanya OWNER atau ADMIN yang dapat membuat profil invoice. Hubungi administrator
                workspace Anda.
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
