// src/app/(dashboard)/projects/page.tsx
// Project / PO list: server-side pagination + search (URL-driven), TanStack
// Table presentation in ProjectsTable. Reads require an active-org scope;
// "Tambah project" is shown to STAFF+ (server actions re-check with assertCan).

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { PlusIcon } from "lucide-react";
import { PROJECTS_PAGE_SIZE } from "@/modules/workspace/constants";
import { ProjectsTable } from "@/components/tables/projects-table";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { listProjects } from "@/modules/projects/service";
import { resolveWorkspaceScope } from "@/modules/workspace/service";
import { getSession } from "@/lib/clerk";

export const metadata: Metadata = {
  title: "Project / PO — creainvoice",
};

export const dynamic = "force-dynamic";

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ProjectsPage({
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
      <div className="flex flex-col gap-6">
        <h1 className="text-2xl font-semibold tracking-tight">Project / PO</h1>
        <Card>
          <CardHeader>
            <CardTitle>Belum ada workspace aktif</CardTitle>
            <CardDescription>
              Pilih atau buat organisasi terlebih dahulu untuk mengelola project dan PO.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const result = await listProjects({ scope }, { page, pageSize: PROJECTS_PAGE_SIZE, q });
  const mayCreate = Boolean(scope);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Project / PO</h1>
          <p className="text-sm text-muted-foreground">
            Referensi PO, SPK, kontrak, dan penawaran — dasar prefill saat membuat invoice.
          </p>
        </div>
        {mayCreate ? (
          <Button render={<Link href="/projects/new" />}>
            <PlusIcon aria-hidden="true" />
            Tambah project
          </Button>
        ) : null}
      </div>

      <ProjectsTable
        rows={result.rows}
        total={result.total}
        page={result.page}
        pageSize={result.pageSize}
        q={q}
      />
    </div>
  );
}
