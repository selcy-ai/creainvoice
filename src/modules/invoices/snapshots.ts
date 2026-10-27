// src/modules/invoices/snapshots.ts
// The seven immutable JSON snapshots captured at issue time (architecture
// invariant 4): issuer, customer, contact, bank, signer, calculation, template.
// Pure types + readers — no db, no React — so issue-service builds them and
// detail-service reads them without either side redefining the shape.
//
// Why they matter: after ISSUED, every read of the invoice document goes
// through these values, so editing the profile/customer/bank afterwards can
// never change a document that has already been issued (feature 05 check:
// "snapshot immutability").

import type { BillingMode, InvoiceType, StampMode, TaxMode } from "@/db/enums";
// Change 6: dropped Prisma (role tiers removed)
import type { InvoiceCalcResult } from "@/modules/invoices/calculation";

/** Who issued the document (invoice profile state at issue time). */
export interface IssuerSnapshot {
  profileId: string;
  name: string;
  legalName: string | null;
  code: string;
  logoPath: string | null;
  primaryColor: string;
  address: string | null;
  phone: string | null;
  whatsapp: string | null;
  fax: string | null;
  email: string | null;
  website: string | null;
  taxId: string | null;
  numberPattern: string;
  templateKey: string;
}

export interface CustomerSnapshot {
  customerId: string;
  companyName: string;
  legalName: string | null;
  businessType: string | null;
  // PII lives inside the invoice document by definition (the document itself
  // is addressed to this customer) — never copied into logs or audit metadata.
  taxId: string | null;
  address: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  country: string | null;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
}

export interface ContactSnapshot {
  contactId: string;
  name: string;
  title: string | null;
  division: string | null;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
}

export interface BankSnapshot {
  bankAccountId: string;
  bankName: string;
  bankCode: string | null;
  accountHolder: string;
  branch: string | null;
  currency: string;
  /** "**** **** 3449" — summary cards and rows issued before feature 10. */
  maskedNumber: string;
  /**
   * FULL account number, frozen at issue (spec 10: "nomor lengkap hanya di
   * invoice (snapshot)"). The issued document is the one artifact allowed to
   * carry the real number — rows issued before feature 10 lack this field and
   * the renderer falls back to `maskedNumber`.
   */
  accountNumber?: string;
  last4: string;
}

export interface SignerSnapshot {
  signerId: string;
  name: string;
  title: string | null;
  location: string | null;
  signaturePath: string | null;
}

export interface CalculationSnapshotItem {
  position: number;
  description: string;
  details: string | null;
  quantity: string;
  unit: string;
  unitPrice: string;
  discountAmount: string;
  lineAmount: string;
}

/** Everything numeric about the document, frozen at issue. */
export interface CalculationSnapshot {
  invoiceType: InvoiceType;
  billingMode: BillingMode;
  billingPercent: string | null;
  billingAmount: string | null;
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
  /** = grandTotal at issue (feature 05 spec); feature 07 decrements it. */
  remainingAfter: string;
  /** Full calculation-engine output — the document renders THESE numbers. */
  calc: InvoiceCalcResult;
  items: CalculationSnapshotItem[];
}

/** Rendering context frozen at issue (invariant 9: PDF never re-renders
 * from the live profile). */
export interface TemplateSnapshot {
  templateKey: string;
  primaryColor: string;
  stampMode: StampMode;
  numberPattern: string;
}

export interface InvoiceSnapshots {
  issuer: IssuerSnapshot;
  customer: CustomerSnapshot;
  contact: ContactSnapshot | null;
  bank: BankSnapshot | null;
  signer: SignerSnapshot | null;
  calculation: CalculationSnapshot;
  template: TemplateSnapshot;
}

/**
 * Json column → typed snapshot. A wrong-shaped value (null, array, scalar)
 * answers null instead of pretending to be a snapshot — callers then fall back
 * to the live relation and log, never crash the page.
 */
export function parseSnapshot<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  // JsonObject → caller-declared snapshot shape. The value came from our own
  // issue transaction (never from client input), so the cast is shape-only.
  return value as T;
}

/**
 * Snapshot → jsonb-column input. Snapshots are JSON-safe by construction
 * (strings, numbers, null, plain objects), so the round-trip is lossless; it
 * also guarantees no Date/Decimal ever lands in a jsonb column.
 */
export function toJsonInput<T>(value: T): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value));
}
