// src/modules/invoices/detail-service.ts
// The read model for /invoices/[id] (feature 05). One view serves both worlds:
//
//   • DRAFT   → live relations (the editor owns the row until it is issued).
//   • ISSUED+ → the seven SNAPSHOTS (invariant 4): profile/customer/bank/
//               signer/calculation/template edits after issue can never change
//               what this page shows. Item rows are read live only because the
//               status guard makes them immutable too (updateDraft rejects
//               anything but DRAFT with LOCKED).
//
// The view also carries the ON-READ overdue status (recomputeOverdue), the
// honest PdfJob status (never a fake download link) and the permission flags
// the action buttons need — computed centrally with can(), never with inline
// role strings.

import { AppError } from "@/lib/errors";
import { logger } from "@/server/logger";
import { db } from "@/server/db";
import {
  bankAccounts,
  customerContacts,
  customers,
  invoiceItems,
  invoiceProfiles,
  invoices,
  projectReferences,
  signers,
  users,
} from "@/db/schema";
import { and, asc, eq } from "drizzle-orm";
import { toCalendarInput } from "@/lib/date";
import { assertCan, can, requireOrgScope } from "@/modules/workspace/permissions";
import { calcFromRows, type InvoiceServiceContext, type InvoiceWithRelations } from "@/modules/invoices/service";
import {
  CANCELABLE_STATUSES,
  REVISABLE_STATUSES,
  recomputeOverdue,
} from "@/modules/invoices/lifecycle-service";
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
import { getOfficialPdf, getPdfJob, type OfficialPdfView, type PdfJobView } from "@/modules/pdf/service";
import { toBankAccountView } from "@/modules/bank-accounts/service";
import { resolveNotesTokens } from "@/lib/tokens";
import type { InvoiceCalcResult } from "@/modules/invoices/calculation";
import type { BillingMode, InvoiceStatus, InvoiceType, ReferenceType, StampMode, TaxMode } from "@/db/enums";

export interface InvoiceDetailItem {
  id: string;
  position: number;
  description: string;
  details: string | null;
  quantity: string;
  unit: string;
  unitPrice: string;
  discountAmount: string;
  lineAmount: string;
}

export interface InvoiceDetailParty {
  name: string;
  legalName?: string | null;
  code?: string | null;
  logoPath?: string | null;
  primaryColor?: string | null;
  address?: string | null;
  city?: string | null;
  province?: string | null;
  postalCode?: string | null;
  country?: string | null;
  phone?: string | null;
  whatsapp?: string | null;
  fax?: string | null;
  email?: string | null;
  website?: string | null;
  taxId?: string | null;
}

export interface InvoiceDetailAmounts {
  workValue: string;
  itemsSubtotal: string;
  previouslyBilled: string;
  billingBase: string;
  discountAmount: string;
  additionalAmount: string;
  taxMode: TaxMode;
  taxPercent: string | null;
  taxAmount: string;
  roundingAmount: string;
  grandTotal: string;
  /** = grandTotal at issue; feature 07 decrements it with payments. */
  remainingAfter: string;
  amountPaid: string;
}

export interface InvoiceDetailLink {
  id: string;
  number: string | null;
  numberPreview: string | null;
  status: InvoiceStatus;
}

export interface InvoiceDetailPermissions {
  edit: boolean;
  issue: boolean;
  markSent: boolean;
  cancel: boolean;
  revise: boolean;
}

export interface InvoiceDetailView {
  id: string;
  /** Stored status. */
  status: InvoiceStatus;
  /** Status to DISPLAY — OVERDUE is computed on read (feature 05 spec). */
  displayStatus: InvoiceStatus;
  isDraft: boolean;
  invoiceType: InvoiceType;
  number: string | null;
  numberPreview: string | null;
  currency: string;
  invoiceDate: string;
  dueDate: string | null;
  referenceType: ReferenceType | null;
  referenceNumber: string | null;
  referenceDate: string | null;
  paymentTerms: string | null;

