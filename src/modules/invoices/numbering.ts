// src/modules/invoices/numbering.ts
// Numbering engine (feature 04): sequence-key reset policy + draft preview
// numbers + the final-number allocator. The token grammar lives in
// modules/profiles/number-pattern (single source of truth since feature 02 —
// {CODE} {YYYY} {YY} {MM} {DD} {ROMAN_MONTH} {SEQ:n}); this module adds the
// reset policy (sequenceKey) around it.
//
// Reset policy decides which InvoiceSequence bucket a draft/issue draws from
// (unique [invoiceProfileId, sequenceKey] per data-model):
//   MONTHLY → "2026-07"   (per year+month)
//   YEARLY  → "2026"      (per year)
//   NEVER   → "*"         (one global counter)
//
// Final allocation (`allocateFinalNumber`) happens ONLY at issue time
// (feature 05) — inside a transaction, so drafts never burn a real number.
// Drafts carry a non-binding `numberPreview` (current bucket value + 1),
// which may legitimately repeat across concurrent drafts: the uniqueness
// invariant lives on the ISSUED number.

import { db, type Database } from "@/server/db";
import { invoiceSequences } from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { previewNumber, validateNumberPattern } from "@/modules/profiles/number-pattern";
import { renderNumberPreview, sequenceKeyFor } from "@/modules/invoices/numbering-core";
import type { SequenceResetPolicy } from "@/db/enums";
import { createId } from "@/db/id";

// Pure helpers live in numbering-core (client-safe so the editor preview can
// render the same preview number); re-exported here for the server call sites
// and tests that import from the engine module.
export { NEVER_RESET_KEY, renderNumberPreview, sequenceKeyFor, type NumberPreviewProfile } from "@/modules/invoices/numbering-core";

/**
 * Non-binding draft preview from the ACTIVE bucket's next value. Never
 * allocates, never writes.
 */
export async function buildNumberPreview(
  profile: {
    id: string;
    code: string;
    numberPattern: string;
    sequenceResetPolicy: SequenceResetPolicy;
  },
  invoiceDate: Date,
  tx?: Pick<Database, "select" | "insert" | "update" | "execute">,
): Promise<string | null> {
  const client = tx ?? db;
  const key = sequenceKeyFor(profile.sequenceResetPolicy, invoiceDate);
  const existingRows = await client
    .select({ currentValue: invoiceSequences.currentValue })
    .from(invoiceSequences)
    .where(
      and(
        eq(invoiceSequences.invoiceProfileId, profile.id),
        eq(invoiceSequences.sequenceKey, key),
      ),
    )
    .limit(1);
  return renderNumberPreview(
    profile,
    invoiceDate,
    (existingRows[0]?.currentValue ?? 0) + 1,
  );
}

/**
 * Allocate the next sequence value for a profile/date (feature 05 calls this
 * inside the issue transaction). Row-locked (`FOR UPDATE`) upsert against the
 * unique [invoiceProfileId, sequenceKey] index, so two concurrent issues on
 * the same bucket serialize and can never produce the same number. The
 * "INSERT … DO NOTHING, then SELECT … FOR UPDATE" dance is required because
 * Postgres cannot lock a row it has just inserted in the same statement.
 */
export async function nextSequence(
  tx: Pick<Database, "select" | "insert" | "update" | "execute">,
  profile: { id: string; sequenceResetPolicy: SequenceResetPolicy },
  invoiceDate: Date,
): Promise<number> {
  const key = sequenceKeyFor(profile.sequenceResetPolicy, invoiceDate);
  // The primary key must be supplied by hand: @default(cuid()) is a
  // CLIENT-side default, so a raw INSERT would otherwise hit NOT NULL (23502).
  // createId() keeps the same contract the data model asks for — a
  // non-sequential, unguessable id (node:crypto, never a counter).
  // Drizzle cannot express INSERT ... ON CONFLICT DO NOTHING with a raw
  // default id, so the sequence row is seeded with the app's id generator.
  // Column names are the DB's snake_case (src/db/schema.ts maps camelCase
  // properties onto snake_case columns — raw SQL speaks the DB's names).
  await tx.execute(sql`
    INSERT INTO "invoice_sequence" ("id", "invoice_profile_id", "sequence_key", "current_value", "updated_at")
    VALUES (${createId()}, ${profile.id}, ${key}, 0, now())
    ON CONFLICT ("invoice_profile_id", "sequence_key") DO NOTHING
  `);
  // Lock the bucket row: a concurrent allocator blocks here until we commit.
  await tx.execute(sql`
    SELECT id FROM "invoice_sequence"
    WHERE "invoice_profile_id" = ${profile.id} AND "sequence_key" = ${key}
    FOR UPDATE
  `);
  const updated = await tx
    .update(invoiceSequences)
    .set({ currentValue: sql`${invoiceSequences.currentValue} + 1` })
    .where(
      and(
        eq(invoiceSequences.invoiceProfileId, profile.id),
        eq(invoiceSequences.sequenceKey, key),
      ),
    )
    .returning({ currentValue: invoiceSequences.currentValue });
  const next = updated[0]?.currentValue;
  if (next === undefined) {
    throw new Error("Alokasi nomor urut gagal — bucket sequence tidak ditemukan.");
  }
  return next;
}

/**
 * Render a FINAL invoice number for a profile/date, allocating the sequence
 * (feature 05 issue flow). previewNumber zero-pads {SEQ:n} to the pattern
 * width, so the allocated int goes through as-is.
 */
export async function allocateFinalNumber(
  tx: Pick<Database, "select" | "insert" | "update" | "execute">,
  profile: {
    id: string;
    code: string;
    numberPattern: string;
    sequenceResetPolicy: SequenceResetPolicy;
  },
  invoiceDate: Date,
): Promise<string> {
  const validation = validateNumberPattern(profile.numberPattern);
  if (!validation.ok) {
    // Issue-time hard failure — feature 05 surfaces this before any write.
    throw new Error(validation.message);
  }
  const allocated = await nextSequence(tx, profile, invoiceDate);
  return previewNumber(profile.numberPattern, {
    code: profile.code,
    date: invoiceDate,
    nextSequence: allocated,
  });
}
