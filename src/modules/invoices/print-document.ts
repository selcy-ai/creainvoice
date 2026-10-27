// src/modules/invoices/print-document.ts
// Read model of the PRINT route (feature 06): everything needed to rebuild
// the document of an ISSUED invoice from the seven frozen snapshots — never
// from live profile/customer/bank rows (architecture invariant 4 + 9: the
// printed/PDF document is the issued one, and re-rendering after a profile
// edit can never change what a stored official PDF shows).
//
// Row-level fields are read from the invoice row itself, which the lifecycle
// guard already makes immutable after issue (updateDraft rejects anything but
// DRAFT with LOCKED). Term/custom labels, notes, footer text, reference and
// dates live there; parties, amounts and template context live in snapshots.

import { AppError } from "@/lib/errors";
import { db } from "@/server/db";
import { invoiceProfiles, invoices, projectReferences } from "@/db/schema";
import { eq } from "drizzle-orm";
import { toCalendarInput } from "@/lib/date";
import {
  parseSnapshot,
  type BankSnapshot,
  type CalculationSnapshot,
  type ContactSnapshot,
  type CustomerSnapshot,
  type IssuerSnapshot,
  type SignerSnapshot,
  type TemplateSnapshot,
} from "@/modules/invoices/snapshots";
import type { InvoiceType } from "@/db/enums";
// Change 6: dropped Prisma (role tiers removed)

/**
 * Everything the print route needs to rebuild the DOCUMENT of an issued
 * invoice — the frozen snapshots + the status-locked row fields. All dates
 * are calendar strings ("2026-07-01"), never Date objects, so the mapper
 * into renderer data stays deterministic (same input shape as the draft
 * mapper, which is what keeps preview === print).
 */
export interface IssuedPrintSource {
  number: string;
  invoiceType: InvoiceType;
  invoiceDate: string;
  dueDate: string | null;
  referenceType: string | null;
  referenceNumber: string | null;
  referenceDate: string | null;
  paymentTerms: string | null;
  currency: string;
  billingMode: "PERCENT" | "MANUAL";
  billingPercent: string | null;
  termName: string | null;
  termNumber: number | null;
  customLabel: string | null;
  notes: string | null;
  footerText: string | null;
  projectTitle: string | null;
  issuer: IssuerSnapshot;
  customer: CustomerSnapshot | null;
  contact: ContactSnapshot | null;
  bank: BankSnapshot | null;
  signer: SignerSnapshot | null;
  calculation: CalculationSnapshot;
  template: TemplateSnapshot;
  /** Raw InvoiceProfile.settings JSON — parsed by parseProfileSettings. */
  settings: Record<string, unknown> | null;
}

export interface PrintDocument extends IssuedPrintSource {
  invoiceId: string;
  organizationId: string;
  /** PDF metadata Title — the final invoice number. */
  title: string;
  /** PDF metadata Author — the issuer profile name frozen at issue. */
  author: string;
}

/**
 * Loads the printable document of one issued invoice. NOT_FOUND for a
 * draft/unknown id — the print route only ever renders finished documents.
 */
export async function getPrintDocument(invoiceId: string): Promise<PrintDocument> {
  const rows = await db
    .select({
      invoice: invoices,
      projectTitle: projectReferences.title,
      profileSettings: invoiceProfiles.settings,
    })
    .from(invoices)
    .leftJoin(
      projectReferences,
      eq(projectReferences.id, invoices.projectReferenceId),
    )
    .leftJoin(invoiceProfiles, eq(invoiceProfiles.id, invoices.profileId))
    .where(eq(invoices.id, invoiceId))
    .limit(1);
  const first = rows[0];
  const invoice = first
    ? {
        ...first.invoice,
        projectReference: first.projectTitle === null ? null : { title: first.projectTitle },
        profile: first.invoice ? { settings: first.profileSettings } : null,
      }
    : null;

  if (!invoice || !invoice.number || invoice.status === "DRAFT") {
    // Same answer for "does not exist" and "not printable" — never leak why.
    throw new AppError("NOT_FOUND", "Invoice tidak ditemukan.");
  }

  const issuer = parseSnapshot<IssuerSnapshot>(invoice.issuerSnapshot);
  const customer = parseSnapshot<CustomerSnapshot>(invoice.customerSnapshot);
  const contact = parseSnapshot<ContactSnapshot>(invoice.contactSnapshot);
  const bank = parseSnapshot<BankSnapshot>(invoice.bankSnapshot);
  const signer = parseSnapshot<SignerSnapshot>(invoice.signerSnapshot);
  const calculation = parseSnapshot<CalculationSnapshot>(invoice.calculationSnapshot);
  const template = parseSnapshot<TemplateSnapshot>(invoice.templateSnapshot);

  if (!issuer || !calculation || !template) {
    // An issued row without snapshots should be impossible (written in the
    // issue transaction) — fail closed instead of rendering live data.
    throw new AppError("NOT_FOUND", "Invoice tidak ditemukan.");
  }

  return {
    invoiceId: invoice.id,
    organizationId: invoice.organizationId,
    number: invoice.number,
    invoiceType: calculation.invoiceType,
    invoiceDate: toCalendarInput(invoice.invoiceDate.toISOString()),
    dueDate: invoice.dueDate ? toCalendarInput(invoice.dueDate.toISOString()) : null,
    referenceType: invoice.referenceType,
    referenceNumber: invoice.referenceNumber,
    referenceDate: invoice.referenceDate
      ? toCalendarInput(invoice.referenceDate.toISOString())
      : null,
    paymentTerms: invoice.paymentTerms,
    currency: invoice.currency,
    billingMode: calculation.billingMode,
    billingPercent: calculation.billingPercent,
    termName: invoice.termName,
    termNumber: invoice.termNumber,
    customLabel: invoice.customLabel,
    notes: invoice.notes,
    footerText: invoice.footerText,
    projectTitle: invoice.projectReference?.title ?? null,
    issuer,
    customer,
    contact,
    bank,
    signer,
    calculation,
    template,
    settings: (invoice.profile?.settings ?? null) as Record<string, unknown> | null,
    title: invoice.number,
    author: issuer.name,
  };
}
