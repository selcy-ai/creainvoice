// src/app/(dashboard)/projects/[id]/page.tsx
// Project detail: reference summary, attachment (upload/view/remove), edit
// form, the "Buat invoice" entry into the feature-04 prefill
// (/invoices/new?project=<id>, gated by invoice.draft.create so a VIEWER
// never sees a button that would bounce them), and the REAL billing block
// (feature 05): billedToDate/sisa from the Invoice table via
// getProjectBilling — feature 03's honest placeholder is now replaced by
// real numbers (invariant 6: DRAFT/CANCELLED/REVISED never count).
// Cross-org ids answer 404 (IDOR guard in getProjectForScope).

import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { PlusIcon } from "lucide-react";
import { AttachmentPanel } from "@/components/projects/attachment-panel";
import { DeleteProjectButton } from "@/components/projects/delete-project-button";
import { ProjectForm } from "@/components/projects/project-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { isAppError } from "@/lib/errors";
import { formatIdr } from "@/lib/money";
import { toCalendarInput } from "@/lib/date";
import {
  PROJECT_STATUS_LABELS,
  REFERENCE_TYPE_LABELS,
} from "@/modules/projects/schema";
import { getProjectForScope, getProjectBilling, type ProjectDetail } from "@/modules/projects/service";
import { resolveWorkspaceScope } from "@/modules/workspace/service";
import { getSession } from "@/lib/clerk";
import { env } from "@/server/env";

export const metadata: Metadata = {
  title: "Detail Project — creainvoice",
};

export const dynamic = "force-dynamic";

const STATUS_VARIANT: Record<ProjectDetail["status"], "default" | "secondary" | "outline" | "destructive"> = {
  ACTIVE: "outline",
  COMPLETED: "secondary",
  ON_HOLD: "default",
  CANCELLED: "destructive",
};

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("id-ID", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    timeZone: "Asia/Jakarta",
  });
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-b border-border py-3 last:border-b-0 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium sm:text-right">{value}</dd>
    </div>
  );
}

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getSession();
  if (!session) redirect("/login");

  const scope = await resolveWorkspaceScope(session);
  if (!scope) redirect("/projects");

  let project;
  try {
    project = await getProjectForScope(id, { scope });
  } catch (error) {
    if (isAppError(error) && error.code === "NOT_FOUND") notFound();
    throw error;
  }

  const mayEdit = Boolean(scope);
  const mayDelete = Boolean(scope);
  const mayCreateInvoice = Boolean(scope);

  // Feature 05: real billing numbers (the feature-03 placeholder is replaced
  // by the Invoice-table sum — invariant 6: DRAFT/CANCELLED/REVISED never
  // count as billed).
  const billing = await getProjectBilling(id, { scope });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{project.title}</h1>
            <Badge variant={STATUS_VARIANT[project.status]}>
              {PROJECT_STATUS_LABELS[project.status]}
            </Badge>
            <Badge variant="secondary">
              {REFERENCE_TYPE_LABELS[project.referenceType]}
            </Badge>
            {!mayEdit ? <Badge variant="outline">Mode lihat saja</Badge> : null}
          </div>
          <p className="text-sm text-muted-foreground">
            <Link href={`/customers/${project.customerId}`} className="hover:underline">
              {project.customer.companyName}
            </Link>
            {" · "}
            <span className="font-mono">{project.referenceNumber}</span>
          </p>
        </div>
        {mayCreateInvoice || mayDelete ? (
          <div className="flex flex-wrap items-center gap-2">
            {mayCreateInvoice ? (
              <Button render={<Link href={`/invoices/new?project=${project.id}`} />}>
                <PlusIcon aria-hidden="true" />
                Buat invoice
              </Button>
            ) : null}
            {mayDelete ? (
              <DeleteProjectButton projectId={project.id} title={project.title} />
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Ringkasan</CardTitle>
            <CardDescription>Referensi, nilai, dan jadwal pekerjaan.</CardDescription>
          </CardHeader>
          <CardContent>
            <dl>
              <Row label="Customer" value={project.customer.companyName} />
              <Row
                label="Jenis referensi"
                value={REFERENCE_TYPE_LABELS[project.referenceType]}
              />
              <Row
                label="Nomor referensi"
                value={<span className="font-mono">{project.referenceNumber}</span>}
              />
              <Row label="Tanggal referensi" value={formatDate(project.referenceDate ? project.referenceDate.toISOString() : null)} />
              <Row
                label="Nilai pekerjaan"
                value={<span className="font-mono">{formatIdr(project.workValue.toString())}</span>}
              />
              <Row label="Mata uang" value={project.currency} />
              <Row label="Tanggal mulai" value={formatDate(project.startDate ? project.startDate.toISOString() : null)} />
              <Row label="Tanggal selesai" value={formatDate(project.endDate ? project.endDate.toISOString() : null)} />
            </dl>
            {project.description ? (
              <p className="mt-4 whitespace-pre-wrap text-sm text-muted-foreground">
                {project.description}
              </p>
            ) : null}
          </CardContent>
        </Card>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Penagihan</CardTitle>
              <CardDescription>Status tagihan untuk project ini.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <span className="text-sm text-muted-foreground">Sudah ditagihkan</span>
                <span className="font-mono text-sm font-medium">
                  {formatIdr(billing.billedToDate)}
                </span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-sm text-muted-foreground">Sisa penagihan</span>
                <span className="font-mono text-sm font-medium">
                  {formatIdr(billing.remaining)}
                </span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-sm text-muted-foreground">Invoice terbit</span>
                <span className="text-sm font-medium">
                  {billing.invoiceCount} invoice terhitung (draft/batal/revisi tidak dihitung)
                </span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Lampiran</CardTitle>
            </CardHeader>
            <CardContent>
              <AttachmentPanel
                projectId={project.id}
                attachmentPath={project.attachmentPath}
                maxMb={Math.round(env.UPLOAD_MAX_MB)}
                canEdit={mayEdit}
              />
            </CardContent>
          </Card>
        </div>
      </div>

      <ProjectForm
        mode="edit"
        projectId={project.id}
        canEdit={mayEdit}
        initialCustomerName={project.customer.companyName}
        defaultValues={{
          customerId: project.customerId,
          referenceType: project.referenceType,
          referenceNumber: project.referenceNumber,
          referenceDate: toCalendarInput(project.referenceDate?.toISOString() ?? null),
          title: project.title,
          description: project.description ?? "",
          workValue: project.workValue.toString(),
          // Every write path validates currency against z.enum(["IDR"]), so a
          // stored project can only ever be IDR.
          currency: "IDR",
          startDate: toCalendarInput(project.startDate?.toISOString() ?? null),
          endDate: toCalendarInput(project.endDate?.toISOString() ?? null),
          status: project.status,
          notes: project.notes ?? "",
        }}
      />
    </div>
  );
}
