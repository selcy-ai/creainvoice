// src/db/id.ts — primary key generation (Change 6).
//
// Prisma's `@default(cuid())` had no Drizzle equivalent, so the cuid-shaped
// id lives here as a `.$defaultFn()` on every table. The shape stays
// compatible with the ids the previous Prisma schema generated (base36,
// time-sortable-ish, url-safe) so seed rows, tests and URLs keep working.
//
// Layout: 24 characters — a 9-byte random suffix makes collisions
// practically impossible; the leading part encodes the millisecond timestamp
// (same idea as cuid2, deliberately simple).

import { randomBytes } from "node:crypto";

/**
 * Base-36 alphabet — 26 letters (a-z) + 10 digits (0-9) = exactly 36 symbols.
 * Must stay in sync with BASE: every value 0..35 has to map to a real
 * character, otherwise `ALPHABET[v % BASE]` yields `undefined` and the id
 * literally contains the string "undefined" (a Change 6 bug where the digits
 * 7/8/9 were missing from the alphabet).
 */
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const BASE = 36;

function toBase36(value: number, length: number): string {
  let out = "";
  let v = value;
  while (v > 0 && out.length < length) {
    out = ALPHABET[v % BASE] + out;
    v = Math.floor(v / BASE);
  }
  return out.padStart(length, "0");
}

/** Creates a new cuid-shaped id (24 chars, base36-ish). */
export function createId(): string {
  const timestamp = toBase36(Date.now(), 10);
  const random = randomBytes(10).toString("hex").slice(0, 14);
  return `c${timestamp}${random}`;
}
