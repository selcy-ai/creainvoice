// src/modules/customers/actions.ts
// Server actions for /customers: customer CRUD (soft delete) and PIC CRUD.
// Every action re-validates its payload at the boundary (the client is never
// trusted) and the service layer authorizes with assertCan, so a crafted
// request can never turn a VIEWER into a writer (403), and every id from
// another organization answers 404 (IDOR guard in getCustomerForScope).

"use server";

import { actionRequest, toActionError, zodFailure } from "@/lib/action";
import { apiFailure, apiOk, type ActionResult } from "@/lib/api-response";
import { requireSession } from "@/lib/clerk";
import { requireWorkspaceScope } from "@/modules/workspace/service";
import {
  contactFormSchema,
  customerFormSchema,
  type ContactFormValues,
  type CustomerFormValues,
} from "@/modules/customers/schema";
import {
  addContact,
  createCustomer,
  deleteContact,
  listCustomers,
  softDeleteCustomer,
  toContactView,
  updateContact,
  updateCustomer,
  type ContactView,
} from "@/modules/customers/service";

async function serviceContext() {
  const session = await requireSession();
  const scope = await requireWorkspaceScope(session);
  return { scope, request: await actionRequest() };
}

// ─── Customer ─────────────────────────────────────────────────────────────

export async function createCustomerAction(
  values: CustomerFormValues,
): Promise<ActionResult<{ customerId: string }>> {
  try {
    const ctx = await serviceContext();
    const parsed = customerFormSchema.safeParse(values);
    if (!parsed.success) return zodFailure(parsed.error);

    const customer = await createCustomer(parsed.data, ctx);
    return apiOk({ customerId: customer.id });
  } catch (error) {
    return toActionError("customers.actions", error);
  }
}

export async function updateCustomerAction(
  values: CustomerFormValues & { customerId: string },
): Promise<ActionResult<{ customerId: string }>> {
  try {
    const ctx = await serviceContext();
    if (!values.customerId) return apiFailure("VALIDATION_ERROR", "Customer tidak valid.");

    const parsed = customerFormSchema.safeParse(values);
    if (!parsed.success) return zodFailure(parsed.error);

    const customer = await updateCustomer(values.customerId, parsed.data, ctx);
    return apiOk({ customerId: customer.id });
  } catch (error) {
    return toActionError("customers.actions", error);
  }
}

/** Soft delete — the row and its PICs survive for the audit trail. */
export async function deleteCustomerAction(values: {
  customerId: string;
}): Promise<ActionResult<{ customerId: string }>> {
  try {
    const ctx = await serviceContext();
    if (!values.customerId) return apiFailure("VALIDATION_ERROR", "Customer tidak valid.");

    const customer = await softDeleteCustomer(values.customerId, ctx);
    return apiOk({ customerId: customer.id });
  } catch (error) {
    return toActionError("customers.actions", error);
  }
}

// ─── PIC (CustomerContact) ────────────────────────────────────────────────

export async function addContactAction(
  values: ContactFormValues & { customerId: string },
): Promise<ActionResult<{ contact: ContactView }>> {
  try {
    const ctx = await serviceContext();
    if (!values.customerId) return apiFailure("VALIDATION_ERROR", "Customer tidak valid.");

    const parsed = contactFormSchema.safeParse(values);
    if (!parsed.success) return zodFailure(parsed.error);

    const contact = await addContact(values.customerId, parsed.data, ctx);
    return apiOk({ contact: toContactView(contact) });
  } catch (error) {
    return toActionError("customers.actions", error);
  }
}

export async function updateContactAction(
  values: ContactFormValues & { contactId: string },
): Promise<ActionResult<{ contact: ContactView }>> {
  try {
    const ctx = await serviceContext();
    if (!values.contactId) return apiFailure("VALIDATION_ERROR", "Kontak tidak valid.");

    const parsed = contactFormSchema.safeParse(values);
    if (!parsed.success) return zodFailure(parsed.error);

    const contact = await updateContact(values.contactId, parsed.data, ctx);
    return apiOk({ contact: toContactView(contact) });
  } catch (error) {
    return toActionError("customers.actions", error);
  }
}

export async function deleteContactAction(values: {
  contactId: string;
}): Promise<ActionResult> {
  try {
    const ctx = await serviceContext();
    if (!values.contactId) return apiFailure("VALIDATION_ERROR", "Kontak tidak valid.");

    await deleteContact(values.contactId, ctx);
    return apiOk({});
  } catch (error) {
    return toActionError("customers.actions", error);
  }
}

// ─── Read: customer options for the project form's picker ────────────────

/**
 * Name-only lookup backing the project form's customer picker (server-side
 * search, org-scoped like every list — no full-table client read).
 */
export async function searchCustomersAction(values: {
  q: string;
}): Promise<ActionResult<{ options: Array<{ id: string; companyName: string }> }>> {
  try {
    const ctx = await serviceContext();
    const result = await listCustomers(ctx, { q: values.q, page: 1, pageSize: 10 });
    return apiOk({
      options: result.rows.map((row) => ({ id: row.id, companyName: row.companyName })),
    });
  } catch (error) {
    return toActionError("customers.actions", error);
  }
}
