// src/app/(dashboard)/bank-accounts/[id]/page.tsx
// Bank account detail + edit (feature 10). The service answers 404 for an id
// outside the session's organization (IDOR guard) and reveals the FULL account
// number only when the caller holds bankAccount.update (STAFF+) — VIEWER gets
// the masked value and a read-only form.

import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeftIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BankAccountForm } from "@/components/bank-accounts/bank-account-form";
import { DeleteBankAccountButton } from "@/components/bank-accounts/delete-bank-account-button";
import { getBankAccountDetail } from "@/modules/bank-accounts/service";
import { resolveWorkspaceScope } from "@/modules/workspace/service";
import { getSession } from "@/lib/clerk";
import { isAppError } from "@/lib/errors";

export const metadata: Metadata = {
  title: "Detail Rekening — creainvoice",
};

export const dynamic = "force-dynamic";

export default async function BankAccountDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  const scope = await resolveWorkspaceScope(session);
  if (!scope) redirect("/login");

  const { id } = await params;
  let account;
  try {
    account = await getBankAccountDetail(id, { scope });
  } catch (error) {
    // Foreign id / missing row → honest 404 (never "forbidden", no leak).
    if (isAppError(error) && error.code === "NOT_FOUND") notFound();
    throw error;
  }

  const mayEdit = Boolean(scope);
  const mayDelete = Boolean(scope);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Button variant="ghost" size="sm" render={<Link href="/bank-accounts" />}>
          <ArrowLeftIcon aria-hidden="true" />
          Kembali ke daftar rekening
        </Button>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{account.bankName}</h1>
          {account.isDefault ? <Badge variant="secondary">Utama</Badge> : null}
          {!account.isActive ? <Badge variant="outline">Nonaktif</Badge> : null}
        </div>
        <p className="text-sm text-muted-foreground">
          {account.accountNumber === null
            ? `Nomor tampil termask (${account.maskedNumber}) — akses lihat saja.`
            : "Nomor lengkap ditampilkan karena Anda punya izin mengelola rekening."}
        </p>
      </div>

      <BankAccountForm
        mode="edit"
        bankAccountId={account.id}
        canEdit={mayEdit}
        accountNumberValue={account.accountNumber ?? account.maskedNumber}
        accountNumberMasked={account.accountNumber === null}
        defaultValues={{
          bankName: account.bankName,
          bankCode: account.bankCode ?? "",
          accountHolder: account.accountHolder,
          branch: account.branch ?? "",
          isDefault: account.isDefault,
          isActive: account.isActive,
        }}
      />

      {mayDelete ? (
        <Card>
          <CardHeader>
            <CardTitle>Zona berbahaya</CardTitle>
            <CardDescription>
              Menghapus rekening bersifat permanen. Invoice terbit tetap memakai snapshot-nya.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DeleteBankAccountButton bankAccountId={account.id} bankName={account.bankName} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
