// drizzle.config.ts — Drizzle Kit configuration (Change 14).
//
// `drizzle-kit generate` produces a SQL migration under drizzle/ from
// src/db/schema.ts; `drizzle-kit push` applies the schema directly and is what
// local dev + the Docker entrypoint use.
//
// The driver is deliberately "node-postgres" rather than neon-serverless:
// `pg` speaks plain Postgres wire protocol, which works against BOTH a local
// Postgres (dev / CI / this sandbox) and a Neon pooled endpoint. The app's
// runtime client (src/db/client.ts) uses the same `pg` driver.
//
// This file deliberately does NOT import src/server/env.ts: drizzle-kit runs
// in its own TypeScript context (no tsconfig path aliases) and must work from
// the Docker entrypoint, so the URL comes straight from process.env after the
// repo's env files (`.env`, then `.env.local`) are applied.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "drizzle-kit";

function loadEnvFiles(): void {
  for (const name of [".env", ".env.local"]) {
    const filePath = resolve(process.cwd(), name);
    if (!existsSync(filePath)) continue;
    for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      if (process.env[key] !== undefined) continue;
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  }
}

loadEnvFiles();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("drizzle.config: DATABASE_URL is not set (check .env.local).");
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl,
  },
  // The schema uses drizzle-orm's pgEnum; keep the generated SQL strict.
  strict: true,
  verbose: true,
});
