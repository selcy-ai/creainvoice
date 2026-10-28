// src/app/(dashboard)/signers/[id]/page.tsx
// Signer detail + edit (feature 10). The service answers 404 for an id outside
// the session's organization (IDOR guard). Signers carry no secret, so VIEWER
// sees the same data — but read-only (assertCan still rejects their writes).

import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeftIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SignerForm } from "@/components/signers/signer-form";
import { DeleteSignerButton } from "@/components/signers/delete-signer-button";
import { getSignerDetail } from "@/modules/signers/service";
import { resolveWorkspaceScope } from "@/modules/workspace/service";
import { getSession } from "@/lib/auth";
import { isAppError } from "@/lib/errors";

export const metadata: Metadata = {
  title: "Detail Penanda Tangan — creainvoice",
};

export const dynamic = "force-dynamic";

export default async function SignerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  const scope = await resolveWorkspaceScope(session);
  if (!scope) redirect("/login");

  const { id } = await params;
  let signer;
  try {
    signer = await getSignerDetail(id, { scope });
  } catch (error) {
    if (isAppError(error) && error.code === "NOT_FOUND") notFound();
    throw error;
  }

  const mayEdit = Boolean(scope);
  const mayDelete = Boolean(scope);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Button variant="ghost" size="sm" render={<Link href="/signers" />}>
          <ArrowLeftIcon aria-hidden="true" />
          Kembali ke daftar penanda tangan
        </Button>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{signer.name}</h1>
          {signer.isDefault ? <Badge variant="secondary">Utama</Badge> : null}
          {!signer.isActive ? <Badge variant="outline">Nonaktif</Badge> : null}
        </div>
        <p className="text-sm text-muted-foreground">
          {signer.title ? `${signer.title} · ` : ""}
          {signer.location ?? "Lokasi belum diisi"}
        </p>
      </div>

      <SignerForm
        mode="edit"
        signerId={signer.id}
        canEdit={mayEdit}
        signaturePath={signer.signaturePath}
        defaultValues={{
          name: signer.name,
          title: signer.title ?? "",
          location: signer.location ?? "",
          isDefault: signer.isDefault,
          isActive: signer.isActive,
        }}
      />

      {mayDelete ? (
        <Card>
          <CardHeader>
            <CardTitle>Zona berbahaya</CardTitle>
            <CardDescription>
              Menghapus penanda tangan bersifat permanen, termasuk gambar tanda tangannya. Invoice
              terbit tetap memakai snapshot-nya.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DeleteSignerButton signerId={signer.id} signerName={signer.name} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
