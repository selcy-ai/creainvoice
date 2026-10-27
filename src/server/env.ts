// src/server/env.ts — validated environment (Change 6: Clerk + Neon stack).
//
// The app fails fast at startup when a required variable is missing (Zod
// schema). Production values live in the Vercel dashboard, never in the repo.

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

  // Auth — Clerk (Change 6). The publishable key is safe for the client
  // bundle; the secret key and the webhook signing secret never are.
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(1),
  CLERK_SECRET_KEY: z.string().min(1),
  CLERK_WEBHOOK_SIGNING_SECRET: z.string().optional(),

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
