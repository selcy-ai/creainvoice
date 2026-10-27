// src/modules/projects/service.ts
// ProjectReference (PO / SPK / contract / quotation) domain: org-scoped CRUD,
// server-side list with pagination/search, PO attachment lifecycle through
// StorageService, prefillFromProject — the preparation hook the invoice
// editor calls to pre-fill a new draft from a project — and billedToDate:
// how much of this project has been invoiced, straight from the Invoice
// table (invariant 6: only issued-and-later, non-CANCELLED/non-REVISED
// invoices count).

import { log } from "@/modules/audit/service";
import { AppError } from "@/lib/errors";
import type { WorkspaceScope } from "@/modules/workspace/service";
import { assertCan, requireOrgScope } from "@/modules/workspace/permissions";
import { getStorageService } from "@/modules/storage";
import { getCustomerForScope } from "@/modules/customers/service";
import { BILLED_STATUSES, sumBilledForProject } from "@/modules/invoices/billed";
import { parseCalendarDate } from "@/lib/date";
import Decimal from "decimal.js";
import { logger } from "@/server/logger";
import { db } from "@/server/db";
import { projectFormSchema } from "@/modules/projects/schema";
import { customers, invoices, projectReferences } from "@/db/schema";
import type { AuditAction, ProjectStatus, ReferenceType } from "@/db/enums";
import { and, asc, count, desc, eq, ilike, or } from "drizzle-orm";
import type { z } from "zod";

export type ProjectFormInput = z.infer<typeof projectFormSchema>;

type ProjectRow = typeof projectReferences.$inferSelect;
type ProjectInsert = typeof projectReferences.$inferInsert;

/** Only these content types can become a PO attachment (sniffed, not claimed). */
export const ATTACHMENT_MIME_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

/** Storage sub-directory for PO references (architecture-context storage model). */
const ATTACHMENT_KIND = "references";

// ─── Service context ──────────────────────────────────────────────────────

export interface ProjectServiceContext {
  scope: WorkspaceScope;
  request?: Request | null;
}

// ─── Views (serializable — server action → client components) ─────────────

export interface ProjectListItem {
  id: string;
  customerId: string;
  customerName: string;
  referenceType: ReferenceType;
  referenceNumber: string;
  referenceDate: string | null;
  title: string;
  workValue: string;
  currency: string;
  status: ProjectStatus;
  hasAttachment: boolean;
  createdAt: string;
}

