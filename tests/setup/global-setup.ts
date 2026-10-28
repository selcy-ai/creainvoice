// tests/setup/global-setup.ts
// Vitest global setup: point every worker at the test database named by
// tests/test.env (process.env changes propagate to test workers) and apply the
// current Drizzle schema to it.
//
// Change 6 replaced Prisma with Drizzle, so there is no `prisma migrate
// deploy` anymore: `drizzle-kit push` applies src/db/schema.ts directly. The
// schema is re-pushed before every run, which makes the suite self-healing —
// a schema change only has to land in src/db/schema.ts to be picked up.

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { loadTestEnv } from "./env";

/**
 * The vitest config runs ESM; `require()` is flagged by the repo's lint
 * rules, but drizzle-kit's bin path still has to be resolved from the
 * filesystem at runtime. createRequire keeps the same resolution while
 * staying lint-clean.
 */
const require2 = createRequire(import.meta.url);

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function databaseNameOf(url: string): string {
  const pathname = new URL(url).pathname;
  const name = pathname.replace(/^\//, "");
  if (!name || !IDENTIFIER.test(name)) {
    throw new Error(`Invalid test database name in DATABASE_URL: "${name}"`);
  }
  return name;
}

/** Connects to the `postgres` maintenance database and creates the test
 *  database when it is missing. The Neon serverless driver cannot run DDL
 *  over the pooled endpoint on every plan, so this goes through `pg`. */
async function ensureDatabase(testUrl: string, dbName: string): Promise<void> {
  const { Pool } = await import("pg");
  const adminUrl = new URL(testUrl);
  adminUrl.pathname = "/postgres";
  adminUrl.search = "";
  const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
  try {
    const found = await admin.query(
      "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
      [dbName],
    );
    if (!found.rows[0]?.exists) {
      await admin.query(`CREATE DATABASE "${dbName}"`);
      console.log(`[test] created database ${dbName}`);
    }
  } finally {
    await admin.end();
  }
}

/** The env drizzle-kit needs just to load drizzle.config.ts (which imports
 *  src/server/env.ts). Test env files carry the real values; the placeholders
 *  here only satisfy the zod schema for the config module to parse. */
const CONFIG_PLACEHOLDERS = {
  BETTER_AUTH_SECRET: "test-better-auth-secret-key-at-least-32-characters",
  BETTER_AUTH_URL: "http://localhost:3000",
  INTERNAL_PDF_SECRET: "test-pdf-secret-at-least-32-characters",
  BANK_ACCOUNT_ENCRYPTION_KEY: "test-bank-key-at-least-32-characters",
  PDF_WORKER_ENABLED: "false",
};

export default async function globalSetup(): Promise<void> {
  const vars = loadTestEnv();
  const testUrl = vars.DATABASE_URL;
  if (!testUrl) throw new Error("tests/test.env must define DATABASE_URL");

  // Point all workers (they inherit this process env) at the test database.
  process.env.DATABASE_URL = testUrl;

  const dbName = databaseNameOf(testUrl);
  await ensureDatabase(testUrl, dbName);

  // Apply the schema (idempotent). drizzle-kit runs in a child process so the
  // main process keeps its own env untouched.
  const drizzleKit = resolveDrizzleKit();
  execFileSync(process.execPath, [drizzleKit, "push", "--force"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...CONFIG_PLACEHOLDERS,
      DATABASE_URL: testUrl,
    },
    stdio: "inherit",
  });
}

function resolveDrizzleKit(): string {
  const { existsSync } = require2("node:fs") as typeof import("node:fs");
  const { resolve } = require2("node:path") as typeof import("node:path");
  const candidate = resolve(process.cwd(), "node_modules/drizzle-kit/bin.cjs");
  if (!existsSync(candidate)) {
    throw new Error("drizzle-kit not found — run npm install first.");
  }
  return candidate;
}
