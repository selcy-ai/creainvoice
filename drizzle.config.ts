// drizzle.config.ts — Drizzle Kit configuration (Change 6).
//
// `drizzle-kit generate` produces a SQL migration under drizzle/ from
// src/db/schema.ts; `drizzle-kit push` applies the schema directly and is what
// local dev + the Docker entrypoint use (the app has no Prisma CLI anymore).
//
// The driver is deliberately "node-postgres" rather than neon-serverless:
// `pg` speaks plain Postgres wire protocol, which works against BOTH a local
// Postgres (dev / CI / this sandbox) and a Neon pooled endpoint. The app's
// runtime client (src/db/client.ts) still uses neon-serverless, which is what
// Vercel serverless needs; drizzle-kit only runs in Node.

import { defineConfig } from "drizzle-kit";
import { env } from "@/server/env";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: env.DATABASE_URL,
  },
  // The schema uses drizzle-orm's pgEnum; keep the generated SQL strict.
  strict: true,
  verbose: true,
});
