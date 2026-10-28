// src/app/(dashboard)/signers/new/page.tsx
// Create signer (feature 10). VIEWER never reaches a writable form (redirected
// back to the list) — the server action still re-checks with assertCan.

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeftIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SignerForm } from "@/components/signers/signer-form";
import { resolveWorkspaceScope } from "@/modules/workspace/service";
import { getSession } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Tambah Penanda Tangan — creainvoice",
};

export const dynamic = "force-dynamic";

export default async function NewSignerPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const scope = await resolveWorkspaceScope(session);
  if (!scope || !Boolean(scope)) redirect("/signers");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Button variant="ghost" size="sm" render={<Link href="/signers" />}>
          <ArrowLeftIcon aria-hidden="true" />
          Kembali ke daftar penanda tangan
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight">Tambah penanda tangan</h1>
        <p className="text-sm text-muted-foreground">
          Data ini tampil di blok tanda tangan dokumen invoice. Gambar tanda tangan opsional.
        </p>
      </div>

      <SignerForm
        mode="create"
        canEdit
        signaturePath={null}
        defaultValues={{
          name: "",
          title: "",
          location: "",
          isDefault: true,
          isActive: true,
        }}
      />
    </div>
  );
}