export interface ProjectDetail {
  id: string;
  customerId: string;
  customerName: string;
  referenceType: ReferenceType;
  referenceNumber: string;
  referenceDate: string | null;
  title: string;
  description: string | null;
  workValue: string;
  currency: string;
  startDate: string | null;
  endDate: string | null;
  status: ProjectStatus;
  attachmentPath: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

function toProjectListItem(
  row: ProjectRow & { customerCompany: string | null },
): ProjectListItem {
  return {
    id: row.id,
    customerId: row.customerId,
    customerName: row.customerCompany ?? "",
    referenceType: row.referenceType,
    referenceNumber: row.referenceNumber,
    referenceDate: row.referenceDate ? row.referenceDate.toISOString() : null,
    title: row.title,
    workValue: row.workValue,
    currency: row.currency,
    status: row.status,
    hasAttachment: row.attachmentPath !== null,
    createdAt: row.createdAt.toISOString(),
  };
}

function toProjectDetail(
  row: ProjectRow & { customerCompany: string | null },
): ProjectDetail {
  return {
    id: row.id,
    customerId: row.customerId,
    customerName: row.customerCompany ?? "",
    referenceType: row.referenceType,
    referenceNumber: row.referenceNumber,
    referenceDate: row.referenceDate ? row.referenceDate.toISOString() : null,
    title: row.title,
    description: row.description,
    workValue: row.workValue,
    currency: row.currency,
    startDate: row.startDate ? row.startDate.toISOString() : null,
    endDate: row.endDate ? row.endDate.toISOString() : null,
    status: row.status,
    attachmentPath: row.attachmentPath,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ─── Audit (metadata: ids and field names only — never customer values) ─────

async function writeAudit(
  ctx: ProjectServiceContext,
  projectId: string,
  metadata: Record<string, unknown>,
  action: AuditAction = "PROJECT_UPDATED",
): Promise<void> {
  await log({
    actorUserId: ctx.scope.userId,
    organizationId: ctx.scope.organizationId,
    action,
    entityType: "project",
    entityId: projectId,
    metadata,
    request: ctx.request ?? null,
  });
}

// ─── Reads ─────────────────────────────────────────────────────────────────

export interface ListProjectsQuery {
  page?: number;
  pageSize?: number;
  q?: string;
}

/** Server-side pagination + search over reference number, title and the
 * linked customer's company name. Always org-scoped, pageSize capped. */
export async function listProjects(ctx: ProjectServiceContext, query: ListProjectsQuery = {}) {
  requireOrgScope(ctx.scope);
  const requestedPage = Number.isFinite(query.page) ? Math.max(1, Math.trunc(query.page ?? 1)) : 1;
  const requestedPageSize = Number.isFinite(query.pageSize) ? Math.trunc(query.pageSize ?? 20) : 20;
  const pageSize = Math.min(Math.max(requestedPageSize || 20, 1), 100);
  const q = (query.q ?? "").trim().slice(0, 100);

  const scopeFilter = eq(projectReferences.organizationId, ctx.scope.organizationId);
  const where = q
    ? and(
        scopeFilter,
        or(
          ilike(projectReferences.referenceNumber, `%${q}%`),
          ilike(projectReferences.title, `%${q}%`),
          ilike(customers.companyName, `%${q}%`),
        ),
      )
    : scopeFilter;

  const totalRows = await db
    .select({ value: count() })
    .from(projectReferences)
    .leftJoin(customers, eq(customers.id, projectReferences.customerId))
    .where(where);
  const total = Number(totalRows[0]?.value ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);

  const rows = await db
    .select({
      project: projectReferences,
      customerCompany: customers.companyName,
    })
    .from(projectReferences)
    .leftJoin(customers, eq(customers.id, projectReferences.customerId))
    .where(where)
    .orderBy(desc(projectReferences.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return {
    rows: rows.map((row) => toProjectListItem({ ...row.project, customerCompany: row.customerCompany })),
    total,
    page,
    pageSize,
    totalPages,
  };
}

/** Detail read with the IDOR guard: another org's id answers 404. */
export async function getProjectForScope(
  projectId: string,
  ctx: ProjectServiceContext,
): Promise<ProjectRow & { customer: { companyName: string; id: string } }> {
  requireOrgScope(ctx.scope);
  const rows = await db
    .select({
      project: projectReferences,
      customerCompany: customers.companyName,
      customerId: customers.id,
    })
    .from(projectReferences)
    .leftJoin(customers, eq(customers.id, projectReferences.customerId))
    .where(
      and(
        eq(projectReferences.id, projectId),
        eq(projectReferences.organizationId, ctx.scope.organizationId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row || !row.customerId) {
    throw new AppError("NOT_FOUND", "Project tidak ditemukan.");
  }
  return {
    ...row.project,
    customer: { companyName: row.customerCompany ?? "", id: row.customerId },
  };
}

// ─── Writes ────────────────────────────────────────────────────────────────

/** The target customer must exist, be alive, and belong to the caller's org
 * — a forged cross-org id answers 404 (IDOR guard), never "exists elsewhere".
 * Cross-module call through the customers module's exported service function
 * (architecture-standards "Cross Module Contracts"). */
async function requireCustomerInScope(customerId: string, ctx: ProjectServiceContext) {
  return getCustomerForScope(customerId, ctx);
}

export async function createProject(
  input: ProjectFormInput,
  ctx: ProjectServiceContext,
): Promise<ProjectRow> {
  assertCan("project.create", ctx.scope);
  const customer = await requireCustomerInScope(input.customerId, ctx);

  const [project] = await db
    .insert(projectReferences)
    .values({
      organizationId: ctx.scope.organizationId,
      customerId: customer.id,
      referenceType: input.referenceType,
      referenceNumber: input.referenceNumber,
      referenceDate: parseCalendarDate(input.referenceDate),
      title: input.title,
      description: input.description?.trim() || null,
      // Decimal string straight into the numeric column — never a float.
      workValue: input.workValue,
      currency: input.currency,
      startDate: parseCalendarDate(input.startDate),
      endDate: parseCalendarDate(input.endDate),
      status: input.status ?? "ACTIVE",
      notes: input.notes?.trim() || null,
    })
    .returning();
  if (!project) throw new AppError("INTERNAL_ERROR", "Project gagal dibuat.");

  await writeAudit(
    ctx,
    project.id,
    {
      change: "created",
      referenceType: project.referenceType,
      customerId: project.customerId,
      status: project.status,
    },
    "PROJECT_CREATED",
  );
  return project;
}

export async function updateProject(
  projectId: string,
  input: ProjectFormInput,
  ctx: ProjectServiceContext,
): Promise<ProjectRow> {
  assertCan("project.update", ctx.scope);
  const project = await getProjectForScope(projectId, ctx);

  const normalized: Record<string, unknown> = {
    referenceType: input.referenceType,
    referenceNumber: input.referenceNumber.trim(),
    referenceDate: parseCalendarDate(input.referenceDate),
    title: input.title.trim(),
    description: input.description?.trim() || null,
    workValue: input.workValue,
    currency: input.currency,
    startDate: parseCalendarDate(input.startDate),
    endDate: parseCalendarDate(input.endDate),
    notes: input.notes?.trim() || null,
  };
  // Status is optional input: absent means "leave the stored status alone".
  if (input.status !== undefined) normalized.status = input.status;
  if (input.customerId !== project.customerId) {
    await requireCustomerInScope(input.customerId, ctx);
    normalized.customerId = input.customerId;
  }

  const changed: string[] = [];
  for (const [key, next] of Object.entries(normalized)) {
    if (next === undefined) continue;
    const current = (project as unknown as Record<string, unknown>)[key];
    const currentComparable = current instanceof Date ? current.toISOString() : current;
    const nextComparable = next instanceof Date ? next.toISOString() : next;
    if (String(currentComparable ?? "") !== String(nextComparable ?? "")) changed.push(key);
  }
  if (changed.length === 0) return project;

  const data: Partial<ProjectInsert> = {};
  for (const key of changed) {
    const value = normalized[key];
    if (value === undefined) continue;
    (data as Record<string, unknown>)[key] = value;
  }

  const [updated] = await db
    .update(projectReferences)
    .set(data)
    .where(eq(projectReferences.id, project.id))
    .returning();
  if (!updated) throw new AppError("INTERNAL_ERROR", "Project gagal diperbarui.");

  await writeAudit(ctx, project.id, { change: "updated", fields: changed });
  return updated;
}

/**
 * Hard delete (data-model rule: only Customer soft-deletes; a project row is
 * history that the UI removes explicitly, with a confirm dialog). The
 * AuditAction enum has no PROJECT_DELETED — the removal is audited as
 * PROJECT_UPDATED with `change: "deleted"` (canonical list decision, kept by
 * Change 6). The stored attachment file is cleaned up best-effort; a storage
 * hiccup never fails the save.
 */
export async function deleteProject(
  projectId: string,
  ctx: ProjectServiceContext,
): Promise<ProjectRow> {
  assertCan("project.delete", ctx.scope);
  const project = await getProjectForScope(projectId, ctx);

  const [deleted] = await db
    .delete(projectReferences)
    .where(eq(projectReferences.id, project.id))
    .returning();
  if (!deleted) throw new AppError("INTERNAL_ERROR", "Project gagal dihapus.");

  if (project.attachmentPath) {
    await getStorageService()
      .delete(project.attachmentPath)
      .catch((error: unknown) =>
        logger.warn(
          { module: "projects", err: error instanceof Error ? error.message : String(error) },
          "lampiran PO gagal dihapus saat project dihapus",
        ),
      );
  }

  await writeAudit(ctx, project.id, {
    change: "deleted",
    referenceType: project.referenceType,
    customerId: project.customerId,
  });
  return deleted;
}

// ─── PO attachment (PDF/image, MIME sniffed, random filename) ──────────────

export async function uploadProjectAttachment(
  projectId: string,
  file: File,
  ctx: ProjectServiceContext,
): Promise<ProjectRow> {
  assertCan("project.update", ctx.scope);
  const project = await getProjectForScope(projectId, ctx);

  // validateUpload inside StorageService decides by content: over-limit and
  // fake-MIME files are rejected there with clear Indonesian messages.
  const stored = await getStorageService().upload(file, {
    orgId: ctx.scope.organizationId,
    kind: ATTACHMENT_KIND,
    allowedMimeTypes: ATTACHMENT_MIME_TYPES,
  });

  const [updated] = await db
    .update(projectReferences)
    .set({ attachmentPath: stored.path })
    .where(eq(projectReferences.id, project.id))
    .returning();
  if (!updated) throw new AppError("INTERNAL_ERROR", "Project gagal diperbarui.");

  if (project.attachmentPath) {
    // Best-effort cleanup of the replaced file — never fails the save.
    await getStorageService()
      .delete(project.attachmentPath)
      .catch((error: unknown) =>
        logger.warn(
          { module: "projects", err: error instanceof Error ? error.message : String(error) },
          "lampiran PO lama gagal dihapus",
        ),
      );
  }

  await writeAudit(ctx, project.id, {
    change: "attachment",
    path: stored.path,
    mimeType: stored.mimeType,
    sha256: stored.sha256,
  });
  return updated;
}

export async function removeProjectAttachment(
  projectId: string,
  ctx: ProjectServiceContext,
): Promise<ProjectRow> {
  assertCan("project.update", ctx.scope);
  const project = await getProjectForScope(projectId, ctx);
  if (!project.attachmentPath) return project;

  const [updated] = await db
    .update(projectReferences)
    .set({ attachmentPath: null })
    .where(eq(projectReferences.id, project.id))
    .returning();
  if (!updated) throw new AppError("INTERNAL_ERROR", "Project gagal diperbarui.");
  await getStorageService()
    .delete(project.attachmentPath)
    .catch((error: unknown) =>
      logger.warn(
        { module: "projects", err: error instanceof Error ? error.message : String(error) },
        "lampiran PO gagal dihapus dari storage",
      ),
    );
  await writeAudit(ctx, project.id, { change: "attachment_removed" });
  return updated;
}

// ─── Invoice prefill ───────────────────────────────────────────────────────

/**
 * Proposed editor line item. Projects carry no work-item table, so prefill
 * hands the invoice editor an EMPTY item list: honest, never a fabricated row.
 */
export interface ProjectPrefillItem {
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
}

export interface ProjectPrefill {
  customerId: string;
  referenceNumber: string;
  referenceDate: Date | null;
  /** Decimal string of the project's work value (never a float). */
  workValue: string;
  items: ProjectPrefillItem[];
}

/**
 * Feature 03 exposes ONLY this service (the calling UI lives in the invoice
 * editor). Org-scoped: a foreign project id answers 404.
 */
export async function prefillFromProject(
  projectId: string,
  ctx: ProjectServiceContext,
): Promise<ProjectPrefill> {
  const project = await getProjectForScope(projectId, ctx);
  return {
    customerId: project.customerId,
    referenceNumber: project.referenceNumber,
    referenceDate: project.referenceDate,
    workValue: project.workValue,
    items: [],
  };
}

// ─── billedToDate (replaces feature 03's honest placeholder) ───────────────

export interface ProjectBilling {
  workValue: string;
  /** Σ grandTotal of the invoices that count as billed (invariant 6). */
  billedToDate: string;
  /** workValue − billedToDate, never negative (decimal string). */
  remaining: string;
  invoiceCount: number;
}

/**
 * How much of this project is invoiced: sum of ISSUED-and-later invoices
 * (SENT/PARTIALLY_PAID/PAID/OVERDUE included; DRAFT/CANCELLED/REVISED
 * excluded — the rule lives in modules/invoices/billed.ts). Org-scoped: a
 * foreign project id answers 404.
 */
export async function getProjectBilling(
  projectId: string,
  ctx: ProjectServiceContext,
): Promise<ProjectBilling> {
  requireOrgScope(ctx.scope);
  const project = await getProjectForScope(projectId, ctx);
  const billedToDate = await sumBilledForProject(db, {
    organizationId: ctx.scope.organizationId,
    projectReferenceId: project.id,
  });
  const remainingRaw = new Decimal(project.workValue).minus(billedToDate);
  const countRows = await db
    .select({ value: count() })
    .from(invoices)
    .where(
      and(
        eq(invoices.organizationId, ctx.scope.organizationId),
        eq(invoices.projectReferenceId, project.id),
      ),
    );
  return {
    workValue: project.workValue,
    billedToDate,
    remaining: (remainingRaw.isNegative() ? new Decimal(0) : remainingRaw).toFixed(2),
    invoiceCount: Number(countRows[0]?.value ?? 0),
  };
}

/** Convenience read for call sites that only need the number. */
export async function billedToDate(
  projectId: string,
  ctx: ProjectServiceContext,
): Promise<string> {
  return (await getProjectBilling(projectId, ctx)).billedToDate;
}

/** Unused-import guard (keeps the module's exports stable for callers). */
export const __projectsAsc = asc;
