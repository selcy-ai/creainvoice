// src/app/(dashboard)/invoices/new/page.tsx
// /invoices/new — the draft editor for a brand-new invoice. The server
// component guards auth/org/permission and hands the editor its option bundle
// (one round trip); the client component owns the form, the autosave and the
// live preview. Prefill from a project comes through ?project=<id> (feature
// 03's contract), resolved server-side so nothing client-supplied is trusted.

import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { resolveWorkspaceScope } from "@/modules/workspace/service";
import { getEditorOptionsAction, prefillInvoiceFromProjectAction } from "@/modules/invoices/actions";
import {
  INVOICE_TYPES,
  type InvoiceTypeValue,
} from "@/modules/invoices/schema";
import { getSession } from "@/lib/auth";
import { InvoiceEditor } from "@/components/invoice/invoice-editor";
import { logger } from "@/server/logger";

export const metadata: Metadata = {
  title: "Invoice baru — creainvoice",
};

export const dynamic = "force-dynamic";

export default async function NewInvoicePage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string; type?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  const scope = await resolveWorkspaceScope(session);
  if (!scope) redirect("/invoices");
  if (!Boolean(scope)) redirect("/invoices");

  const optionsResult = await getEditorOptionsAction();
  if (!optionsResult.ok) {
    logger.warn(
      { module: "invoices", err: optionsResult.error.message },
      "editor options gagal dimuat",
    );
    notFound();
  }

  const { project, type } = await searchParams;
  // Whitelisted invoice type (?type=SETTLEMENT from the list's "Buat
  // settlement" action) — anything unknown is ignored, the editor's default
  // FULL still applies.
  const rawType = type ?? "";
  const initialInvoiceType = (INVOICE_TYPES as readonly string[]).includes(rawType)
    ? (rawType as InvoiceTypeValue)
    : undefined;
  const prefill = project
    ? await prefillInvoiceFromProjectAction({ projectId: project })
    : undefined;

  // A stale/foreign project id is not fatal — the editor opens empty (logged,
  // never silently forwarded to the client).
  if (prefill && !prefill.ok) {
    logger.warn(
      { module: "invoices", err: prefill.error.message },
      "prefill project gagal — editor dibuka kosong",
    );
  }

  return (
    <Suspense fallback={null}>
      <InvoiceEditor
        options={optionsResult.data}
        initialInvoiceType={initialInvoiceType}
        initialPrefill={
          prefill?.ok && project ? { projectId: project, data: prefill.data } : undefined
        }
      />
    </Suspense>
  );
}
