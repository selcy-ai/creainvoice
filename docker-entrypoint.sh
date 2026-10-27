#!/bin/sh
# docker-entrypoint.sh — runs at container start (Change 6: Drizzle, no Prisma):
#   1. drizzle-kit push — applies src/db/schema.ts to the database.
#   2. scripts/seed.mjs — idempotent neutral demo seed (CreaInvoice Studio,
#      PT Cipta Karya Nusantara). Always safe: it only fills gaps and is
#      idempotent on natural keys.
#   3. exec node server.js — the standalone Next.js server becomes PID 1.
set -e

echo "[entrypoint] Applying database schema (drizzle-kit push)…"
node node_modules/drizzle-kit/bin.cjs push --force

echo "[entrypoint] Running idempotent demo seed…"
node scripts/seed.mjs

echo "[entrypoint] Starting Next.js server…"
exec node server.js
