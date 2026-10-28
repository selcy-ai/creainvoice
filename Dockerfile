# ─── creainvoice — multi-stage production image ──────────────────────────────
#
# Build must work in TWO environments from the same file:
#   1. Coolify / any machine with npm access — `npm ci` installs from the
#      lockfile inside the build stage (git clone has no artifacts).
#   2. Air-gapped host where the repo already has node_modules + a built .next
#      (this project's dev machine) — `npm ci` fails, the fallback removes the
#      partial install and `COPY . .` supplies the host-installed tree.
# Either way the build stage ends with a full dependency set and runs
# `drizzle-kit push` (schema apply) + `npm run build` itself.
#
# The auth stack is self-hosted better-auth (Change 14): there is no Clerk
# key to provision, and the entrypoint seeds a real admin login from
# SEED_ADMIN_PASSWORD.

# ─── libssl provider ─────────────────────────────────────────────────────────
# Prisma query engine needs libssl/libcrypto 3 which bookworm-slim omits.
FROM node:22-bookworm AS libs

# ─── Build stage ─────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    CI=1

# The slim image ships no `openssl` binary — without it Prisma cannot detect
# the platform (it would default to openssl-1.1.x and try to DOWNLOAD engines
# that are already in node_modules). Same glibc, same libs as the runner.
COPY --from=libs /usr/lib/x86_64-linux-gnu/libssl.so.3 /usr/lib/x86_64-linux-gnu/libssl.so.3
COPY --from=libs /usr/lib/x86_64-linux-gnu/libcrypto.so.3 /usr/lib/x86_64-linux-gnu/libcrypto.so.3
COPY --from=libs /usr/bin/openssl /usr/bin/openssl

# Dependencies: prefer the npm cache, fall back to the registry (Coolify),
# fall back to host-installed node_modules when neither is reachable.
COPY package.json package-lock.json ./
RUN npm ci --prefer-offline --no-audit --no-fund \
    || { echo "[build] npm ci unavailable — falling back to host node_modules from the build context"; rm -rf node_modules; }

COPY . .
# DATABASE_URL below is a placeholder for schema parsing only — drizzle-kit
# push never connects at build time for the schema itself; the runtime value
# comes from the compose environment. Page-data collection evaluates route
# modules, which load the fail-fast env schema — build-time placeholders
# satisfy it (they are NOT baked into the runner image; the compose
# environment provides the real values at start).
RUN export DATABASE_URL=postgresql://placeholder@localhost:5432/placeholder \
      BETTER_AUTH_SECRET=build-placeholder-secret-at-least-32-characters \
      BETTER_AUTH_URL=http://localhost:3000 \
      INTERNAL_PDF_SECRET=build-placeholder-pdf-secret-at-least-32-chars \
      BANK_ACCOUNT_ENCRYPTION_KEY=build-placeholder-encryption-key-32chars! \
 && npm run build

# Stage the extra runtime tooling NOT part of Next's standalone trace that the
# entrypoint needs: drizzle-kit (schema push at start) and better-auth +
# argon2 (seed.mjs hashes the seed admin password with the SAME hasher login
# verifies against). Same flat node_modules layout npm uses, so require()
# resolution inside those packages works unchanged.
RUN node -e '\
const fs = require("fs"), path = require("path"); \
const root = "node_modules", out = "/extra-cli/node_modules"; \
const seen = new Set(), queue = ["drizzle-kit", "better-auth", "@better-auth/drizzle-adapter", "argon2", "pg", "drizzle-orm", "decimal.js", "zod"]; \
while (queue.length) { \
  const name = queue.shift(); \
  if (seen.has(name)) continue; \
  const file = path.join(root, name, "package.json"); \
  if (!fs.existsSync(file)) { console.error("[build] missing dependency: " + name); process.exit(1); } \
  seen.add(name); \
  const pkg = JSON.parse(fs.readFileSync(file, "utf8")); \
  for (const dep of Object.keys(pkg.dependencies || {})) if (!seen.has(dep)) queue.push(dep); \
} \
for (const name of seen) { \
  const dest = path.join(out, name); \
  fs.mkdirSync(path.dirname(dest), { recursive: true }); \
  fs.cpSync(path.join(root, name), dest, { recursive: true }); \
} \
console.log("[build] runtime CLI closure staged: " + seen.size + " packages");'

# ─── Production runner ──────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=libs /usr/lib/x86_64-linux-gnu/libssl.so.3 /usr/lib/x86_64-linux-gnu/libssl.so.3
COPY --from=libs /usr/lib/x86_64-linux-gnu/libcrypto.so.3 /usr/lib/x86_64-linux-gnu/libcrypto.so.3
# openssl CLI so the Prisma migrate engine can detect the platform offline
# (same reason as the build stage — no download, no network needed at start).
COPY --from=libs /usr/bin/openssl /usr/bin/openssl

RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs \
 && mkdir -p /data/uploads /data/invoices \
 && chown -R nextjs:nodejs /data

# App: standalone output (traced runtime deps) + static assets + schema +
# scripts. Paths are absolute: COPY --from resolves sources from the stage
# ROOT, not WORKDIR.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/src/db/schema.ts ./src/db/schema.ts
COPY --from=build /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=build /app/scripts ./scripts
# Extra runtime tooling NOT part of Next's standalone trace, but needed by the
# entrypoint scripts: drizzle-kit (schema push) and better-auth/argon2
# (seed.mjs hashes the seed admin password with the SAME hasher login
# verifies against). Staged as a flat node_modules that merges with the
# standalone tree above.
COPY --from=build /extra-cli/node_modules ./node_modules

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /app/scripts/healthcheck.sh \
 && chmod +x /usr/local/bin/docker-entrypoint.sh

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["docker-entrypoint.sh"]
