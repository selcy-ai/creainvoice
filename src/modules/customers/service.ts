// src/modules/customers/service.ts
// Customer + CustomerContact (PIC) domain: org-scoped CRUD, server-side list
// with pagination/search, soft delete, and PIC management with a single
// primary per customer.
//
// Authorization: reads require an active workspace scope (fail closed) and
// every mutation runs through the authorization door (assertCan) — flat
// workspace, every member is a full admin (Change 6). Customer values are
// PII: audit metadata carries field NAMES only, never field values (NPWP
// never reaches the audit table or the logs).

import { log } from "@/modules/audit/service";
import { AppError } from "@/lib/errors";
import type { WorkspaceScope } from "@/modules/workspace/service";
import { assertCan, requireOrgScope } from "@/modules/workspace/permissions";
import { contactFormSchema, customerFormSchema } from "@/modules/customers/schema";
import { db } from "@/server/db";
import {
  customerContacts,
  customers,
} from "@/db/schema";
import type { z } from "zod";
import { and, asc, count, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";

export type CustomerFormInput = z.infer<typeof customerFormSchema>;
export type ContactFormInput = z.infer<typeof contactFormSchema>;

// ─── Service context ──────────────────────────────────────────────────────

export interface CustomerServiceContext {
  scope: WorkspaceScope;
  request?: Request | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** "" / whitespace-only → null (clears the column); undefined → untouched. */
function nullIfEmpty(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * NPWP shown to users who cannot edit customers: first 4 characters stay
 * readable, the rest is masked. The full value only ever reaches the edit
 * form of an authorized caller — never a read-only reader's HTML.
 */
export function maskTaxId(value: string | null | undefined): string | null {
  if (!value) return null;
  const visible = value.slice(0, 4);
  const hidden = "•".repeat(Math.max(4, value.length - 4));
  return `${visible}${hidden}`;
}

function emptyToNulls<T extends Record<string, unknown>>(
  input: T,
  keys: ReadonlyArray<keyof T & string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input };
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string") out[key] = nullIfEmpty(value);
  }
  return out;
}

const CUSTOMER_TEXT_NULL_KEYS = [
  "legalName",
  "businessType",
  "taxId",
  "address",
  "city",
  "province",
  "postalCode",
  "country",
  "phone",
  "whatsapp",
  "email",
  "notes",
] as const;

/** Columns the customer form may set, in schema order. */
type CustomerInsert = typeof customers.$inferInsert;
type CustomerRow = typeof customers.$inferSelect;
type ContactRow = typeof customerContacts.$inferSelect;

// ─── Views (serializable — server action → client components) ─────────────

export interface CustomerListItem {
  id: string;
  companyName: string;
  legalName: string | null;
  businessType: string | null;
  city: string | null;
  phone: string | null;
  email: string | null;
  isActive: boolean;
  contactCount: number;
  createdAt: string;
}

export interface CustomerDetail {
  id: string;
  companyName: string;
  legalName: string | null;
  businessType: string | null;
  /** Masked NPWP — safe for every reader. */
  taxIdMasked: string | null;
  address: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  country: string | null;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ContactView {
  id: string;
  name: string;
  title: string | null;
  division: string | null;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  isPrimary: boolean;
}

export function toCustomerDetail(customer: CustomerRow): CustomerDetail {
  return {
    id: customer.id,
    companyName: customer.companyName,
    legalName: customer.legalName,
    businessType: customer.businessType,
    taxIdMasked: maskTaxId(customer.taxId),
    address: customer.address,
    city: customer.city,
    province: customer.province,
    postalCode: customer.postalCode,
    country: customer.country,
    phone: customer.phone,
    whatsapp: customer.whatsapp,
    email: customer.email,
    notes: customer.notes,
    isActive: customer.isActive,
    createdAt: customer.createdAt.toISOString(),
    updatedAt: customer.updatedAt.toISOString(),
  };
}

export function toContactView(contact: ContactRow): ContactView {
  return {
    id: contact.id,
    name: contact.name,
    title: contact.title,
    division: contact.division,
    email: contact.email,
    phone: contact.phone,
    whatsapp: contact.whatsapp,
    isPrimary: contact.isPrimary,
  };
}

// ─── Audit (metadata: field names and ids only — never customer values) ────

async function writeAudit(
  ctx: CustomerServiceContext,
  action: "CUSTOMER_CREATED" | "CUSTOMER_UPDATED" | "CUSTOMER_DELETED",
  entityId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await log({
    actorUserId: ctx.scope.userId,
    organizationId: ctx.scope.organizationId,
    action,
    entityType: "customer",
    entityId,
    metadata,
    request: ctx.request ?? null,
  });
}

// ─── Reads ─────────────────────────────────────────────────────────────────

export interface ListCustomersQuery {
  page?: number;
  pageSize?: number;
  q?: string;
}

/**
 * Server-side pagination + search, always scoped to the active organization.
 * Soft-deleted customers never appear. pageSize is capped at 100 so
 * `pageSize=999999` cannot pull the whole table (security-standards).
 */
export async function listCustomers(ctx: CustomerServiceContext, query: ListCustomersQuery = {}) {
  requireOrgScope(ctx.scope);
  const requestedPage = Number.isFinite(query.page) ? Math.max(1, Math.trunc(query.page ?? 1)) : 1;
  const requestedPageSize = Number.isFinite(query.pageSize) ? Math.trunc(query.pageSize ?? 20) : 20;
  const pageSize = Math.min(Math.max(requestedPageSize || 20, 1), 100);
  const q = (query.q ?? "").trim().slice(0, 100);

  const scopeFilter = and(
    eq(customers.organizationId, ctx.scope.organizationId),
    isNull(customers.deletedAt),
  );
  const where = q
    ? and(
        scopeFilter,
        or(ilike(customers.companyName, `%${q}%`), ilike(customers.legalName, `%${q}%`)),
      )
    : scopeFilter;

  const totalRows = await db
    .select({ value: count() })
    .from(customers)
    .where(where);
  const total = Number(totalRows[0]?.value ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);

  const rows = await db
    .select({
      id: customers.id,
      companyName: customers.companyName,
      legalName: customers.legalName,
      businessType: customers.businessType,
      city: customers.city,
      phone: customers.phone,
      email: customers.email,
      isActive: customers.isActive,
      createdAt: customers.createdAt,
      contactCount: count(customerContacts.id),
    })
    .from(customers)
    .leftJoin(customerContacts, eq(customerContacts.customerId, customers.id))
    .where(where)
    .groupBy(customers.id)
    .orderBy(asc(customers.companyName), asc(customers.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return {
    rows: rows.map<CustomerListItem>((row) => ({
      id: row.id,
      companyName: row.companyName,
      legalName: row.legalName,
      businessType: row.businessType,
      city: row.city,
      phone: row.phone,
      email: row.email,
      isActive: row.isActive,
      contactCount: Number(row.contactCount),
      createdAt: row.createdAt.toISOString(),
    })),
    total,
    page,
    pageSize,
    totalPages,
  };
}

/** Customer + its contacts (primary first) for the detail view/edit form. */
export interface CustomerWithContacts extends CustomerRow {
  contacts: ContactRow[];
}

/**
 * Detail read with the IDOR guard: another organization's id and a soft-
 * deleted customer both answer 404 (same as a row that never existed).
 */
export async function getCustomerForScope(
  customerId: string,
  ctx: CustomerServiceContext,
): Promise<CustomerWithContacts> {
  requireOrgScope(ctx.scope);
  const rows = await db
    .select()
    .from(customers)
    .where(and(eq(customers.id, customerId), eq(customers.organizationId, ctx.scope.organizationId)))
    .limit(1);
  const customer = rows[0];
  if (!customer || customer.deletedAt) {
    throw new AppError("NOT_FOUND", "Customer tidak ditemukan.");
  }
  const contacts = await db
    .select()
    .from(customerContacts)
    .where(eq(customerContacts.customerId, customer.id))
    .orderBy(desc(customerContacts.isPrimary), asc(customerContacts.createdAt));
  return { ...customer, contacts };
}

// ─── Customer writes ──────────────────────────────────────────────────────

export async function createCustomer(
  input: CustomerFormInput,
  ctx: CustomerServiceContext,
): Promise<CustomerRow> {
  assertCan("customer.create", ctx.scope);
  const data = emptyToNulls(input, CUSTOMER_TEXT_NULL_KEYS);

  const [customer] = await db
    .insert(customers)
    .values({
      organizationId: ctx.scope.organizationId,
      companyName: input.companyName,
      legalName: (data.legalName as string | null) ?? null,
      businessType: (data.businessType as string | null) ?? null,
      taxId: (data.taxId as string | null) ?? null,
      address: (data.address as string | null) ?? null,
      city: (data.city as string | null) ?? null,
      province: (data.province as string | null) ?? null,
      postalCode: (data.postalCode as string | null) ?? null,
      country: (data.country as string | null) ?? null,
      phone: (data.phone as string | null) ?? null,
      whatsapp: (data.whatsapp as string | null) ?? null,
      email: (data.email as string | null) ?? null,
      notes: (data.notes as string | null) ?? null,
      isActive: input.isActive ?? true,
    })
    .returning();
  if (!customer) throw new AppError("INTERNAL_ERROR", "Customer gagal dibuat.");
  await writeAudit(ctx, "CUSTOMER_CREATED", customer.id, { change: "created" });
  return customer;
}

/** Partial update: only keys present in `input` are written; audit lists the
 * changed FIELD NAMES (values stay out — PII rule). */
export async function updateCustomer(
  customerId: string,
  input: CustomerFormInput,
  ctx: CustomerServiceContext,
): Promise<CustomerRow> {
  assertCan("customer.update", ctx.scope);
  const customer = await getCustomerForScope(customerId, ctx);

  const normalized = emptyToNulls(input, CUSTOMER_TEXT_NULL_KEYS);
  const changed: string[] = [];
  for (const key of Object.keys(normalized) as Array<keyof CustomerFormInput>) {
    const next = normalized[key];
    if (next === undefined) continue;
    const current = (customer as unknown as Record<string, unknown>)[key];
    if (String(current ?? "") !== String(next ?? "")) changed.push(key);
  }

  if (changed.length === 0) return customer;

  const data: Partial<CustomerInsert> = {};
  for (const key of changed) {
    const value = normalized[key];
    if (value === undefined) continue;
    // Every changed key maps to a same-named scalar column of Customer
    // (CompanyName, TaxId, …) — explicit by construction, no casts.
    if (key === "isActive") {
      data.isActive = Boolean(value);
    } else if (key === "companyName") {
      data.companyName = String(value);
    } else if (isCustomerTextKey(key)) {
      (data as Record<string, unknown>)[key] = value as string | null;
    }
  }

  const [updated] = await db
    .update(customers)
    .set(data)
    .where(eq(customers.id, customer.id))
    .returning();
  if (!updated) throw new AppError("INTERNAL_ERROR", "Customer gagal diperbarui.");
  await writeAudit(ctx, "CUSTOMER_UPDATED", customer.id, {
    change: "updated",
    fields: changed,
  });
  return updated;
}

function isCustomerTextKey(key: string): key is (typeof CUSTOMER_TEXT_NULL_KEYS)[number] {
  return (CUSTOMER_TEXT_NULL_KEYS as readonly string[]).includes(key);
}

/**
 * Soft delete (data-model rule: only Customer has deletedAt). The row and its
 * contacts stay in the database for the audit trail; every read path filters
 * them out. Never a hard delete.
 */
export async function softDeleteCustomer(
  customerId: string,
  ctx: CustomerServiceContext,
): Promise<CustomerRow> {
  assertCan("customer.delete", ctx.scope);
  const customer = await getCustomerForScope(customerId, ctx);
  const [updated] = await db
    .update(customers)
    .set({ deletedAt: new Date() })
    .where(eq(customers.id, customer.id))
    .returning();
  if (!updated) throw new AppError("INTERNAL_ERROR", "Customer gagal dihapus.");
  await writeAudit(ctx, "CUSTOMER_DELETED", customer.id, { change: "deleted" });
  return updated;
}

// ─── PIC (CustomerContact) writes ──────────────────────────────────────────

/** Exactly one primary PIC per customer: demoting happens in the same
 * transaction as the write that promotes a new one. */
async function exclusivePrimary(customerId: string): Promise<void> {
  await db
    .update(customerContacts)
    .set({ isPrimary: false })
    .where(and(eq(customerContacts.customerId, customerId), eq(customerContacts.isPrimary, true)));
}

export async function addContact(
  customerId: string,
  input: ContactFormInput,
  ctx: CustomerServiceContext,
): Promise<ContactRow> {
  assertCan("customer.update", ctx.scope);
  const customer = await getCustomerForScope(customerId, ctx);

  let contact: ContactRow | undefined;
  await db.transaction(async (tx) => {
    if (input.isPrimary) {
      await tx
        .update(customerContacts)
        .set({ isPrimary: false })
        .where(
          and(
            eq(customerContacts.customerId, customer.id),
            eq(customerContacts.isPrimary, true),
          ),
        );
    }
    const created = await tx
      .insert(customerContacts)
      .values({
        customerId: customer.id,
        name: input.name,
        title: nullIfEmpty(input.title),
        division: nullIfEmpty(input.division),
        email: nullIfEmpty(input.email),
        phone: nullIfEmpty(input.phone),
        whatsapp: nullIfEmpty(input.whatsapp),
        isPrimary: input.isPrimary ?? false,
      })
      .returning();
    contact = created[0];
  });
  if (!contact) throw new AppError("INTERNAL_ERROR", "Kontak gagal dibuat.");

  await writeAudit(ctx, "CUSTOMER_UPDATED", customer.id, {
    change: "contact_created",
    contactId: contact.id,
  });
  return contact;
}

export async function updateContact(
  contactId: string,
  input: ContactFormInput,
  ctx: CustomerServiceContext,
): Promise<ContactRow> {
  assertCan("customer.update", ctx.scope);
  const existingRows = await db
    .select({
      contact: customerContacts,
      orgId: customers.organizationId,
      customerDeletedAt: customers.deletedAt,
    })
    .from(customerContacts)
    .innerJoin(customers, eq(customers.id, customerContacts.customerId))
    .where(eq(customerContacts.id, contactId))
    .limit(1);
  const existing = existingRows[0];
  if (
    !existing ||
    existing.orgId !== ctx.scope.organizationId ||
    existing.customerDeletedAt
  ) {
    throw new AppError("NOT_FOUND", "Kontak tidak ditemukan.");
  }

  let contact: ContactRow | undefined;
  await db.transaction(async (tx) => {
    if (input.isPrimary) {
      await tx
        .update(customerContacts)
        .set({ isPrimary: false })
        .where(
          and(
            eq(customerContacts.customerId, existing.contact.customerId),
            eq(customerContacts.isPrimary, true),
          ),
        );
    }
    const updated = await tx
      .update(customerContacts)
      .set({
        name: input.name,
        title: nullIfEmpty(input.title),
        division: nullIfEmpty(input.division),
        email: nullIfEmpty(input.email),
        phone: nullIfEmpty(input.phone),
        whatsapp: nullIfEmpty(input.whatsapp),
        isPrimary: input.isPrimary ?? false,
      })
      .where(eq(customerContacts.id, existing.contact.id))
      .returning();
    contact = updated[0];
  });
  if (!contact) throw new AppError("INTERNAL_ERROR", "Kontak gagal diperbarui.");

  await writeAudit(ctx, "CUSTOMER_UPDATED", existing.contact.customerId, {
    change: "contact_updated",
    contactId: contact.id,
  });
  return contact;
}

/** PIC removal is a hard delete of the contact row (contacts are not
 * soft-deleted — data-model reserves deletedAt for Customer). The customer
 * itself is untouched. */
export async function deleteContact(
  contactId: string,
  ctx: CustomerServiceContext,
): Promise<void> {
  assertCan("customer.delete", ctx.scope);
  const existingRows = await db
    .select({
      contact: customerContacts,
      orgId: customers.organizationId,
      customerDeletedAt: customers.deletedAt,
    })
    .from(customerContacts)
    .innerJoin(customers, eq(customers.id, customerContacts.customerId))
    .where(eq(customerContacts.id, contactId))
    .limit(1);
  const existing = existingRows[0];
  if (
    !existing ||
    existing.orgId !== ctx.scope.organizationId ||
    existing.customerDeletedAt
  ) {
    throw new AppError("NOT_FOUND", "Kontak tidak ditemukan.");
  }
  await db.delete(customerContacts).where(eq(customerContacts.id, existing.contact.id));
  await writeAudit(ctx, "CUSTOMER_UPDATED", existing.contact.customerId, {
    change: "contact_deleted",
    contactId: existing.contact.id,
  });
}

/** Keep the exported helper for tests that referenced the Prisma-era name. */
export const __countCustomerContacts = (customerId: string) =>
  db
    .select({ value: count() })
    .from(customerContacts)
    .where(eq(customerContacts.customerId, customerId));

/** Unused import guards — kept so the module compiles identically everywhere. */
export const __customersSql = sql;
export const __customersDesc = desc;
