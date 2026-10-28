// src/server/env.ts — validated environment (Change 14: self-hosted better-auth).
//
// The app fails fast at startup when a required variable is missing (Zod
// schema). Production values live in the hosting dashboard (Dokploy/Coolify),
// never in the repo.

import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),

  // Application
  APP_URL: z.string().url().default("http://localhost:3000"),
  APP_PORT: z.coerce.number().default(3000),

  // Database — Neon Postgres (pooled endpoint). Local dev AND tests connect
  // to Neon (engineer decision, Change 6).
  DATABASE_URL: z.string().min(1),

  // Auth — better-auth, self-hosted (Change 14). The secret signs the
  // session cookie; the URL is the canonical base URL for auth callbacks;
  // trusted origins is the comma-separated list of extra origins allowed to
  // POST (LAN hosts + the deploy origin).
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url().default("http://localhost:3000"),
  BETTER_AUTH_TRUSTED_ORIGINS: z.string().default(""),

  // Seed admin (Change 14): the demo/first admin created by scripts/seed.mjs.
  // Never commit a real value; rotate after first login.
  SEED_ADMIN_PASSWORD: z.string().min(8).optional(),

  // PDF service
  INTERNAL_PDF_SECRET: z.string().min(32),
  INTERNAL_APP_URL: z
    .string()
    .url()
    .default("http://host.docker.internal:3000"),
  // App → pdf-service (PdfJob worker POSTs /render here).
  PDF_SERVICE_URL: z.string().url().default("http://localhost:3001"),
  // The PdfJob poller runs inside the app process (single instance MVP).
  // "false" disables it — used by tests, which drive the worker explicitly.
  PDF_WORKER_ENABLED: z
    .preprocess((v) => (v === "" ? undefined : v), z.enum(["true", "false"]))
    .default("true"),

  // Storage
  STORAGE_ROOT: z.string().min(1).default("./.data"),
  UPLOAD_MAX_MB: z.coerce.number().default(2),

  // Localization
  DEFAULT_TIMEZONE: z.string().default("Asia/Jakarta"),

  // Bank account encryption at rest (AES-256-GCM key material; min 32 chars)
  BANK_ACCOUNT_ENCRYPTION_KEY: z.string().min(32),

  // Error tracking (optional; empty string from compose = disabled)
  GLITCHTIP_DSN: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().url().optional(),
  ),

  // Cloudflare tunnel (optional)
  CLOUDFLARE_TUNNEL_TOKEN: z.string().optional(),
});

const _parsed = envSchema.safeParse(process.env);

if (!_parsed.success) {
  console.error(
    "❌ Invalid environment variables:",
    _parsed.error.flatten().fieldErrors,
  );
  throw new Error("Invalid environment variables — check server logs");
}

export const env = _parsed.data;
