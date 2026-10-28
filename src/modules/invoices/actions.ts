// src/modules/invoices/actions.ts
// Server actions for the invoice DRAFT editor (feature 04). Autosave-safe:
// every call re-validates the full draft with the same Zod schema the client
// runs, resolves the active-org scope from the SESSION (never from the
// payload), and lets the service decide authorization + recalculation. The
// response carries the fresh server view — the editor renders its preview
// from server numbers (invariant 2).

"use server";

import {
  actionRequest,
  toActionError,
  zodFailure,
} from "@/lib/action";
import { apiFailure, apiOk, type ActionResult } from "@/lib/api-response";
import { requireSession } from "@/lib/auth";
import { requireWorkspaceScope } from "@/modules/workspace/service";
import {
  invoiceDraftFormSchema,
  type InvoiceDraftFormValues,
} from "@/modules/invoices/schema";
import {
  createDraft,
  deleteDraft,
  getDraft,
  getEditorOptions,
  getDraftNumberPreview,
  listCustomerContacts,
  listDrafts,
  prefillEditorFromProject,
  updateDraft,
  type DraftPartyView,
  type EditorOptions,
  type InvoiceDraftView,
  type InvoiceListItem,
} from "@/modules/invoices/service";
import { issueInvoice, type IssueOutcome } from "@/modules/invoices/issue-service";
import {
  quickSearchInvoices,
  type InvoiceQuickMatch,
} from "@/modules/invoices/query-service";
import {
  cancelInvoice,
  createRevision,
  markSent,
  type CancelOutcome,
  type MarkSentOutcome,
  type RevisionOutcome,
} from "@/modules/invoices/lifecycle-service";

async function serviceContext() {
  const session = await requireSession();
  const scope = await requireWorkspaceScope(session);
  return { scope, request: await actionRequest() };
}

export async function createInvoiceDraftAction(
  values: InvoiceDraftFormValues,
): Promise<ActionResult<InvoiceDraftView>> {
  try {
    const ctx = await serviceContext();
    const parsed = invoiceDraftFormSchema.safeParse(values);
    if (!parsed.success) return zodFailure(parsed.error);
    const draft = await createDraft(parsed.data, ctx);
    return apiOk(draft);
  } catch (error) {
    return toActionError("invoices.actions", error);
  }
}

export async function updateInvoiceDraftAction(
  values: InvoiceDraftFormValues & { invoiceId: string },
): Promise<ActionResult<InvoiceDraftView>> {
  try {
    const ctx = await serviceContext();
    if (!values.invoiceId) return apiFailure("VALIDATION_ERROR", "Invoice tidak valid.");
    const parsed = invoiceDraftFormSchema.safeParse(values);
    if (!parsed.success) return zodFailure(parsed.error);
    const draft = await updateDraft(values.invoiceId, parsed.data, ctx);
    return apiOk(draft);
  } catch (error) {
    return toActionError("invoices.actions", error);
  }
}

export async function getInvoiceDraftAction(values: {
  invoiceId: string;
}): Promise<ActionResult<InvoiceDraftView>> {
  try {
    const ctx = await serviceContext();
    if (!values.invoiceId) return apiFailure("VALIDATION_ERROR", "Invoice tidak valid.");
    return apiOk(await getDraft(values.invoiceId, ctx));
  } catch (error) {
    return toActionError("invoices.actions", error);
  }
}

export async function deleteInvoiceDraftAction(values: {
  invoiceId: string;
}): Promise<ActionResult<{ invoiceId: string }>> {
  try {
    const ctx = await serviceContext();
    if (!values.invoiceId) return apiFailure("VALIDATION_ERROR", "Invoice tidak valid.");
    await deleteDraft(values.invoiceId, ctx);
    return apiOk({ invoiceId: values.invoiceId });
  } catch (error) {
    return toActionError("invoices.actions", error);
  }
}

export async function listInvoiceDraftsAction(values: {
  page?: number;
} = {}): Promise<ActionResult<{ rows: InvoiceListItem[]; total: number; page: number; totalPages: number }>> {
  try {
    const ctx = await serviceContext();
    const result = await listDrafts(ctx, { page: values.page });
    return apiOk({ rows: result.rows, total: result.total, page: result.page, totalPages: result.totalPages });
  } catch (error) {
    return toActionError("invoices.actions", error);
  }
}

/** Editor option bundle (profiles, banks, signers) — one round-trip. */
export async function getEditorOptionsAction(): Promise<ActionResult<EditorOptions>> {
  try {
    const ctx = await serviceContext();
    return apiOk(await getEditorOptions(ctx));
  } catch (error) {
    return toActionError("invoices.actions", error);
  }
}

