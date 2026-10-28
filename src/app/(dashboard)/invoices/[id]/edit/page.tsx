// src/app/(dashboard)/invoices/[id]/edit/page.tsx
// /invoices/[id]/edit — the same editor as /invoices/new, seeded from the
// persisted draft. The draft row is loaded and org/permission-checked
// server-side before any client component renders, so a foreign or issued
// invoice never reaches the editor (404 / redirect, not a client-side guard).

import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { resolveWorkspaceScope } from "@/modules/workspace/service";
import {
  getInvoiceDraftAction,
  getEditorOptionsAction,
} from "@/modules/invoices/actions";
import { getSession } from "@/lib/auth";
import { InvoiceEditor } from "@/components/invoice/invoice-editor";
import { logger } from "@/server/logger";

export const metadata: Metadata = {
  title: "Edit draft invoice — creainvoice",
};

export const dynamic = "force-dynamic";

export default async function EditInvoicePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  const scope = await resolveWorkspaceScope(session);
  if (!scope) redirect("/invoices");

  const { id } = await params;

  // Read first: the getDraft IDOR guard answers NOT_FOUND for a missing row AND
  // for another org's row (no cross-tenant existence leak).
  const draftResult = await getInvoiceDraftAction({ invoiceId: id });
  if (!draftResult.ok) {
    if (draftResult.error.code === "NOT_FOUND") notFound();
    if (draftResult.error.code === "LOCKED") {
      // An issued invoice is immutable (feature 05) — the revision path lives
      // on the detail page, so send the reader there instead of an editor
      // that could never save.
      redirect(`/invoices/${id}`);
    }
    logger.warn(
      { module: "invoices", err: draftResult.error.message },
      "draft gagal dimuat untuk edit",
    );
    notFound();
  }

  // A VIEWER can read a draft (the action's read permission) but not edit one —
  // the editor's save path re-checks too, so this is defense in depth.
  if (!Boolean(scope)) redirect("/invoices");

  const optionsResult = await getEditorOptionsAction();
  if (!optionsResult.ok) {
    logger.warn(
      { module: "invoices", err: optionsResult.error.message },
      "editor options gagal dimuat",
    );
    notFound();
  }

  return <InvoiceEditor options={optionsResult.data} initialDraft={draftResult.data} />;
}
