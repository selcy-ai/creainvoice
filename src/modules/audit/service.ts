// src/modules/audit/service.ts
// Central audit trail — every mutating auth/org action in feature 01 writes
// through log(). Metadata is sanitized before it touches the database so
// passwords/tokens/PII can never land in the audit table.

import { db, type Database } from "@/server/db";
import { logger } from "@/server/logger";
import { auditLogs } from "@/db/schema";
import type { AuditAction } from "@/db/enums";
// Change 6: dropped Prisma (role tiers removed)

/** Key matcher: any metadata key containing these fragments is redacted. */
const SENSITIVE_KEY =
  /(password|token|secret|authorization|cookie|apikey|api_key|credential|npwp|account.?number|rekening)/i;

const MAX_STRING_LENGTH = 500;
const MAX_DEPTH = 5;
const MAX_ARRAY_ITEMS = 50;

/**
 * Recursively strips secret-bearing keys (value → "[REDACTED]", key kept so
 * the trail shows that something was hidden), truncates long strings, and
 * bounds depth/size so metadata can never grow unbounded.
 */
export function sanitizeMetadata(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "string") {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}…`
      : value;
  }
  if (depth >= MAX_DEPTH) {
    return "[TERLALU_DALAM]";
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitizeMetadata(item, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue;
      out[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitizeMetadata(entry, depth + 1);
    }
    return out;
  }
  return undefined; // functions/symbols dropped
}

/** Extracts the client IP (first X-Forwarded-For hop) and user agent. */
export function extractRequestMeta(
  request?: Request | null,
): { ip: string | null; userAgent: string | null } {
  if (!request) return { ip: null, userAgent: null };
  const forwarded = request.headers.get("x-forwarded-for");
  const ip =
    (forwarded && forwarded.split(",")[0]?.trim()) ||
    request.headers.get("x-real-ip") ||
    null;
  const userAgent = request.headers.get("user-agent");
  return { ip: ip || null, userAgent: userAgent ? userAgent.slice(0, 512) : null };
}

export interface AuditInput {
  actorUserId?: string | null;
  organizationId?: string | null;
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  request?: Request | null;
}

/**
 * Writes one audit row. Without a transaction client a failed audit write is
 * logged server-side instead of breaking the action it was attached to
 * (feature 01 contract — login/CRUD never fail because of audit).
 *
 * `tx` variant (feature 05 issue flow): when the issue/revision transaction
 * client is passed, a failure THROWS — the transaction rolls back, so the
 * audit row and the business change it describes are atomic (spec step 7:
 * "Audit log INVOICE_ISSUED dalam transaksi yang sama"). An audited action
 * that cannot be recorded must not commit.
 */
export async function log(
  input: AuditInput,
  tx?: Pick<Database, "insert">,
): Promise<void> {
  const { ip, userAgent } = extractRequestMeta(input.request);
  const metadata = sanitizeMetadata(input.metadata ?? {}) as Record<string, unknown>;
  const data = {
    actorUserId: input.actorUserId ?? null,
    organizationId: input.organizationId ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? "",
    metadata,
    ipAddress: ip,
    userAgent,
  };
  if (tx) {
    await tx.insert(auditLogs).values(data);
    return;
  }
  try {
    await db.insert(auditLogs).values(data);
  } catch (error) {
    logger.error(
      { module: "audit", action: input.action, err: error instanceof Error ? error.message : String(error) },
      "audit log gagal ditulis",
    );
  }
}

/** Alias for call sites where `log` would shadow console/local names. */
export const logAudit = log;
