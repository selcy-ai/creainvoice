// src/db/schema.ts — Drizzle schema (Change 6).
//
// Ported from prisma/schema.prisma with the Change 6 decisions:
//   - Better Auth models (user/account/session/verification) are GONE.
//     Auth is delegated to Clerk; this database only mirrors the rows it
//     needs (user profile + organization membership) via the Clerk webhook.
//   - PlatformRole / organization role tiers are GONE. Every member of an
//     organization is a full admin of that workspace (flat workspace).
//   - Identifiers stay cuid-shaped (text primary keys); the Clerk webhook
//     upserts use the Clerk ids directly.
//
// Money is numeric(18,2) everywhere (architecture invariant 1); percentages
// are numeric(5,2). Timestamps are timestamptz (DB UTC, display Asia/Jakarta).

import { sql } from "drizzle-orm";
import { createId } from "@/db/id";
import Decimal from "decimal.js";
import {
  bigint,
  boolean,
  decimal,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { customType } from "drizzle-orm/pg-core";

/**
 * Money column — decimal with the SAME string shape Prisma used to return.
 *
 * Drizzle's `decimal` hands back exactly what Postgres sends ("450000000.00",
 * scale-padded). Prisma's Decimal stringified with trailing zeros trimmed
 * ("450000000"), and every service, view, and test in this repo was written
 * against that shape. Normalizing once at the read boundary keeps the
 * money-as-string contract (code-standards: no float money) and avoids
 * touching dozens of call sites: value = Decimal(value).toString().
 */
export const money = customType<{ data: string; driverData: string }>({
  dataType() {
    return "numeric(18,2)";
  },
  fromDriver(value: string): string {
    // decimal.js mirrors Prisma's Decimal.toString() exactly: fixed notation,
    // trailing zeros trimmed, no scientific notation for 18-digit values.
    return new Decimal(value).toString();
  },
});

// ─── Enums ──────────────────────────────────────────────────────────────────

export const orgStatus = pgEnum("org_status", ["ACTIVE", "SUSPENDED"]);
export const userStatus = pgEnum("user_status", ["ACTIVE", "SUSPENDED"]);
export const membershipStatus = pgEnum("membership_status", [
  "ACTIVE",
  "INVITED",
  "REMOVED",
]);
export const sequenceResetPolicy = pgEnum("sequence_reset_policy", [
  "MONTHLY",
  "YEARLY",
  "NEVER",
]);
export const taxMode = pgEnum("tax_mode", ["NONE", "INCLUSIVE", "EXCLUSIVE", "MANUAL"]);
export const stampMode = pgEnum("stamp_mode", ["NONE", "E_METERAI", "PHYSICAL", "BLANK_SPACE"]);
export const referenceType = pgEnum("reference_type", [
  "PURCHASE_ORDER",
  "SPK",
  "CONTRACT",
  "QUOTATION",
  "OTHER",
  "NONE",
]);
export const projectStatus = pgEnum("project_status", [
  "ACTIVE",
  "COMPLETED",
  "ON_HOLD",
  "CANCELLED",
]);
export const invoiceType = pgEnum("invoice_type", [
  "DOWN_PAYMENT",
  "SETTLEMENT",
  "FULL",
  "TERM",
  "CUSTOM",
]);
export const invoiceStatus = pgEnum("invoice_status", [
  "DRAFT",
  "ISSUED",
  "SENT",
  "PARTIALLY_PAID",
  "PAID",
  "OVERDUE",
  "CANCELLED",
  "REVISED",
]);
export const billingMode = pgEnum("billing_mode", ["PERCENT", "MANUAL"]);
export const pdfJobStatus = pgEnum("pdf_job_status", ["PENDING", "RUNNING", "SUCCESS", "FAILED"]);
export const paymentMethod = pgEnum("payment_method", ["BANK_TRANSFER", "CASH", "QRIS", "OTHER"]);
export const auditAction = pgEnum("audit_action", [
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
]);

// ─── Clerk-mirrored identity ────────────────────────────────────────────────

/**
 * Mirror of the Clerk User. Written by the /api/clerk/webhook route on
 * user.created / user.updated / user.deleted. The password NEVER lives here —
 * Clerk owns credentials; former better-auth hashes cannot be migrated
 * (agreed in Change 6), so every existing user must reset via Clerk.
 */
export const users = pgTable(
  "user",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    // Display name — Clerk firstName/lastName joined, or the username.
    name: text("name"),
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").notNull().default(false),
    imageUrl: text("image_url"),
    // Clerk username (unique in Clerk; kept for display).
    username: text("username"),
    status: userStatus("status").notNull().default("ACTIVE"),
    // Feature 02: onboarding wizard state. onboardingStep tracks resume
    // position (1..12); onboardingComplete flips true only when the wizard
    // finishes. Clerk users still run the workspace setup wizard.
    onboardingComplete: boolean("onboarding_complete").notNull().default(false),
    onboardingStep: integer("onboarding_step").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [unique("user_username_unique").on(t.username)],
);

/**
 * Mirror of a Clerk Organization — the workspace container. Flat: every
 * member is a full admin (Change 6 removed OrganizationRole and role tiers).
 */
export const organizations = pgTable(
  "organization",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    imageUrl: text("image_url"),
    status: orgStatus("status").notNull().default("ACTIVE"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
  },
);

/**
 * Mirror of a Clerk OrganizationMembership. NO role column on purpose: every
 * member is a full admin of the workspace (Change 6). Invites still happen
 * through Clerk Organizations.
 */
export const memberships = pgTable(
  "membership",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    status: membershipStatus("status").notNull().default("ACTIVE"),
    joinedAt: timestamp("joined_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    unique("membership_user_organization_unique").on(t.userId, t.organizationId),
  ],
);

// ─── Audit ──────────────────────────────────────────────────────────────────

export const auditLogs = pgTable(
  "audit_log",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    organizationId: text("organization_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    action: auditAction("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    metadata: jsonb("metadata").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("audit_log_organization_created_at_idx").on(t.organizationId, t.createdAt),
    index("audit_log_actor_created_at_idx").on(t.actorUserId, t.createdAt),
  ],
);

// ─── Onboarding & invoice profile (feature 02) ─────────────────────────────

export const invoiceProfiles = pgTable(
  "invoice_profile",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    code: text("code").notNull(),
    legalName: text("legal_name"),
    logoPath: text("logo_path"),
    primaryColor: text("primary_color").notNull().default("#2563eb"),
    address: text("address"),
    phone: text("phone"),
    whatsapp: text("whatsapp"),
    fax: text("fax"),
    email: text("email"),
    website: text("website"),
    taxId: text("tax_id"),
    defaultBankAccountId: text("default_bank_account_id"),
    defaultSignerId: text("default_signer_id"),
    numberPattern: text("number_pattern")
      .notNull()
      .default("INV/{CODE}/{ROMAN_MONTH}/{YYYY}/{SEQ:3}"),
    sequenceResetPolicy: sequenceResetPolicy("sequence_reset_policy")
      .notNull()
      .default("YEARLY"),
    defaultCurrency: text("default_currency").notNull().default("IDR"),
    defaultTaxMode: taxMode("default_tax_mode").notNull().default("NONE"),
    defaultTaxPercent: decimal("default_tax_percent", { precision: 5, scale: 2 }),
    defaultStampMode: stampMode("default_stamp_mode").notNull().default("NONE"),
    defaultNotes: text("default_notes"),
    templateKey: text("template_key").notNull().default("corporate-blue"),
    settings: jsonb("settings"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [unique("invoice_profile_organization_code_unique").on(t.organizationId, t.code)],
);

export const bankAccounts = pgTable(
  "bank_account",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    profileId: text("profile_id"),
    bankName: text("bank_name").notNull(),
    bankCode: text("bank_code"),
    // AES-256-GCM ciphertext: iv:tag:ciphertext (hex) — never plaintext.
    accountNumberEncrypted: text("account_number_encrypted").notNull(),
    accountNumberLast4: text("account_number_last4").notNull(),
    accountHolder: text("account_holder").notNull(),
    branch: text("branch"),
    currency: text("currency").notNull().default("IDR"),
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index("bank_account_organization_idx").on(t.organizationId)],
);

export const signers = pgTable(
  "signer",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    title: text("title"),
    location: text("location"),
    signatureImagePath: text("signature_image_path"),
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index("signer_organization_idx").on(t.organizationId)],
);

