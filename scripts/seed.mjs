#!/usr/bin/env node
// scripts/seed.mjs — idempotent demo seed (Change 14: self-hosted better-auth).
//
// Seeds the neutral demo data the acceptance suite and a fresh install both
// rely on:
//
//   organization  CreaInvoice Studio (slug crea-invoice-studio)
//   user          admin@creainvoice.id — a REAL better-auth login
//   customer      PT Cipta Karya Nusantara
//   PIC           Andi Wijaya
//   PO            5198021181 (15 Juli 2026, 4.500.000)
//   invoice       DP 50% 5 × Rp900.000, 31 Juli 2026 → INV/SB/VII/2026/001
//
// Idempotent: re-running never duplicates anything. Every write is an
// upsert keyed on a stable seed id or a natural key.
//
// IMPORTANT (Change 14): the demo admin is a real login now — the password
// comes from SEED_ADMIN_PASSWORD (NEVER committed; .env.local or the
// compose environment) and is hashed with argon2 exactly the way sign-up
// does it, so `POST /api/auth/sign-in/email` accepts it. The account is
// created pre-verified so it can sign in before SMTP exists.
//
// Runs on plain `node` so the Docker entrypoint and `npm run seed` work
// without a TypeScript compiler. Column names are the DB's snake_case
// (src/db/schema.ts maps camelCase properties onto them).

import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import argon2 from "argon2";
import { Pool } from "pg";

// ─── environment ────────────────────────────────────────────────────────────

function parseEnvFile(filePath) {
  if (!existsSync(filePath)) return {};
  const out = {};
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function loadEnv() {
  const vars = {
    ...parseEnvFile(resolve(process.cwd(), ".env")),
    ...parseEnvFile(resolve(process.cwd(), ".env.local")),
  };
  for (const [key, value] of Object.entries(vars)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("[seed] DATABASE_URL is not set — cannot seed.");
    process.exit(1);
  }
  return { url };
}

/**
 * The demo admin's initial password. Change 14: the seed creates a REAL
 * login, so a password is mandatory — reading it from SEED_ADMIN_PASSWORD
 * keeps it out of the repo (never logged, never echoed).
 */
function seedAdminPassword() {
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!password || password.length < 8) {
    console.error(
      "[seed] SEED_ADMIN_PASSWORD is missing or shorter than 8 characters — set it in .env.local (never commit it).",
    );
    process.exit(1);
  }
  return password;
}

function encryptionKey() {
  const secret = process.env.BANK_ACCOUNT_ENCRYPTION_KEY;
  if (!secret || secret.length < 32) {
    console.error(
      "[seed] BANK_ACCOUNT_ENCRYPTION_KEY is missing or shorter than 32 characters.",
    );
    process.exit(1);
  }
  return createHash("sha256").update(secret, "utf8").digest();
}

/** AES-256-GCM, iv:tag:ciphertext (hex) — the mirror of
 *  src/modules/bank-accounts/crypto.ts, which this file cannot import. */
