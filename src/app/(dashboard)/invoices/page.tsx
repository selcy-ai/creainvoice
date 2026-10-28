// src/app/(dashboard)/invoices/page.tsx
// The operational invoice list (feature 08): server-side pagination, search,
// filters (status / jenis / customer / profil / rentang tanggal) and column
// sort — all URL-driven so back/forward and sharing reproduce the view. The
// server resolves the org scope and the query service answers with rows plus
// per-row action flags; VIEWER sees a read-only menu, STAFF/OWNER/ADMIN get
// the actions their role and each invoice's status would actually accept.

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { PlusIcon } from "lucide-react";
import { InvoicesTable } from "@/components/tables/invoices-table";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { env } from "@/server/env";
import {
  INVOICES_PAGE_SIZE,
  INVOICE_SORT_FIELDS,
  listInvoiceFilterOptions,
  listInvoices,
} from "@/modules/invoices/query-service";
import { resolveWorkspaceScope } from "@/modules/workspace/service";
import { getSession } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Invoice — creainvoice",
};

export const dynamic = "force-dynamic";

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  const scope = await resolveWorkspaceScope(session);
  const params = await searchParams;

  const page = Math.max(1, Number(first(params.page)) || 1);
  const q = first(params.q).slice(0, 100);
  const customer = first(params.customer).slice(0, 64);
  const profile = first(params.profile).slice(0, 64);
  const status = first(params.status).slice(0, 32);
  const type = first(params.type).slice(0, 32);
  const from = first(params.from).slice(0, 10);
  const to = first(params.to).slice(0, 10);
  // Sort is whitelisted here AND re-validated in the query service.
  const sortRaw = first(params.sort);
  const sort = (INVOICE_SORT_FIELDS as readonly string[]).includes(sortRaw)
    ? sortRaw
    : "invoiceDate";
  const dir = first(params.dir) === "asc" ? "asc" : "desc";

  if (!scope) {
    return (
      <div className="flex flex-col gap-8">
        <h1 className="text-2xl font-semibold tracking-tight">Invoice</h1>
        <Card>
          <CardHeader>
            <CardTitle>Belum ada workspace aktif</CardTitle>
            <CardDescription>
              Pilih atau buat organisasi terlebih dahulu untuk melihat daftar invoice.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const [result, options] = await Promise.all([
    listInvoices(
      { scope },
      { page, pageSize: INVOICES_PAGE_SIZE, search: q, customer, profile, status, type, from, to, sort, dir },
    ),
    listInvoiceFilterOptions({ scope }),
  ]);
  const mayCreate = Boolean(scope);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-semibold uppercase tracking-[0.8px] text-muted-foreground/80">
            Daftar
          </p>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-[28px]">Invoice</h1>
          <p className="text-sm text-muted-foreground">
            Seluruh invoice organisasi ini — draft sampai yang sudah dilunasi — dalam satu
            halaman.
          </p>
        </div>
        {mayCreate ? (
          <Button render={<Link href="/invoices/new" />}>
            <PlusIcon aria-hidden="true" />
            Invoice Baru
          </Button>
        ) : null}
      </div>

      <InvoicesTable
        rows={result.rows}
        total={result.total}
        page={result.page}
        pageSize={result.pageSize}
        filters={{ q, customer, profile, status, type, from, to, sort, dir }}
        options={options}
        mayCreate={mayCreate}
        canOverrideOverpayment={Boolean(scope)}
        uploadMaxMb={Math.round(env.UPLOAD_MAX_MB)}
      />
    </div>
  );
}