  /** True when every party/amount below came from the frozen snapshots. */
  fromSnapshot: boolean;
  issuer: InvoiceDetailParty;
  customer: InvoiceDetailParty | null;
  contact: { name: string; title: string | null; division: string | null } | null;
  project: { id: string; title: string; referenceNumber: string } | null;
  bank: {
    bankName: string;
    accountHolder: string;
    maskedNumber: string;
    branch: string | null;
  } | null;
  signer: { name: string; title: string | null; location: string | null } | null;

  items: InvoiceDetailItem[];
  amounts: InvoiceDetailAmounts;
  calc: InvoiceCalcResult;
  billing: {
    billingMode: BillingMode;
    billingPercent: string | null;
    billingAmount: string | null;
    termName: string | null;
    termNumber: number | null;
    customLabel: string | null;
  };
  stampMode: StampMode;
  /** Stored notes, placeholders untouched (storage truth). */
  notes: string | null;
  /** Feature 10: notes with tokens resolved — what the card renders. */
  notesDisplay: string | null;
  /** Unknown placeholders left literal in `notesDisplay` — the UI warns. */
  notesUnknownTokens: string[];
  footerText: string | null;
  template: TemplateSnapshot | null;

  issuedAt: string | null;
  issuedByName: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  revisedFrom: InvoiceDetailLink | null;
  replacedBy: InvoiceDetailLink | null;

  pdfJob: PdfJobView | null;
  /** Stored official PDF (feature 06) — null until the worker writes one. */
  pdf: OfficialPdfView | null;
  permissions: InvoiceDetailPermissions;
  createdAt: string;
  updatedAt: string;
}

/** One invoice with every relation the detail page renders (Drizzle LEFT
 *  JOINs — a draft may legitimately have no bank/signer/PIC, so they stay
 *  nullable and the view code treats them so). */
interface DetailRow extends InvoiceWithRelations {
  bankAccount: typeof bankAccounts.$inferSelect | null;
  signer: typeof signers.$inferSelect | null;
  issuedBy: { id: string; name: string | null; username: string | null } | null;
  revisedFrom: {
    id: string;
    number: string | null;
    numberPreview: string | null;
    status: InvoiceStatus;
  } | null;
  replacedBy: {
    id: string;
    number: string | null;
    numberPreview: string | null;
    status: InvoiceStatus;
  } | null;
}

function toLink(
  row: { id: string; number: string | null; numberPreview: string | null; status: InvoiceStatus } | null,
): InvoiceDetailLink | null {
  if (!row) return null;
  return { id: row.id, number: row.number, numberPreview: row.numberPreview, status: row.status };
}

