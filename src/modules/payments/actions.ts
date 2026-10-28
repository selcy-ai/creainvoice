// src/modules/payments/actions.ts
// Server actions for payments (feature 07): record (FormData — it carries an
// optional proof File) and delete/reversal (plain object). Input is
// re-validated at the boundary, authorization runs in the service (assertCan —
// VIEWER gets 403, a foreign id answers 404), and money is re-derived from
// the payment rows server-side.

"use server";

import {
  actionRequest,
  formDataString,
  toActionError,
  zodFailure,
} from "@/lib/action";
import { apiFailure, apiOk, type ActionResult } from "@/lib/api-response";
import { requireSession } from "@/lib/auth";
import { requireWorkspaceScope } from "@/modules/workspace/service";
import { recordPaymentSchema } from "@/modules/payments/schema";
import {
  deletePayment,
  recordPayment,
  type PaymentOutcome,
} from "@/modules/payments/service";

async function serviceContext() {
  const session = await requireSession();
  const scope = await requireWorkspaceScope(session);
  return { scope, request: await actionRequest() };
}

/**
 * Record a payment: date, amount, method, optional reference/notes and an
 * optional proof upload. Size (2 MB) and MIME are decided SERVER-side by
 * content sniffing (StorageService → validateUpload) — the filename and the
 * declared type are never trusted.
 */
export async function recordPaymentAction(
  form: FormData,
): Promise<ActionResult<PaymentOutcome>> {
  try {
    const ctx = await serviceContext();
    const raw: Record<string, unknown> = {
      invoiceId: formDataString(form, "invoiceId"),
      paymentDate: formDataString(form, "paymentDate"),
      amount: formDataString(form, "amount"),
      method: formDataString(form, "method"),
      referenceNumber: formDataString(form, "referenceNumber") || undefined,
      notes: formDataString(form, "notes") || undefined,
      confirmOverpayment: formDataString(form, "confirmOverpayment") === "true",
      overpaymentReason: formDataString(form, "overpaymentReason") || undefined,
    };
    const parsed = recordPaymentSchema.safeParse(raw);
    if (!parsed.success) return zodFailure(parsed.error);

    const proof = form.get("proof");
    const file = proof instanceof File && proof.size > 0 ? proof : null;

    const outcome = await recordPayment(parsed.data.invoiceId, parsed.data, ctx, {
      proof: file,
    });
    return apiOk(outcome);
  } catch (error) {
    return toActionError("payments.actions", error);
  }
}

/** Reversal (OWNER/ADMIN): removes the payment, recomputes the invoice's
 * payment columns and writes the PAYMENT_RECORDED audit with
 * `metadata.reversed = true`. */
export async function deletePaymentAction(
  values: { paymentId: string },
): Promise<ActionResult<PaymentOutcome>> {
  try {
    const ctx = await serviceContext();
    if (!values.paymentId) {
      return apiFailure("VALIDATION_ERROR", "Pembayaran tidak valid.");
    }

    const outcome = await deletePayment(values.paymentId, ctx);
    return apiOk(outcome);
  } catch (error) {
    return toActionError("payments.actions", error);
  }
}
