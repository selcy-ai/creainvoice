// scripts/check-invoice-table.mjs — container readiness probe (Change 6:
// Prisma removed; plain pg against the Drizzle-created snake_case tables).
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  const rows = await pool.query(`select count(*)::int as n from "invoice"`);
  console.log("INVOICE_TABLE_OK", JSON.stringify(rows.rows));
} finally {
  await pool.end();
}
