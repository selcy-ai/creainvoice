// src/db/enums.ts — domain enum types (Change 6).
//
// With Prisma gone, the enum value unions live here as plain string literal
// types backed by the pgEnum definitions in src/db/schema.ts. Keeping them in
// one module preserves the old `import type { InvoiceStatus } from
// "@prisma/client"` ergonomics — one place to look, one place to change.

export type OrgStatus = "ACTIVE" | "SUSPENDED";
export type UserStatus = "ACTIVE" | "SUSPENDED";
export type MembershipStatus = "ACTIVE" | "INVITED" | "REMOVED";
export type SequenceResetPolicy = "MONTHLY" | "YEARLY" | "NEVER";
export type TaxMode = "NONE" | "INCLUSIVE" | "EXCLUSIVE" | "MANUAL";
export type StampMode = "NONE" | "E_METERAI" | "PHYSICAL" | "BLANK_SPACE";
export type ReferenceType =
  | "PURCHASE_ORDER"
  | "SPK"
  | "CONTRACT"
  | "QUOTATION"
  | "OTHER"
  | "NONE";
export type ProjectStatus = "ACTIVE" | "COMPLETED" | "ON_HOLD" | "CANCELLED";
export type InvoiceType =
  | "DOWN_PAYMENT"
  | "SETTLEMENT"
  | "FULL"
  | "TERM"
  | "CUSTOM";
export type InvoiceStatus =
  | "DRAFT"
  | "ISSUED"
  | "SENT"
  | "PARTIALLY_PAID"
  | "PAID"
  | "OVERDUE"
  | "CANCELLED"
  | "REVISED";
export type BillingMode = "PERCENT" | "MANUAL";
export type PdfJobStatus = "PENDING" | "RUNNING" | "SUCCESS" | "FAILED";
export type PaymentMethod = "BANK_TRANSFER" | "CASH" | "QRIS" | "OTHER";
export type AuditAction =
  | "USER_CREATED"
  | "USER_DELETED"
  | "ORGANIZATION_CREATED"
  | "ORGANIZATION_DELETED"
  | "MEMBERSHIP_CHANGED"
  | "PROFILE_CHANGED"
  | "CUSTOMER_CREATED"
  | "CUSTOMER_UPDATED"
  | "CUSTOMER_DELETED"
  | "PROJECT_CREATED"
  | "PROJECT_UPDATED"
  | "INVOICE_DRAFT_CREATED"
  | "INVOICE_UPDATED"
  | "INVOICE_ISSUED"
  | "PDF_GENERATED"
  | "PDF_DOWNLOADED"
  | "INVOICE_SENT"
  | "INVOICE_CANCELLED"
  | "INVOICE_REVISED"
  | "PAYMENT_RECORDED"
  | "ADMIN_VIEWED_INVOICE"
  | "PDF_JOB_RETRIED";

/** Runtime list of every audit action (viewer completeness check, feature 11A). */
export const AUDIT_ACTIONS: readonly AuditAction[] = [
  "USER_CREATED",
  "USER_DELETED",
  "ORGANIZATION_CREATED",
  "ORGANIZATION_DELETED",
  "MEMBERSHIP_CHANGED",
  "PROFILE_CHANGED",
  "CUSTOMER_CREATED",
  "CUSTOMER_UPDATED",
  "CUSTOMER_DELETED",
  "PROJECT_CREATED",
  "PROJECT_UPDATED",
  "INVOICE_DRAFT_CREATED",
  "INVOICE_UPDATED",
  "INVOICE_ISSUED",
  "PDF_GENERATED",
  "PDF_DOWNLOADED",
  "INVOICE_SENT",
  "INVOICE_CANCELLED",
  "INVOICE_REVISED",
  "PAYMENT_RECORDED",
  "ADMIN_VIEWED_INVOICE",
  "PDF_JOB_RETRIED",
];