function encryptAccountNumber(digits) {
  const key = encryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(digits, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [iv.toString("hex"), tag.toString("hex"), ciphertext.toString("hex")].join(
    ":",
  );
}

// ─── demo data (neutral, Change 6) ──────────────────────────────────────────

const DEMO_ORG = { name: "CreaInvoice Studio", slug: "crea-invoice-studio" };
const DEMO_USER = {
  id: "seed_user_admin",
  username: "admin",
  email: "admin@creainvoice.id",
  name: "Admin CreaInvoice",
};
const DEMO_CUSTOMER = {
  companyName: "PT Cipta Karya Nusantara",
  legalName: "PT Cipta Karya Nusantara",
  businessType: "Manufaktur",
  address: "Jl. Industri No. 7",
  city: "Bekasi",
  province: "Jawa Barat",
  country: "Indonesia",
  phone: "0215550177",
  email: "ap@ciptakarya.co.id",
};
const DEMO_PIC = {
  name: "Andi Wijaya",
  title: "Purchasing",
  division: "Purchasing",
};
const DEMO_PO = {
  referenceNumber: "5198021181",
  referenceDate: new Date(Date.UTC(2026, 6, 15)),
  title: "Pengadaan Bracket Frame Assembly",
  workValue: "4500000",
};
const DEMO_PROFILE = {
  id: "seed_profile_sb",
  name: "CreaInvoice Studio",
  code: "SB",
  address: "Jl. Kaliurang KM 5, Yogyakarta",
  whatsapp: "0812 3456 7890",
  number_pattern: "INV/{CODE}/{ROMAN_MONTH}/{YYYY}/{SEQ:3}",
};
const DEMO_BANK = {
  id: "seed_bank_mandiri",
  bankName: "Bank Mandiri",
  accountNumber: "1234567890123",
  accountNumberLast4: "0123",
  accountHolder: "CreaInvoice Studio",
};
const DEMO_SIGNER = {
  id: "seed_signer_andi",
  name: "Andi",
  title: "Direktur",
  location: "Yogyakarta",
};

// ─── decimal helpers (acceptance fixture values only) ──────────────────────

const dp = (n) => (Math.round(n * 100) / 100).toFixed(2);
const romanMonth = (m) =>
  ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"][m - 1];

function renderNumber(pattern, code, date, seq) {
  return pattern
    .replace("{CODE}", code)
    .replace("{ROMAN_MONTH}", romanMonth(date.getUTCMonth() + 1))
    .replace("{YYYY}", String(date.getUTCFullYear()))
    .replace("{SEQ:3}", String(seq).padStart(3, "0"));
}

// Minimal terbilang for the acceptance fixture value (spec: grandTotal
// 2.250.000 → "Dua juta dua ratus lima puluh ribu rupiah"). The full
// implementation lives in src/lib/terbilang.ts (unit-tested).
function terbilang(amount) {
  if (amount === "2250000.00" || amount === "2250000") {
    return "Dua juta dua ratus lima puluh ribu rupiah";
  }
  throw new Error(`[seed] terbilang: unsupported fixture amount ${amount}`);
}

// Acceptance fixture: DP 50% of 5 × Rp900.000 → billingBase 2.250.000.
const ACCEPTANCE_ITEM_QTY = 5;
const ACCEPTANCE_ITEM_PRICE = "900000";
const ACCEPTANCE_BILLING_PERCENT = 50;
const ACCEPTANCE_WORK_VALUE = dp(ACCEPTANCE_ITEM_QTY * Number(ACCEPTANCE_ITEM_PRICE));
const ACCEPTANCE_BILLING_BASE = dp(
  Number(ACCEPTANCE_WORK_VALUE) * (ACCEPTANCE_BILLING_PERCENT / 100),
);
const ACCEPTANCE_GRAND_TOTAL = ACCEPTANCE_BILLING_BASE;

const ACCEPTANCE_CALC_RESULT = {
  lineAmounts: [ACCEPTANCE_WORK_VALUE],
  itemsSubtotal: ACCEPTANCE_WORK_VALUE,
  workValue: ACCEPTANCE_WORK_VALUE,
  previouslyBilled: "0.00",
  billingBase: ACCEPTANCE_BILLING_BASE,
  remainingAfter: ACCEPTANCE_BILLING_BASE,
  discountAmount: "0.00",
  additionalAmount: "0.00",
  taxMode: "NONE",
  taxPercent: "0.00",
  taxIncludedInTotal: "0.00",
  taxAmount: "0.00",
  roundingAmount: "0.00",
  grandTotal: ACCEPTANCE_GRAND_TOTAL,
};

const ACCEPTANCE_CALCULATION_SNAPSHOT = {
  invoiceType: "DOWN_PAYMENT",
  billingMode: "PERCENT",
  billingPercent: String(ACCEPTANCE_BILLING_PERCENT),
  billingAmount: null,
  workValue: ACCEPTANCE_WORK_VALUE,
  itemsSubtotal: ACCEPTANCE_WORK_VALUE,
  previouslyBilled: "0.00",
  billingBase: ACCEPTANCE_BILLING_BASE,
  discountAmount: "0.00",
  additionalAmount: "0.00",
  taxMode: "NONE",
  taxPercent: null,
  taxAmount: "0.00",
  roundingAmount: "0.00",
  grandTotal: ACCEPTANCE_GRAND_TOTAL,
  remainingAfter: ACCEPTANCE_GRAND_TOTAL,
  calc: ACCEPTANCE_CALC_RESULT,
  items: [
    {
      position: 1,
      description: "Pemasangan bracket frame",
      details: null,
      quantity: String(ACCEPTANCE_ITEM_QTY),
      unit: "Unit",
      unitPrice: ACCEPTANCE_ITEM_PRICE,
      discountAmount: "0.00",
      lineAmount: ACCEPTANCE_WORK_VALUE,
    },
  ],
};

function assertFixtureArithmetic() {
  if (ACCEPTANCE_WORK_VALUE !== "4500000.00" || ACCEPTANCE_BILLING_BASE !== "2250000.00") {
    throw new Error(
      `[seed] acceptance fixture arithmetic mismatch: workValue=${ACCEPTANCE_WORK_VALUE} billingBase=${ACCEPTANCE_BILLING_BASE}`,
    );
  }
  if (terbilang(ACCEPTANCE_GRAND_TOTAL) !== "Dua juta dua ratus lima puluh ribu rupiah") {
    throw new Error(
      `[seed] acceptance fixture terbilang mismatch: ${terbilang(ACCEPTANCE_GRAND_TOTAL)}`,
    );
  }
}

// ─── small upsert helpers over plain pg ─────────────────────────────────────

/** INSERT … ON CONFLICT DO UPDATE, returning the row. */
async function upsert(client, table, conflictTarget, values, update) {
  const cols = Object.keys(values);
  const placeholders = cols.map((_, i) => `$${i + 1}`);
  const setClause = (update ?? cols).map((c, i) => `"${c}" = EXCLUDED."${c}"`);
  const target = Array.isArray(conflictTarget)
    ? conflictTarget.map((c) => `"${c}"`).join(", ")
    : `"${conflictTarget}"`;
  const sql = `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")})
    VALUES (${placeholders.join(", ")})
    ON CONFLICT (${target}) DO UPDATE SET ${setClause}
    RETURNING *`;
  const result = await client.query(sql, cols.map((c) => values[c]));
  return result.rows[0];
}

async function countWhere(client, table, where) {
  const conds = Object.entries(where).map(([c], i) => `"${c}" = $${i + 1}`);
  const result = await client.query(
    `SELECT count(*)::int AS n FROM "${table}" WHERE ${conds.join(" AND ")}`,
    Object.values(where),
  );
  return result.rows[0].n;
}

async function findWhere(client, table, where) {
  const conds = Object.entries(where).map(([c], i) => `"${c}" = $${i + 1}`);
  const result = await client.query(
    `SELECT * FROM "${table}" WHERE ${conds.join(" AND ")} LIMIT 1`,
    Object.values(where),
  );
  return result.rows[0];
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main() {
  assertFixtureArithmetic();
  const { url } = loadEnv();
  const client = new Pool({ connectionString: url });

  try {
    // ── Admin user (a REAL better-auth login, Change 14) ─────────────────
    const user = await upsert(client, "user", "id", {
      id: DEMO_USER.id,
      name: DEMO_USER.name,
      email: DEMO_USER.email,
      email_verified: true,
      username: DEMO_USER.username,
      status: "ACTIVE",
      onboarding_complete: true,
      onboarding_step: 12,
    });

    // The credential account: argon2-hashed SEED_ADMIN_PASSWORD, provider
    // "credential", pre-verified. Re-running re-hashes (idempotent result,
    // not an accumulating row).
    const password = seedAdminPassword();
    const passwordHash = await argon2.hash(password);
    await upsert(
      client,
      "account",
      ["provider_id", "user_id"],
      {
        id: "seed_account_admin",
        account_id: DEMO_USER.id,
        provider_id: "credential",
        user_id: user.id,
        password: passwordHash,
      },
      ["password"],
    );
    console.log(
      `[seed] demo admin ready: ${user.email} (login via /login, password from SEED_ADMIN_PASSWORD — rotate after first login)`,
    );

    // ── Organization CreaInvoice Studio ───────────────────────────────────
    const org = await upsert(client, "organization", "slug", {
      id: "seed_org_creainvoice_studio",
      name: DEMO_ORG.name,
      slug: DEMO_ORG.slug,
      status: "ACTIVE",
    });
    await upsert(
      client,
      "membership",
      ["user_id", "organization_id"],
      {
        id: "seed_membership_admin_studio",
        user_id: user.id,
        organization_id: org.id,
        status: "ACTIVE",
      },
      ["status"],
    );

    // ── Customer + PIC + PO reference ─────────────────────────────────────
    const customer = await upsert(client, "customer", "id", {
      id: "seed_customer_cipta",
      organization_id: org.id,
      company_name: DEMO_CUSTOMER.companyName,
      legal_name: DEMO_CUSTOMER.legalName,
      business_type: DEMO_CUSTOMER.businessType,
      address: DEMO_CUSTOMER.address,
      city: DEMO_CUSTOMER.city,
      province: DEMO_CUSTOMER.province,
      country: DEMO_CUSTOMER.country,
      phone: DEMO_CUSTOMER.phone,
      email: DEMO_CUSTOMER.email,
      is_active: true,
    });
    const contactCount = await countWhere(client, "customer_contact", {
      customer_id: customer.id,
    });
    if (contactCount === 0) {
      await client.query(
        `INSERT INTO customer_contact (id, customer_id, name, title, division, is_primary)
         VALUES ($1, $2, $3, $4, $5, true)`,
        ["seed_contact_andi_wijaya", customer.id, DEMO_PIC.name, DEMO_PIC.title, DEMO_PIC.division],
      );
    }
    const contact = await findWhere(client, "customer_contact", {
      customer_id: customer.id,
    });

    const poCount = await countWhere(client, "project_reference", {
      organization_id: org.id,
      reference_number: DEMO_PO.referenceNumber,
    });
    let po;
    if (poCount > 0) {
      po = await findWhere(client, "project_reference", {
        organization_id: org.id,
        reference_number: DEMO_PO.referenceNumber,
      });
    } else {
      po = await upsert(client, "project_reference", "id", {
        id: "seed_po_5198021181",
        organization_id: org.id,
        customer_id: customer.id,
        reference_type: "PURCHASE_ORDER",
        reference_number: DEMO_PO.referenceNumber,
        reference_date: DEMO_PO.referenceDate,
        title: DEMO_PO.title,
        work_value: DEMO_PO.workValue,
        currency: "IDR",
        status: "ACTIVE",
      });
    }

    // ── Invoice profile SB + bank + signer ────────────────────────────────
    const profile = await upsert(client, "invoice_profile", "id", {
      ...DEMO_PROFILE,
      organization_id: org.id,
      default_stamp_mode: "E_METERAI",
      default_tax_mode: "NONE",
    });
    const bank = await upsert(client, "bank_account", "id", {
      id: DEMO_BANK.id,
      organization_id: org.id,
      bank_name: DEMO_BANK.bankName,
      account_number_encrypted: encryptAccountNumber(DEMO_BANK.accountNumber),
      account_number_last4: DEMO_BANK.accountNumberLast4,
      account_holder: DEMO_BANK.accountHolder,
      is_default: true,
      is_active: true,
    });
    const signer = await upsert(client, "signer", "id", {
      id: DEMO_SIGNER.id,
      organization_id: org.id,
      name: DEMO_SIGNER.name,
      title: DEMO_SIGNER.title,
      location: DEMO_SIGNER.location,
      is_default: true,
      is_active: true,
    });
    await client.query(
      `UPDATE invoice_profile SET default_bank_account_id = $1, default_signer_id = $2 WHERE id = $3`,
      [bank.id, signer.id, profile.id],
    );

    // ── Acceptance sample invoice (idempotent by number) ──────────────────
    const existing = await findWhere(client, "invoice", {
      organization_id: org.id,
      number: "INV/SB/VII/2026/001",
    });
    if (existing) {
      console.log("[seed] acceptance sample already present (INV/SB/VII/2026/001) — skipping");
      return;
    }

    const invoiceDate = new Date(Date.UTC(2026, 6, 31));
    // First invoice in the 2026 bucket for profile SB (YEARLY reset).
    const number = renderNumber(profile.number_pattern, profile.code, invoiceDate, 1);
    if (number !== "INV/SB/VII/2026/001") {
      throw new Error(
        `[seed] acceptance number mismatch: expected INV/SB/VII/2026/001, got ${number}`,
      );
    }

    // Seed the sequence bucket so the numbering engine and the row agree.
    await upsert(client, "invoice_sequence", ["invoice_profile_id", "sequence_key"], {
      id: "seed_sequence_sb_2026",
      invoice_profile_id: profile.id,
      sequence_key: "2026",
      current_value: 1,
    });

    const invoice = await client.query(
      `INSERT INTO invoice (
        id, organization_id, profile_id, customer_id, customer_contact_id,
        project_reference_id, invoice_type, status, number, number_preview,
        invoice_date, reference_type, reference_number, reference_date, currency,
        work_value, items_subtotal, previously_billed, billing_percent,
        billing_mode, billing_base, discount_amount, additional_amount,
        tax_mode, tax_amount, rounding_amount, grand_total, stamp_mode,
        signer_id, bank_account_id, remaining_after, amount_paid,
        created_by_id, issued_by_id, issued_at,
        issuer_snapshot, customer_snapshot, contact_snapshot,
        bank_snapshot, signer_snapshot, calculation_snapshot, template_snapshot
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10, $11, $12, $13, $14,
        $15, $15, $16, $17, $18, $19, $20, $20, $21, $20, $20, $22, $23,
        $24, $25, $22, $20, $26, $26, now(),
        $27, $28, $29, $30, $31, $32, $33
      ) RETURNING *`,
      [
        "seed_invoice_sb_001", // id
        org.id, // organization_id
        profile.id, // profile_id
        customer.id, // customer_id
        contact.id, // customer_contact_id
        po.id, // project_reference_id
        "DOWN_PAYMENT", // invoice_type
        "ISSUED", // status
        number, // number (+ number_preview)
        invoiceDate, // invoice_date
        "PURCHASE_ORDER", // reference_type
        DEMO_PO.referenceNumber, // reference_number
        DEMO_PO.referenceDate, // reference_date
        "IDR", // currency
        ACCEPTANCE_WORK_VALUE, // work_value (+ items_subtotal)
        "0.00", // previously_billed
        String(ACCEPTANCE_BILLING_PERCENT), // billing_percent
        "PERCENT", // billing_mode
        ACCEPTANCE_BILLING_BASE, // billing_base
        "0.00", // discount/additional/tax/rounding/amountPaid
        "NONE", // tax_mode
        ACCEPTANCE_GRAND_TOTAL, // grand_total (+ remaining_after)
        "E_METERAI", // stamp_mode
        signer.id, // signer_id
        bank.id, // bank_account_id
        user.id, // created/issued by
        // snapshots
        JSON.stringify(issuerSnapshot(profile)),
        JSON.stringify(customerSnapshot(customer)),
        JSON.stringify(contactSnapshot(contact)),
        JSON.stringify(bankSnapshot(bank)),
        JSON.stringify(signerSnapshot(signer)),
        JSON.stringify(ACCEPTANCE_CALCULATION_SNAPSHOT),
        JSON.stringify({
          templateKey: "corporate-blue",
          primaryColor: "#2563eb",
          stampMode: "E_METERAI",
          numberPattern: profile.number_pattern,
        }),
      ],
    );
    const inserted = invoice.rows[0];

    await client.query(
      `INSERT INTO invoice_item (id, invoice_id, position, description, details, quantity, unit, unit_price, discount_amount, line_amount)
       VALUES ($1, $2, 1, 'Pemasangan bracket frame', NULL, $3, 'Unit', $4, '0.00', $5)`,
      [
        "seed_invoice_item_sb_1",
        inserted.id,
        String(ACCEPTANCE_ITEM_QTY),
        ACCEPTANCE_ITEM_PRICE,
        ACCEPTANCE_WORK_VALUE,
      ],
    );

    console.log(
      `[seed] acceptance sample ready: ${inserted.number} (${terbilang(inserted.grand_total)})`,
    );
  } finally {
    await client.end();
  }
}

// ─── snapshot payloads ──────────────────────────────────────────────────────

function issuerSnapshot(profile) {
  return {
    profileId: profile.id,
    name: profile.name,
    code: profile.code,
    address: profile.address,
    whatsapp: profile.whatsapp,
    numberPattern: profile.number_pattern,
    templateKey: "corporate-blue",
    primaryColor: "#2563eb",
  };
}
function customerSnapshot(customer) {
  return {
    customerId: customer.id,
    companyName: customer.company_name,
    legalName: customer.legal_name,
    city: customer.city,
    province: customer.province,
    country: customer.country,
    phone: customer.phone,
    email: customer.email,
  };
}
function contactSnapshot(contact) {
  return {
    contactId: contact.id,
    name: contact.name,
    title: contact.title,
    division: contact.division,
  };
}
function bankSnapshot(bank) {
  return {
    bankAccountId: bank.id,
    bankName: bank.bank_name,
    accountHolder: bank.account_holder,
    maskedNumber: "**** **** 0123",
    last4: "0123",
    currency: "IDR",
  };
}
function signerSnapshot(signer) {
  return {
    signerId: signer.id,
    name: signer.name,
    title: signer.title,
    location: signer.location,
    signaturePath: null,
  };
}

main().catch((error) => {
  console.error("[seed] failed:", error);
  process.exitCode = 1;
});