// ─── Customers & projects (feature 03) ─────────────────────────────────────

export const customers = pgTable(
  "customer",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    companyName: text("company_name").notNull(),
    legalName: text("legal_name"),
    businessType: text("business_type"),
    taxId: text("tax_id"),
    address: text("address"),
    city: text("city"),
    province: text("province"),
    postalCode: text("postal_code"),
    country: text("country"),
    phone: text("phone"),
    whatsapp: text("whatsapp"),
    email: text("email"),
    notes: text("notes"),
    isActive: boolean("is_active").notNull().default(true),
    // Soft delete: only Customer has this (data-model rule).
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index("customer_organization_company_idx").on(t.organizationId, t.companyName)],
);

export const customerContacts = pgTable(
  "customer_contact",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    title: text("title"),
    division: text("division"),
    email: text("email"),
    phone: text("phone"),
    whatsapp: text("whatsapp"),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index("customer_contact_customer_primary_idx").on(t.customerId, t.isPrimary)],
);

export const projectReferences = pgTable(
  "project_reference",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    referenceType: referenceType("reference_type").notNull(),
    referenceNumber: text("reference_number").notNull(),
    referenceDate: timestamp("reference_date", { withTimezone: true, mode: "date" }),
    title: text("title").notNull(),
    description: text("description"),
    workValue: money("work_value").notNull(),
    currency: text("currency").notNull().default("IDR"),
    startDate: timestamp("start_date", { withTimezone: true, mode: "date" }),
    endDate: timestamp("end_date", { withTimezone: true, mode: "date" }),
    status: projectStatus("status").notNull().default("ACTIVE"),
    attachmentPath: text("attachment_path"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("project_reference_organization_number_idx").on(
      t.organizationId,
      t.referenceNumber,
    ),
  ],
);

