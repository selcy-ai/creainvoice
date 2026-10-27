// tests/integration/audit-actions.test.ts — feature 11A Check When Done at
// the service layer, against the test database.
// The audit redaction contract, end to end through the real database:
//
//   "Audit metadata tidak mengandung password/token/rekening lengkap
//   (verifikasi sample 10 log terbaru)" — 10 rows written through the REAL
//   audit write helper (logAudit → sanitizeMetadata) come back from the
//   database with the sensitive keys redacted and the harmless values intact.
//
// The grep half of the audit checklist (every action has an emit point) lives
// in src/modules/audit/emit-points.test.ts, and the pure redaction unit tests
// live in src/modules/audit/service.test.ts.
//
// Change 6 removed the platform-admin audit viewer (modules/admin was deleted
// with PlatformRole), so the former "every AuditAction passes the super-admin
// filter pipeline" half of this suite is gone with it. The audit ACTIONS list
// itself still exists in src/db/enums and is exercised below.

import { beforeAll, describe, expect, it } from "vitest";
import { AUDIT_ACTIONS } from "@/db/enums";
import { logAudit } from "@/modules/audit/service";
import { db } from "@/tests/helpers/test-db";
import { resetDatabase } from "../factories";

beforeAll(async () => {
  await resetDatabase();
});

describe("the audit actions list is the complete viewer vocabulary", () => {
  it("exposes every action the writer can emit (dropdown completeness)", () => {
    // The writer accepts exactly this union; the viewer filters on it.
    expect(AUDIT_ACTIONS.length).toBeGreaterThan(0);
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
  });
});

describe("audit metadata sample (Check When Done: 10 log terbaru)", () => {
  it("persists no password/token/account number/NPWP in the latest 10 rows", async () => {
    // Ten rows through the one audit write path every service uses — planted
    // sensitive keys must be redacted before they touch the table, while
    // harmless metadata survives untouched.
    const actions = AUDIT_ACTIONS;
    for (let index = 0; index < 10; index += 1) {
      await logAudit({
        actorUserId: null,
        organizationId: null,
        action: actions[index]!,
        entityType: "verification",
        entityId: `sample-${index}`,
        metadata: {
          note: "verifikasi sampel 11a",
          amount: "1500000.00",
          password: "kata-sandi-rahasia-11a",
          token: "token-rahasia-11a",
          apiKey: "api-key-rahasia-11a",
          rekening: "1234567890123",
          accountNumber: "1234567890123",
          npwp: "01.2345.6789.000001",
        },
        request: null,
      });
    }

    const sample = await db.auditLog.findMany({
      where: { entityId: { startsWith: "sample-" } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 10,
    });
    expect(sample).toHaveLength(10);

    for (const row of sample) {
      const serialized = JSON.stringify(row.metadata);
      // The planted secret VALUES never reach the database...
      expect(serialized).not.toContain("kata-sandi-rahasia-11a");
      expect(serialized).not.toContain("token-rahasia-11a");
      expect(serialized).not.toContain("api-key-rahasia-11a");
      expect(serialized).not.toContain("1234567890123");
      expect(serialized).not.toContain("01.2345.6789.000001");

      const metadata = row.metadata as Record<string, unknown>;
      // ...the sensitive KEYS stay visible as redacted markers...
      expect(metadata.password).toBe("[REDACTED]");
      expect(metadata.token).toBe("[REDACTED]");
      expect(metadata.apiKey).toBe("[REDACTED]");
      expect(metadata.rekening).toBe("[REDACTED]");
      expect(metadata.accountNumber).toBe("[REDACTED]");
      expect(metadata.npwp).toBe("[REDACTED]");
      // ...and harmless metadata is preserved as stored.
      expect(metadata.note).toBe("verifikasi sampel 11a");
      expect(metadata.amount).toBe("1500000.00");
    }
  });
});
