// src/db/client.ts — Drizzle client (Change 6).
//
// One client per process (global-cached in dev like the Prisma client before
// it). Runs over the standard Postgres wire protocol, which works against a
// local Postgres (dev, tests, CI) AND a Neon pooled endpoint — the connection
// string in DATABASE_URL decides which one, nothing in this file does.
//
// `pg` (node-postgres) is used rather than @neondatabase/serverless because
// the latter speaks WebSocket+TLS only: it cannot reach a plain local
// Postgres, and the app must run unchanged in both places. On Vercel the same
// `pg` client connects to the Neon pooled endpoint over plain TCP+TLS, so the
// runtime story is identical there. Interactive transactions (db.transaction)
// — needed by the issue/numbering flow (feature 05) — are supported.

import { env } from "@/server/env";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "@/db/schema";

export type Database = ReturnType<typeof createDb>;

const globalForDb = globalThis as unknown as {
  creainvoiceDb: Database | undefined;
};

function createDb() {
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    // The pooled endpoint multiplexes; a small pool is plenty for the
    // single-instance MVP and keeps connection pressure on the free tier low.
    max: 10,
  });
  return drizzle<typeof schema>({ client: pool, schema });
}

export const db: Database = globalForDb.creainvoiceDb ?? createDb();

if (process.env.NODE_ENV !== "production") {
  globalForDb.creainvoiceDb = db;
}