// Sequence counters for {SEQ}, allocated at issue time (feature 05).
export const invoiceSequences = pgTable(
  "invoice_sequence",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    invoiceProfileId: text("invoice_profile_id")
      .notNull()
      .references(() => invoiceProfiles.id, { onDelete: "cascade" }),
    sequenceKey: text("sequence_key").notNull(),
    currentValue: integer("current_value").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    unique("invoice_sequence_profile_key_unique").on(t.invoiceProfileId, t.sequenceKey),
  ],
);

// ─── Invoice engine (features 04/05) ───────────────────────────────────────

export const invoices = pgTable(
  "invoice",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    profileId: text("profile_id")
      .notNull()
      .references(() => invoiceProfiles.id, { onDelete: "restrict" }),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    customerContactId: text("customer_contact_id"),
    projectReferenceId: text("project_reference_id"),
    invoiceType: invoiceType("invoice_type").notNull(),
    status: invoiceStatus("status").notNull().default("DRAFT"),
    // Final number — allocated at issue time; null while DRAFT.
    number: text("number"),
    // Temporary number rendered from the pattern while the invoice is a draft.
    numberPreview: text("number_preview"),
    invoiceDate: timestamp("invoice_date", { withTimezone: true, mode: "date" }).notNull(),
    dueDate: timestamp("due_date", { withTimezone: true, mode: "date" }),
    referenceType: referenceType("reference_type"),
    referenceNumber: text("reference_number"),
    referenceDate: timestamp("reference_date", { withTimezone: true, mode: "date" }),
    paymentTerms: text("payment_terms"),
    currency: text("currency").notNull().default("IDR"),

    // Money: numeric(18,2) end to end (invariants 1 & 2).
    workValue: money("work_value").notNull(),
    workValueOverride: boolean("work_value_override").notNull().default(false),
    workValueReason: text("work_value_reason"),
    itemsSubtotal: money("items_subtotal").notNull(),
    previouslyBilled: money("previously_billed")
      .notNull()
      .default("0"),
    billingPercent: decimal("billing_percent", { precision: 5, scale: 2 }),
    billingMode: billingMode("billing_mode").notNull().default("PERCENT"),
    billingAmount: money("billing_amount"),
    billingBase: money("billing_base").notNull(),
    termName: text("term_name"),
    termNumber: integer("term_number"),
    customLabel: text("custom_label"),
    customReason: text("custom_reason"),
    discountAmount: money("discount_amount")
      .notNull()
      .default("0"),
    additionalAmount: money("additional_amount")
      .notNull()
      .default("0"),
    taxMode: taxMode("tax_mode").notNull().default("NONE"),
    taxPercent: decimal("tax_percent", { precision: 5, scale: 2 }),
    taxAmount: money("tax_amount").notNull().default("0"),
    roundingAmount: money("rounding_amount")
      .notNull()
      .default("0"),
    grandTotal: money("grand_total").notNull(),
    amountPaid: money("amount_paid").notNull().default("0"),
    notes: text("notes"),
    footerText: text("footer_text"),
    stampMode: stampMode("stamp_mode").notNull().default("NONE"),
    signerId: text("signer_id"),
    bankAccountId: text("bank_account_id"),

    // Issue metadata (feature 05).
    issuedAt: timestamp("issued_at", { withTimezone: true, mode: "date" }),
    issuedById: text("issued_by_id"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: "date" }),
    cancellationReason: text("cancellation_reason"),
    revisedFromId: text("revised_from_id"),
    replacedById: text("replaced_by_id"),

    // Immutable JSON snapshots captured AT ISSUE (invariant 4).
    issuerSnapshot: jsonb("issuer_snapshot"),
    customerSnapshot: jsonb("customer_snapshot"),
    contactSnapshot: jsonb("contact_snapshot"),
    bankSnapshot: jsonb("bank_snapshot"),
    signerSnapshot: jsonb("signer_snapshot"),
    calculationSnapshot: jsonb("calculation_snapshot"),
    templateSnapshot: jsonb("template_snapshot"),

    // Outstanding amount after issue; decremented as payments land (feature 07).
    remainingAfter: money("remaining_after")
      .notNull()
      .default("0"),

    // Root-relative path of the OFFICIAL generated PDF (feature 06).
    pdfPath: text("pdf_path"),

    createdById: text("created_by_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    unique("invoice_organization_number_unique").on(t.organizationId, t.number),
    index("invoice_organization_status_idx").on(t.organizationId, t.status),
    index("invoice_organization_date_idx").on(t.organizationId, t.invoiceDate),
    index("invoice_organization_customer_idx").on(t.organizationId, t.customerId),
    index("invoice_organization_project_idx").on(t.organizationId, t.projectReferenceId),
  ],
);

