// src/modules/invoices/numbering-core.ts
// Client-safe numbering pure functions (feature 04). The live editor preview
// needs to render the same draft preview number the server stores — without
// importing the db-touching numbering module into the browser bundle. The
// token grammar itself lives in modules/profiles/number-pattern (already
// client-safe since feature 02); this module adds the pure reset-policy
// bucketing. numbering.ts (server) re-exports both so server call sites and
// tests keep one import path.

import type { SequenceResetPolicy } from "@/db/enums";
import { previewNumber, validateNumberPattern } from "@/modules/profiles/number-pattern";

/** Placeholder sequenceKey for the NEVER policy — pattern date tokens still
 * render from the invoice date; the counter simply never resets. */
export const NEVER_RESET_KEY = "*";

/** The sequenceKey a date draws under a reset policy. Uses the same local
 * calendar reading as previewNumber, so a bucket key and the date tokens
 * rendered from {YYYY}/{MM} never disagree. */
export function sequenceKeyFor(policy: SequenceResetPolicy, date: Date): string {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  switch (policy) {
    case "MONTHLY":
      return `${year}-${String(month).padStart(2, "0")}`;
    case "YEARLY":
      return String(year);
    case "NEVER":
      return NEVER_RESET_KEY;
  }
}

export interface NumberPreviewProfile {
  code: string;
  numberPattern: string;
}

/**
 * Pure renderer: pattern + profile + date + sequence → preview string, or
 * null when the pattern is invalid (an edited profile may hold a broken
 * pattern — the editor shows "—" instead of a wrong number).
 */
export function renderNumberPreview(
  profile: NumberPreviewProfile,
  date: Date,
  nextSequence: number,
): string | null {
  if (!validateNumberPattern(profile.numberPattern).ok) return null;
  return previewNumber(profile.numberPattern, {
    code: profile.code,
    date,
    nextSequence,
  });
}