export async function getInvoiceDetail(
  invoiceId: string,
  ctx: InvoiceServiceContext,
): Promise<InvoiceDetailView> {
  assertCan("invoice.view", ctx.scope);
  requireOrgScope(ctx.scope);

  const joined = await db
    .select({
      invoice: invoices,
      profile: invoiceProfiles,
      customer: customers,
      customerContact: customerContacts,
      project: projectReferences,
      bankAccount: bankAccounts,
      signer: signers,
      issuedBy: users,
    })
    .from(invoices)
    .leftJoin(invoiceProfiles, eq(invoiceProfiles.id, invoices.profileId))
    .leftJoin(customers, eq(customers.id, invoices.customerId))
    .leftJoin(customerContacts, eq(customerContacts.id, invoices.customerContactId))
    .leftJoin(projectReferences, eq(projectReferences.id, invoices.projectReferenceId))
    .leftJoin(bankAccounts, eq(bankAccounts.id, invoices.bankAccountId))
    .leftJoin(signers, eq(signers.id, invoices.signerId))
    .leftJoin(users, eq(users.id, invoices.issuedById))
    .where(eq(invoices.id, invoiceId))
    .limit(1);
  const first = joined[0];
  if (!first) {
    throw new AppError("NOT_FOUND", "Invoice tidak ditemukan.");
  }
  const root = first.invoice;
  // Self-references are fetched separately — a self-join confuses both ORMs
  // and adds nothing for a single-row read.
  const [revisedFromRows, replacedByRows, itemRows] = await Promise.all([
    root.revisedFromId
      ? db
          .select({
            id: invoices.id,
            number: invoices.number,
            numberPreview: invoices.numberPreview,
            status: invoices.status,
          })
          .from(invoices)
          .where(eq(invoices.id, root.revisedFromId))
          .limit(1)
      : [],
    root.replacedById
      ? db
          .select({
            id: invoices.id,
            number: invoices.number,
            numberPreview: invoices.numberPreview,
            status: invoices.status,
          })
          .from(invoices)
          .where(eq(invoices.id, root.replacedById))
          .limit(1)
      : [],
    db
      .select()
      .from(invoiceItems)
      .where(eq(invoiceItems.invoiceId, invoiceId))
      .orderBy(asc(invoiceItems.position)),
  ]);
  const invoice: DetailRow = {
    ...root,
    profile: first.profile,
    customer: first.customer,
    customerContact: first.customerContact
      ? {
          id: first.customerContact.id,
          name: first.customerContact.name,
          title: first.customerContact.title,
          division: first.customerContact.division,
        }
      : null,
    projectReference: first.project
      ? {
          id: first.project.id,
          title: first.project.title,
          referenceNumber: first.project.referenceNumber,
        }
      : null,
    bankAccount: first.bankAccount,
    signer: first.signer,
    items: itemRows,
    issuedBy: first.issuedBy
      ? {
          id: first.issuedBy.id,
          name: first.issuedBy.name,
          username: first.issuedBy.username,
        }
      : null,
    revisedFrom: revisedFromRows[0] ?? null,
    replacedBy: replacedByRows[0] ?? null,
  };
  if (invoice.organizationId !== ctx.scope.organizationId) {
    // IDOR guard: a foreign invoice id answers 404.
    throw new AppError("NOT_FOUND", "Invoice tidak ditemukan.");
  }

  const isDraft = invoice.status === "DRAFT";
  if (!invoice.profile) {
    throw new AppError("NOT_FOUND", "Profil invoice tidak ditemukan.");
  }
  const liveIssuer: InvoiceDetailParty = {
    name: invoice.profile.name,
    legalName: invoice.profile.legalName,
    code: invoice.profile.code,
    logoPath: invoice.profile.logoPath,
    primaryColor: invoice.profile.primaryColor,
    address: invoice.profile.address,
    phone: invoice.profile.phone,
    whatsapp: invoice.profile.whatsapp,
    fax: invoice.profile.fax,
    email: invoice.profile.email,
    website: invoice.profile.website,
    taxId: invoice.profile.taxId,
  };
  const liveCustomer: InvoiceDetailParty | null = invoice.customer
    ? {
        name: invoice.customer.companyName,
        legalName: invoice.customer.legalName,
        address: invoice.customer.address,
        city: invoice.customer.city,
        province: invoice.customer.province,
        postalCode: invoice.customer.postalCode,
        country: invoice.customer.country,
        phone: invoice.customer.phone,
        email: invoice.customer.email,
        taxId: invoice.customer.taxId,
      }
    : null;

  // ── Snapshot first (issued), live relations for drafts ──────────────────
  const issuerSnap = isDraft ? null : parseSnapshot<IssuerSnapshot>(invoice.issuerSnapshot);
  const customerSnap = isDraft ? null : parseSnapshot<CustomerSnapshot>(invoice.customerSnapshot);
  const contactSnap = isDraft ? null : parseSnapshot<ContactSnapshot>(invoice.contactSnapshot);
  const bankSnap = isDraft ? null : parseSnapshot<BankSnapshot>(invoice.bankSnapshot);
  const signerSnap = isDraft ? null : parseSnapshot<SignerSnapshot>(invoice.signerSnapshot);
  const calcSnap = isDraft ? null : parseSnapshot<CalculationSnapshot>(invoice.calculationSnapshot);
  const templateSnap = isDraft ? null : parseSnapshot<TemplateSnapshot>(invoice.templateSnapshot);

  const fromSnapshot = Boolean(issuerSnap && customerSnap && calcSnap);
  if (!isDraft && !fromSnapshot) {
    // An issued invoice without snapshots should be impossible (written in the
    // issue transaction) — degrade to live relations and shout in the logs.
    logger.error(
      { module: "invoices", invoiceId },
      "invoice issued tanpa snapshot — menampilkan data live (tidak sesuai invariant 4)",
    );
  }

  const issuer: InvoiceDetailParty = issuerSnap
    ? {
        name: issuerSnap.name,
        legalName: issuerSnap.legalName,
        code: issuerSnap.code,
        logoPath: issuerSnap.logoPath,
        primaryColor: issuerSnap.primaryColor,
        address: issuerSnap.address,
        phone: issuerSnap.phone,
        whatsapp: issuerSnap.whatsapp,
        fax: issuerSnap.fax,
        email: issuerSnap.email,
        website: issuerSnap.website,
        taxId: issuerSnap.taxId,
      }
    : liveIssuer;

  const customer: InvoiceDetailParty | null = customerSnap
    ? {
        name: customerSnap.companyName,
        legalName: customerSnap.legalName,
        address: customerSnap.address,
        city: customerSnap.city,
        province: customerSnap.province,
        postalCode: customerSnap.postalCode,
        country: customerSnap.country,
        phone: customerSnap.phone,
        email: customerSnap.email,
        taxId: customerSnap.taxId,
      }
    : liveCustomer;

  // For an ISSUED row the snapshot decides — including its nulls: a PIC/bank/
  // signer that did NOT exist at issue time must never appear on the document
  // later (that would be a silent post-issue edit). Live relations are only
  // the draft's source.
  const contact = fromSnapshot
    ? contactSnap
      ? { name: contactSnap.name, title: contactSnap.title, division: contactSnap.division }
      : null
    : invoice.customerContact
      ? {
          name: invoice.customerContact.name,
          title: invoice.customerContact.title,
          division: invoice.customerContact.division,
        }
      : null;

  const bank = fromSnapshot
    ? bankSnap
      ? {
          bankName: bankSnap.bankName,
          accountHolder: bankSnap.accountHolder,
          maskedNumber: bankSnap.maskedNumber,
          branch: bankSnap.branch,
        }
      : null
    : invoice.bankAccount
      ? {
          bankName: invoice.bankAccount.bankName,
          accountHolder: invoice.bankAccount.accountHolder,
          // Decrypted only to mask it — the same masked form as everywhere
          // else (feature 02 rule: the plain number never leaves the module).
          maskedNumber: toBankAccountView(invoice.bankAccount).maskedNumber,
          branch: invoice.bankAccount.branch,
        }
      : null;

  const signer = fromSnapshot
    ? signerSnap
      ? { name: signerSnap.name, title: signerSnap.title, location: signerSnap.location }
      : null
    : invoice.signer
      ? {
          name: invoice.signer.name,
          title: invoice.signer.title,
          location: invoice.signer.location,
        }
      : null;

  const items: InvoiceDetailItem[] = invoice.items.map((item) => ({
    id: item.id,
    position: item.position,
    description: item.description,
    details: item.details,
    quantity: item.quantity,
    unit: item.unit,
    unitPrice: item.unitPrice,
    discountAmount: item.discountAmount,
    lineAmount: item.lineAmount,
  }));

  const calc: InvoiceCalcResult = calcSnap ? calcSnap.calc : calcFromRows(invoice);
  const amounts: InvoiceDetailAmounts = calcSnap
    ? {
        workValue: calcSnap.workValue,
        itemsSubtotal: calcSnap.itemsSubtotal,
        previouslyBilled: calcSnap.previouslyBilled,
        billingBase: calcSnap.billingBase,
        discountAmount: calcSnap.discountAmount,
        additionalAmount: calcSnap.additionalAmount,
        taxMode: calcSnap.taxMode,
        taxPercent: calcSnap.taxPercent,
        taxAmount: calcSnap.taxAmount,
        roundingAmount: calcSnap.roundingAmount,
        grandTotal: calcSnap.grandTotal,
        // remainingAfter is the LIVE outstanding amount (feature 07: payments
        // decrement it on the row) — the calculation SNAPSHOT itself stays
        // frozen, only this payment dimension moves.
        remainingAfter: invoice.remainingAfter.toString(),
        amountPaid: invoice.amountPaid.toString(),
      }
    : {
        workValue: invoice.workValue.toString(),
        itemsSubtotal: invoice.itemsSubtotal.toString(),
        previouslyBilled: invoice.previouslyBilled.toString(),
        billingBase: invoice.billingBase.toString(),
        discountAmount: invoice.discountAmount.toString(),
        additionalAmount: invoice.additionalAmount.toString(),
        taxMode: invoice.taxMode,
        taxPercent: invoice.taxPercent?.toString() ?? null,
        taxAmount: invoice.taxAmount.toString(),
        roundingAmount: invoice.roundingAmount.toString(),
        grandTotal: invoice.grandTotal.toString(),
        remainingAfter: invoice.remainingAfter.toString(),
        amountPaid: invoice.amountPaid.toString(),
      };

  const pdfJob = await getPdfJob(invoice.id, ctx);
  const pdf = isDraft ? null : await getOfficialPdf(invoice.id, ctx);

  // Feature 10: the detail card renders the SAME resolved text the document
  // prints — tokens resolve in the service layer from the values this view
  // already carries (snapshot-backed for issued rows).
  const resolvedNotes = resolveNotesTokens(invoice.notes, {
    invoiceNumber: invoice.number ?? invoice.numberPreview,
    referenceNumber: invoice.referenceNumber,
    customerName: customer?.name ?? null,
    workValue: amounts.workValue,
    billingPercent: invoice.billingPercent?.toString() ?? null,
    grandTotal: amounts.grandTotal,
  });

  return {
    id: invoice.id,
    status: invoice.status,
    displayStatus: recomputeOverdue(invoice),
    isDraft,
    invoiceType: invoice.invoiceType,
    number: invoice.number,
    numberPreview: invoice.numberPreview,
    currency: invoice.currency,
    invoiceDate: toCalendarInput(invoice.invoiceDate.toISOString()),
    dueDate: invoice.dueDate ? toCalendarInput(invoice.dueDate.toISOString()) : null,
    referenceType: invoice.referenceType,
    referenceNumber: invoice.referenceNumber,
    referenceDate: invoice.referenceDate
      ? toCalendarInput(invoice.referenceDate.toISOString())
      : null,
    paymentTerms: invoice.paymentTerms,
    fromSnapshot,
    issuer,
    customer,
    contact,
    project: invoice.projectReference,
    bank,
    signer,
    items,
    amounts,
    calc,
    billing: {
      billingMode: invoice.billingMode,
      billingPercent: invoice.billingPercent?.toString() ?? null,
      billingAmount: invoice.billingAmount?.toString() ?? null,
      termName: invoice.termName,
      termNumber: invoice.termNumber,
      customLabel: invoice.customLabel,
    },
    stampMode: invoice.stampMode,
    notes: invoice.notes,
    notesDisplay: resolvedNotes.text,
    notesUnknownTokens: resolvedNotes.unknownTokens,
    footerText: invoice.footerText,
    template: templateSnap,
    issuedAt: invoice.issuedAt?.toISOString() ?? null,
    issuedByName: invoice.issuedBy
      ? invoice.issuedBy.name ?? invoice.issuedBy.username ?? invoice.issuedBy.id
      : null,
    cancelledAt: invoice.cancelledAt?.toISOString() ?? null,
    cancellationReason: invoice.cancellationReason,
    revisedFrom: toLink(invoice.revisedFrom),
    replacedBy: toLink(invoice.replacedBy),
    pdfJob,
    pdf,
    permissions: {
      edit: can("invoice.draft.update", ctx.scope) && isDraft,
      issue: can("invoice.issue", ctx.scope) && isDraft,
      markSent: can("invoice.markSent", ctx.scope) && invoice.status === "ISSUED",
      // Buttons only exist where the SERVICE would accept the action — a
      // button that always answers LOCKED is a fake button (non-negotiables).
      cancel:
        can("invoice.cancel", ctx.scope) && CANCELABLE_STATUSES.includes(invoice.status),
      revise: can("invoice.revise", ctx.scope) && REVISABLE_STATUSES.includes(invoice.status),
    },
    createdAt: invoice.createdAt.toISOString(),
    updatedAt: invoice.updatedAt.toISOString(),
  };
}
