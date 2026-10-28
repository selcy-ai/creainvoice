// src/app/(dashboard)/signers/page.tsx
// Signer management list (feature 10): org-scoped, server-side pagination.
// A signer carries no secret (name/title/location/image), so VIEWER sees the
// same list — but "Tambah" and "Jadikan utama" render only where the service
// would accept them (permissions from the central matrix).

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
import { SetDefaultSignerButton } from "@/components/signers/set-default-signer-button";
import { listSignersPage } from "@/modules/signers/service";
import { resolveWorkspaceScope } from "@/modules/workspace/service";
import { getSession } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Penanda Tangan — creainvoice",
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

export default async function SignersPage({
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
        <h1 className="text-2xl font-semibold tracking-tight">Penanda Tangan</h1>
        <Card>
          <CardHeader>
            <CardTitle>Belum ada workspace aktif</CardTitle>
            <CardDescription>
              Pilih atau buat organisasi terlebih dahulu untuk mengelola penanda tangan.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const result = await listSignersPage({ scope }, { page });
  const mayCreate = Boolean(scope);
  const mayManage = Boolean(scope);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Penanda Tangan</h1>
          <p className="text-sm text-muted-foreground">
            Orang yang menandatangani dokumen invoice — nama, jabatan, lokasi, dan gambar tanda
            tangan.
          </p>
        </div>
        {mayCreate ? (
          <Button render={<Link href="/signers/new" />}>
            <PlusIcon aria-hidden="true" />
            Tambah penanda tangan
          </Button>
        ) : null}
      </div>

      {result.rows.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Belum ada penanda tangan</CardTitle>
            <CardDescription>
              {mayCreate
                ? "Tambahkan penanda tangan pertama — otomatis jadi yang utama."
                : "Belum ada penanda tangan di organisasi ini. Hubungi STAFF atau aturan lebih tinggi untuk menambahkan."}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <Card>
          <CardContent className="pt-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nama</TableHead>
                  <TableHead>Lokasi</TableHead>
                  <TableHead>Tanda tangan</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Dibuat</TableHead>
                  <TableHead className="text-right">Aksi</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>
                      <div className="font-medium">{row.name}</div>
                      <div className="text-xs text-muted-foreground">{row.title ?? "—"}</div>
                    </TableCell>
                    <TableCell>{row.location ?? "—"}</TableCell>
                    <TableCell>
                      {row.hasSignature ? (
                        <Badge variant="outline">Terlampir</Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
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
                          <SetDefaultSignerButton signerId={row.id} signerName={row.name} />
                        ) : null}
                        <Button variant="ghost" size="sm" render={<Link href={`/signers/${row.id}`} />}>
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
                {result.total} penanda tangan · halaman {result.page} dari {result.pageCount}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={result.page <= 1}
                  render={
                    result.page > 1 ? (
                      <Link href={`/signers?page=${result.page - 1}`} />
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
                      <Link href={`/signers?page=${result.page + 1}`} />
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
