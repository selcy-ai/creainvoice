// tests/helpers/test-db.ts — the `db` the test suite asserts against (Change 6).
//
// Test files import `db` from "@/tests/helpers/test-db" (NOT "@/server/db"):
// the facade below exposes the old Prisma model names and method shapes
// (`db.invoice.findUnique({ where: { id } })`, `db.auditLog.count({ where })`)
// mapped onto Drizzle queries, so hundreds of assertions across ~20 test
// files survive the Prisma → Drizzle migration unchanged. The real Drizzle
// client stays at "@/server/db" for the services those tests exercise.
//
// Anything the facade does not support must be added to ./query rather than
// worked around in a test.

export { queryDb as db } from "./query";
export type { TableName, TableHandle } from "./query";
