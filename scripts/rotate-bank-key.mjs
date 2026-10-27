#!/usr/bin/env node
// scripts/rotate-bank-key.mjs — feature 10: rotate BANK_ACCOUNT_ENCRYPTION_KEY.
//
// Re-encrypts every BankAccount.accountNumberEncrypted from the OLD key to the
// NEW key, verifying each value round-trips before and after. The crypto is a
// deliberate mirror of src/modules/bank-accounts/crypto.ts (this script runs on
// plain `node`, it cannot import TypeScript):
//   key    = SHA-256(utf8(secret))
//   value  = iv:tag:ciphertext (hex), AES-256-GCM, 12-byte IV, 16-byte tag
//
// Never prints a plaintext account number, a key, or a ciphertext.
//
// Usage (see README):
//   NEW_BANK_ACCOUNT_ENCRYPTION_KEY=<new-key> scripts/rotate-bank-key.sh
// OLD key defaults to BANK_ACCOUNT_ENCRYPTION_KEY (the app's current env).

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Pool } from "pg"; // Change 6: Prisma removed — plain pg here.

function deriveKey(secret) {
  return createHash("sha256").update(secret, "utf8").digest();
}

function decrypt(stored, key) {
  const [ivHex, tagHex, dataHex] = String(stored).split(":");
  if (!ivHex || !tagHex || !dataHex) {
    throw new Error("stored value is not in iv:tag:ciphertext form");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
}

function encrypt(plaintext, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${ciphertext.toString("hex")}`;
}

const oldSecret = process.env.OLD_BANK_ACCOUNT_ENCRYPTION_KEY || process.env.BANK_ACCOUNT_ENCRYPTION_KEY;
const newSecret = process.env.NEW_BANK_ACCOUNT_ENCRYPTION_KEY;

if (!oldSecret) {
  console.error(
    "ERROR: no OLD key — set BANK_ACCOUNT_ENCRYPTION_KEY (current) or OLD_BANK_ACCOUNT_ENCRYPTION_KEY.",
  );
  process.exit(1);
}
if (!newSecret) {
  console.error("ERROR: NEW key missing — set NEW_BANK_ACCOUNT_ENCRYPTION_KEY.");
  process.exit(1);
}
if (newSecret.length < 32) {
  console.error("ERROR: NEW key must be at least 32 characters (same rule as env validation).");
  process.exit(1);
}
if (newSecret === oldSecret) {
  console.error("ERROR: OLD and NEW keys are identical — nothing to rotate.");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("ERROR: DATABASE_URL not set (expected from .env / .env.local).");
  process.exit(1);
}

const oldKey = deriveKey(oldSecret);
const newKey = deriveKey(newSecret);

const prisma = new Pool({ connectionString: process.env.DATABASE_URL });
let exitCode = 0;

try {
  const found = await prisma.query(
    `SELECT id, account_number_encrypted, account_number_last4
     FROM bank_account ORDER BY created_at ASC`,
  );
  const rows = found.rows.map((row) => ({
    id: row.id,
    accountNumberEncrypted: row.account_number_encrypted,
    accountNumberLast4: row.account_number_last4,
  }));
  console.log(`Found ${rows.length} bank account row(s).`);

  let rotated = 0;
  let alreadyDone = 0;

  for (const row of rows) {
    let plaintext;
    try {
      plaintext = decrypt(row.accountNumberEncrypted, oldKey);
    } catch {
      // Already on the new key? Make the script safely re-runnable.
      try {
        const check = decrypt(row.accountNumberEncrypted, newKey);
        if (check.endsWith(row.accountNumberLast4)) {
          alreadyDone += 1;
          continue;
        }
      } catch {
        /* fall through to the hard error below */
      }
      console.error(
        `ERROR: id ${row.id} decrypts with NEITHER key — ciphertext corrupt or encrypted with a third key. Aborting (no rows written for this id).`,
      );
      throw new Error("aborted");
    }

    if (!plaintext.endsWith(row.accountNumberLast4)) {
      console.error(`ERROR: id ${row.id} last4 mismatch — stored last4 does not match the decrypted number.`);
      throw new Error("aborted");
    }

    const next = encrypt(plaintext, newKey);
    // Round-trip proof BEFORE writing: the new ciphertext must yield the same digits.
    if (decrypt(next, newKey) !== plaintext) {
      console.error(`ERROR: id ${row.id} failed the new-key round-trip check.`);
      throw new Error("aborted");
    }

    await prisma.query(
      `UPDATE bank_account SET account_number_encrypted = $1 WHERE id = $2`,
      [next, row.id],
    );
    rotated += 1;
  }

  console.log(
    `OK: ${rotated} row(s) re-encrypted with the new key` +
      (alreadyDone ? `, ${alreadyDone} already on the new key` : "") +
      ". Now set BANK_ACCOUNT_ENCRYPTION_KEY to the new value in your environment (Coolify) and restart the app.",
  );
} catch (error) {
  if (error instanceof Error && error.message !== "aborted") {
    console.error(`ERROR: ${error.message}`);
  }
  exitCode = 1;
} finally {
  await prisma.end();
}

process.exit(exitCode);
