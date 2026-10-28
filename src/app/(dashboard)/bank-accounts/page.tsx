// src/app/(dashboard)/bank-accounts/page.tsx
// Bank account management list (feature 10): org-scoped, server-side
// pagination, MASKED numbers for everyone (spec: list/menu tampil masked) —
// the full number only exists behind the authorized detail page. "Tambah" and
// "Jadikan utama" render only where the service would accept them (permissions
// from the central matrix), so no fake buttons for VIEWER.

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { PlusIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SetDefaultBankButton } from "@/components/bank-accounts/set-default-bank-button";
import { listBankAccountsPage } from "@/modules/bank-accounts/service";
import { resolveWorkspaceScope } from "@/modules/workspace/service";
import { getSession } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Rekening Bank — creainvoice",
};

export const dynamic = "force-dynamic";

const DATE_FORMAT = new Intl.DateTimeFormat("id-ID", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "Asia/Jakarta",
});

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export default async function BankAccountsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  const scope = await resolveWorkspaceScope(session);
  const params = await searchParams;
  const page = Math.max(1, Number(first(params.page)) || 1);

  if (!scope) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-2xl font-semibold tracking-tight">Rekening Bank</h1>
        <Card>
          <CardHeader>
            <CardTitle>Belum ada workspace aktif</CardTitle>
            <CardDescription>
              Pilih atau buat organisasi terlebih dahulu untuk mengelola rekening bank.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const result = await listBankAccountsPage({ scope }, { page });
  const mayCreate = Boolean(scope);
  const mayManage = Boolean(scope);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Rekening Bank</h1>
          <p className="text-sm text-muted-foreground">
            Nomor rekening disimpan terenkripsi; daftar ini selalu menampilkan bentuk mask
            (**** **** 3449). Nomor lengkap hanya di halaman detail berizin dan dokumen invoice
            terbit.
          </p>
        </div>
        {mayCreate ? (
          <Button render={<Link href="/bank-accounts/new" />}>
            <PlusIcon aria-hidden="true" />
            Tambah rekening
          </Button>
        ) : null}
      </div>

      {result.rows.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Belum ada rekening bank</CardTitle>
            <CardDescription>
              {mayCreate
                ? "Tambahkan rekening pertama — rekening pertama otomatis jadi rekening utama."
                : "Belum ada rekening di organisasi ini. Hubungi STAFF atau aturan lebih tinggi untuk menambahkan."}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <Card>
          <CardContent className="pt-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Rekening</TableHead>
                  <TableHead>Atas nama</TableHead>
                  <TableHead>Nomor</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Dibuat</TableHead>
                  <TableHead className="text-right">Aksi</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>
                      <div className="font-medium">{row.bankName}</div>
                      <div className="text-xs text-muted-foreground">
                        {[row.bankCode, row.branch].filter(Boolean).join(" · ")}
                      </div>
                    </TableCell>
                    <TableCell>{row.accountHolder}</TableCell>
                    <TableCell className="font-mono tabular-nums">{row.maskedNumber}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {row.isDefault ? <Badge variant="secondary">Utama</Badge> : null}
                        {!row.isActive ? <Badge variant="outline">Nonaktif</Badge> : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {DATE_FORMAT.format(new Date(row.createdAt))}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        {mayManage && !row.isDefault ? (
                          <SetDefaultBankButton bankAccountId={row.id} bankName={row.bankName} />
                        ) : null}
                        <Button variant="ghost" size="sm" render={<Link href={`/bank-accounts/${row.id}`} />}>
                          Detail
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                {result.total} rekening · halaman {result.page} dari {result.pageCount}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={result.page <= 1}
                  render={
                    result.page > 1 ? (
                      <Link href={`/bank-accounts?page=${result.page - 1}`} />
                    ) : undefined
                  }
                >
                  Sebelumnya
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={result.page >= result.pageCount}
                  render={
                    result.page < result.pageCount ? (
                      <Link href={`/bank-accounts?page=${result.page + 1}`} />
                    ) : undefined
                  }
                >
                  Berikutnya
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
