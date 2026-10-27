// src/app/(dashboard)/customers/page.tsx
// Customer list: server-side pagination + search (URL-driven), TanStack Table
// presentation in CustomersTable. Reads require an active-org scope only;
// the "Tambah customer" entry is shown to STAFF+ (server actions re-check).

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { PlusIcon } from "lucide-react";
import { CUSTOMERS_PAGE_SIZE } from "@/modules/workspace/constants";
import { CustomersTable } from "@/components/tables/customers-table";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { listCustomers } from "@/modules/customers/service";
import { resolveWorkspaceScope } from "@/modules/workspace/service";
import { getSession } from "@/lib/clerk";

export const metadata: Metadata = {
  title: "Customer — creainvoice",
};

export const dynamic = "force-dynamic";

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  const scope = await resolveWorkspaceScope(session);
  const params = await searchParams;
  const requestedPage = Number(first(params.page) ?? "1");
  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? Math.trunc(requestedPage) : 1;
  const q = (first(params.q) ?? "").slice(0, 100);

  if (!scope) {
    return (
      <div className="flex flex-col gap-8">
        <h1 className="text-2xl font-semibold tracking-tight">Customer</h1>
        <Card className="ring-border shadow-xs">
          <CardHeader>
            <CardTitle>Belum ada workspace aktif</CardTitle>
            <CardDescription>
              Pilih atau buat organisasi terlebih dahulu untuk mengelola customer.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const result = await listCustomers({ scope }, { page, pageSize: CUSTOMERS_PAGE_SIZE, q });
  const mayCreate = Boolean(scope);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-semibold uppercase tracking-[0.8px] text-muted-foreground/80">
            Master
          </p>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-[28px]">Customer</h1>
          <p className="text-sm text-muted-foreground">
            Master data customer dan PIC untuk penagihan. Soft delete: customer yang dihapus
            tetap tercatat di audit log.
          </p>
        </div>
        {mayCreate ? (
          <Button render={<Link href="/customers/new" />}>
            <PlusIcon aria-hidden="true" />
            Tambah customer
          </Button>
        ) : null}
      </div>

      <CustomersTable
        rows={result.rows}
        total={result.total}
        page={result.page}
        pageSize={result.pageSize}
        q={q}
      />
    </div>
  );
}