export const invoiceItems = pgTable(
  "invoice_item",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    invoiceId: text("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    description: text("description").notNull(),
    details: text("details"),
    quantity: money("quantity").notNull(),
    unit: text("unit").notNull(),
    unitPrice: money("unit_price").notNull(),
    discountAmount: money("discount_amount")
      .notNull()
      .default("0"),
    lineAmount: money("line_amount").notNull(),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index("invoice_item_invoice_position_idx").on(t.invoiceId, t.position)],
);

// ─── PDF job queue + official PDF record (features 05/06) ──────────────────

export const pdfJobs = pgTable(
  "pdf_job",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    invoiceId: text("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    status: pdfJobStatus("status").notNull().default("PENDING"),
    attempt: integer("attempt").notNull().default(0),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("pdf_job_status_created_idx").on(t.status, t.createdAt),
    index("pdf_job_invoice_idx").on(t.invoiceId),
  ],
);

export const invoicePdfs = pgTable(
  "invoice_pdf",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    invoiceId: text("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    storagePath: text("storage_path").notNull(),
    originalFilename: text("original_filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "bigint" }).notNull(),
    sha256: text("sha256").notNull(),
    templateVersion: text("template_version").notNull(),
    generatedById: text("generated_by_id").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
    isOfficial: boolean("is_official").notNull().default(false),
  },
  (t) => [
    unique("invoice_pdf_invoice_version_unique").on(t.invoiceId, t.version),
    index("invoice_pdf_invoice_idx").on(t.invoiceId),
  ],
);

// ─── Upload records (feature 09) ────────────────────────────────────────────

export const uploadRecords = pgTable(
  "upload_record",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    path: text("path").notNull().unique(),
    sizeBytes: bigint("size_bytes", { mode: "bigint" }).notNull(),
    mimeType: text("mime_type").notNull(),
    kind: text("kind").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index("upload_record_organization_idx").on(t.organizationId)],
);

// ─── Payments (feature 07) ──────────────────────────────────────────────────

export const payments = pgTable(
  "payment",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    invoiceId: text("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    paymentDate: timestamp("payment_date", { withTimezone: true, mode: "date" }).notNull(),
    amount: money("amount").notNull(),
    method: paymentMethod("method").notNull(),
    referenceNumber: text("reference_number"),
    proofPath: text("proof_path"),
    notes: text("notes"),
    overpaymentReason: text("overpayment_reason"),
    createdById: text("created_by_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("payment_organization_date_idx").on(t.organizationId, t.paymentDate),
    index("payment_invoice_date_idx").on(t.invoiceId, t.paymentDate),
  ],
);
