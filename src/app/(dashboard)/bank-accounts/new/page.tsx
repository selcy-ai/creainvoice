// src/app/(dashboard)/bank-accounts/new/page.tsx
// Create bank account (feature 10). VIEWER never reaches a writable form
// (redirected back to the list) — the server action still re-checks with
// assertCan, so a crafted request gets 403, not a silent success.

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeftIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BankAccountForm } from "@/components/bank-accounts/bank-account-form";
import { resolveWorkspaceScope } from "@/modules/workspace/service";
import { getSession } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Tambah Rekening — creainvoice",
};

export const dynamic = "force-dynamic";

export default async function NewBankAccountPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const scope = await resolveWorkspaceScope(session);
  if (!scope || !Boolean(scope)) redirect("/bank-accounts");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Button variant="ghost" size="sm" render={<Link href="/bank-accounts" />}>
          <ArrowLeftIcon aria-hidden="true" />
          Kembali ke daftar rekening
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight">Tambah rekening</h1>
        <p className="text-sm text-muted-foreground">
          Isi data rekening bank perusahaan. Nomor rekening disimpan terenkripsi dan tidak dapat
          dikembalikan ke bentuk asli oleh klien.
        </p>
      </div>

      <BankAccountForm
        mode="create"
        canEdit
        accountNumberValue=""
        accountNumberMasked={false}
        defaultValues={{
          bankName: "",
          bankCode: "",
          accountHolder: "",
          branch: "",
          isDefault: true,
          isActive: true,
        }}
      />
    </div>
  );
}