/** Live preview number for the editor (bucket + 1, never allocated). */
export async function invoiceNumberPreviewAction(values: {
  profileId: string;
  invoiceDate?: string;
}): Promise<ActionResult<string | null>> {
  try {
    const ctx = await serviceContext();
    if (!values.profileId) return apiOk(null);
    return apiOk(
      await getDraftNumberPreview(values.profileId, values.invoiceDate ?? "", ctx),
    );
  } catch (error) {
    return toActionError("invoices.actions", error);
  }
}

/** PIC dropdown data for the chosen customer (server-side lookup on select). */
export async function listInvoiceCustomerContactsAction(values: {
  customerId: string;
}): Promise<
  ActionResult<{ customer: DraftPartyView | null; contacts: Array<{ id: string; name: string; title: string | null; isPrimary: boolean }> }>
> {
  try {
    const ctx = await serviceContext();
    if (!values.customerId) return apiFailure("VALIDATION_ERROR", "Customer tidak valid.");
    const contacts = await listCustomerContacts(values.customerId, ctx);
    // The detail view carries the public bill-to fields (taxId masked by the
    // customers module for VIEWER roles — PII rules apply unchanged).
    const { getCustomerForScope, toCustomerDetail } = await import("@/modules/customers/service");
    const customer = await getCustomerForScope(values.customerId, ctx);
    const detail = toCustomerDetail(customer);
    return apiOk({
      customer: {
        id: detail.id,
        companyName: detail.companyName,
        address: detail.address,
        city: detail.city,
        province: detail.province,
        postalCode: detail.postalCode,
        country: detail.country,
        phone: detail.phone,
        email: detail.email,
        taxId: detail.taxIdMasked,
      },
      contacts,
    });
  } catch (error) {
    return toActionError("invoices.actions", error);
  }
}

/** Prefill from project (feature 03 contract, lifted to editor values). */
export async function prefillInvoiceFromProjectAction(values: { projectId: string }) {
  try {
    const ctx = await serviceContext();
    if (!values.projectId) return apiFailure("VALIDATION_ERROR", "Project tidak valid.");
    return apiOk(await prefillEditorFromProject(values.projectId, ctx));
  } catch (error) {
    return toActionError("invoices.actions", error);
  }
}

// ─── Issue & lifecycle (feature 05) ───────────────────────────────────────
/** DRAFT → ISSUED: recalculate, allocate the final number, freeze snapshots,
 * audit and enqueue the PDF job — all inside one transaction. */
export async function issueInvoiceAction(values: {
  invoiceId: string;
}): Promise<ActionResult<IssueOutcome>> {
  try {
    const ctx = await serviceContext();
    if (!values.invoiceId) return apiFailure("VALIDATION_ERROR", "Invoice tidak valid.");
    return apiOk(await issueInvoice(values.invoiceId, ctx));
  } catch (error) {
    return toActionError("invoices.actions", error);
  }
}

/** ISSUED → SENT (STAFF+), audited. */
export async function markSentInvoiceAction(values: {
  invoiceId: string;
}): Promise<ActionResult<MarkSentOutcome>> {
  try {
    const ctx = await serviceContext();
    if (!values.invoiceId) return apiFailure("VALIDATION_ERROR", "Invoice tidak valid.");
    return apiOk(await markSent(values.invoiceId, ctx));
  } catch (error) {
    return toActionError("invoices.actions", error);
  }
}

/** Cancel with a MANDATORY reason (OWNER/ADMIN), audited, excluded from
 * previouslyBilled from then on. */
export async function cancelInvoiceAction(values: {
  invoiceId: string;
  reason: string;
}): Promise<ActionResult<CancelOutcome>> {
  try {
    const ctx = await serviceContext();
    if (!values.invoiceId) return apiFailure("VALIDATION_ERROR", "Invoice tidak valid.");
    return apiOk(await cancelInvoice(values.invoiceId, values.reason, ctx));
  } catch (error) {
    return toActionError("invoices.actions", error);
  }
}

/** Old invoice → REVISED + a new draft copied from it (OWNER/ADMIN). */
export async function reviseInvoiceAction(values: {
  invoiceId: string;
}): Promise<ActionResult<RevisionOutcome>> {
  try {
    const ctx = await serviceContext();
    if (!values.invoiceId) return apiFailure("VALIDATION_ERROR", "Invoice tidak valid.");
    return apiOk(await createRevision(values.invoiceId, ctx));
  } catch (error) {
    return toActionError("invoices.actions", error);
  }
}

// ─── Command search (feature 08: Cmd+K) ───────────────────────────────────

/**
 * Quick invoice lookup for the command palette: matches number / preview /
 * customer, org-scoped, capped. Empty query answers an empty list (the
 * palette's route list is static — this only adds matches as you type).
 */
export async function searchInvoicesAction(values: {
  q: string;
}): Promise<ActionResult<InvoiceQuickMatch[]>> {
  try {
    const ctx = await serviceContext();
    return apiOk(await quickSearchInvoices(ctx, { q: values.q }));
  } catch (error) {
    return toActionError("invoices.actions", error);
  }
}
