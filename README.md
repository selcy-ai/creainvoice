# CreaInvoice

Platform invoice multi-tenant untuk membuat, mengelola, dan mengekspor
invoice profesional (Down Payment, Pelunasan, Full, Termin) dengan live
preview A4 dan ekspor PDF. Setiap pengguna adalah admin penuh dari workspace
organisasinya sendiri.

## Stack

- **Next.js** (App Router) + TypeScript strict + Tailwind + shadcn/ui
- **Drizzle ORM** + **Neon Postgres 16** (region Singapore)
- **Clerk** untuk autentikasi (dengan Organizations — flat workspace, semua
  member adalah admin penuh; undangan via Clerk)
- **decimal.js** untuk uang; **Vitest** + **Playwright** untuk test
- **pdf-service terpisah** (Playwright Chromium, request internal bertanda tangan)
- Deploy target **Vercel** (deployment itu sendiri di luar scope Change 6)

## Dokumen Legal

Halaman publik `/privacy` (Kebijakan Privasi, UU PDP) dan `/terms`
(Syarat & Ketentuan) tersedia tanpa login. Banner cookie consent muncul
di setiap halaman (hanya cookie sesi esensial yang aktif saat ini).

## Local Development

```bash
# 1. Install dependencies
npm install

# 2. Copy .env.example → .env.local, isi nilai dev
cp .env.example .env.local

# 3. Set DATABASE_URL ke Neon (pooled endpoint) dan Clerk keys
#    (NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, CLERK_SECRET_KEY,
#     CLERK_WEBHOOK_SIGNING_SECRET)

# 4. Push schema Drizzle ke Neon
npx drizzle-kit push

# 5. (Opsional) Seed data demo netral
DEMO_SEED=1 node scripts/seed.mjs

# 6. Start dev server
npm run dev
```

Buka [http://localhost:3000](http://localhost:3000).

> Login dilakukan oleh Clerk. Buat user demo (`admin@creainvoice.id`) di
> dashboard Clerk, atau jalankan `scripts/seed.mjs` yang menyiapkan baris
> user + organisasi demo di database (password tetap dikelola Clerk —
> password better-auth lama **tidak** bisa dimigrasikan, semua user existing
# wajib reset password via Clerk).

### Menjalankan Test

```bash
npm run test        # Vitest unit + integration
npm run test:e2e    # Playwright E2E (butuh dev server)
```

Test (`tests/test.env`) dan local dev sama-sama menunjuk ke Neon
(keputusan engineer, Change 6). Test memakai database `inv_me_test` di
project Neon yang sama — tidak pernah menyentuh data dev.

Operasional (backup/restore, rotasi key, maintenance) dijelaskan pada
bagian lengkap di bawah.

## Troubleshooting

- **App tidak start** — cek env var wajib hilang (fail-fast di
  `src/server/env.ts`): `DATABASE_URL`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`,
  `CLERK_SECRET_KEY`, `INTERNAL_PDF_SECRET`, `BANK_ACCOUNT_ENCRYPTION_KEY`.
- **Login tidak jalan** — pastikan `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` dan
  `CLERK_SECRET_KEY` berasal dari Clerk application yang sama, dan URL aplikasi
  terdaftar sebagai allowed origin di dashboard Clerk.
- **Webhook sync user tidak jalan** — pastikan endpoint webhook
  (`https://<domain>/api/clerk/webhook`) terdaftar di Clerk dashboard dengan
- `CLERK_WEBHOOK_SIGNING_SECRET` yang cocok; webhook menulis ulang baris user
  + membership ke database.
- **PDF gagal render** — pastikan `INTERNAL_PDF_SECRET` sama antara app dan
  pdf-service; cek log pdf-service.
- **Backup gagal** — lihat exit code & JSON log di stderr; pastikan
  `BACKUP_DEST` writable dan `PG_*_BIN` / `PG_CONTAINER` ter-configure
  (lihat catatan Neon di bawah).

---

## Rotating the bank account encryption key

Bank account numbers are encrypted at rest (AES-256-GCM) with a key derived
from `BANK_ACCOUNT_ENCRYPTION_KEY` (SHA-256 of the secret, stored value format
`iv:tag:ciphertext`). To rotate the key — for example after a secret leak:

```bash
# 1. Pick a new secret (≥ 32 characters) and re-encrypt every stored number:
NEW_BANK_ACCOUNT_ENCRYPTION_KEY="<new-secret-with-at-least-32-chars>" \
  scripts/rotate-bank-key.sh

# 2. Put the new secret in your environment as BANK_ACCOUNT_ENCRYPTION_KEY
#    and restart the app.
```

The script reads `DATABASE_URL` and the current key from the app's env files
(`.env` / `.env.local`); set `OLD_BANK_ACCOUNT_ENCRYPTION_KEY` explicitly if
your old key is not in those files. It decrypts each row with the old key,
re-encrypts with the new key, verifies the round-trip **before** writing, and
never prints a plaintext number or a key. Rows already on the new key are
skipped, so the script is safe to re-run. This is a maintenance script — the
app itself has no UI for rotation.

## Backup and restore

Two scripts back up and restore the instance: the Neon PostgreSQL database
**and** the file storage (uploads + generated invoice PDFs).

```bash
scripts/backup.sh                      # create a backup
scripts/restore.sh --dry-run <dir>     # verify a backup, change nothing
scripts/restore.sh --test-db <dir>     # restore into an isolated check DB only
scripts/restore.sh <dir>               # full restore (with downtime)
```

### What a backup contains

Each run writes one timestamped directory (ISO-8601 UTC) under `BACKUP_DEST`
(default `/backups`):

```
/backups/2026-10-10T02-00-00Z/
├── db.dump               # pg_dump --format=custom (compressed, --no-owner --no-aac)
├── storage.tar.gz        # tar.gz of $STORAGE_ROOT/{uploads,invoices}
├── storage-files.sha256  # sha256 of every file inside the storage archive
├── manifest.json         # metadata: timestamp, database, sizes, per-file sha256
└── manifest.sha256       # sha256 of all of the above (the tamper seal)
```

`manifest.sha256` covers every artifact **and** `manifest.json` itself, so any
modification — of a file or of the manifest — is detected before a restore
touches anything.

### Configuration

All optional; the scripts read the same `.env` / `.env.local` the app reads,
and variables set by the caller always win.

| Variable | Default | Purpose |
| --- | --- | --- |
| `BACKUP_DEST` | `/backups` | Where backup directories are written (mount this as a persistent volume). |
| `BACKUP_RETENTION_DAYS` | `30` | Backups older than this are deleted on each successful run (minimum 1). Applies to pre-restore snapshots too. |
| `BACKUP_EXTERNAL_PATH` | *(unset)* | If set, every backup is also copied there (rsync when available, `cp -a` otherwise). |
| `PG_CONTAINER` | *(unset)* | Postgres container for the `docker exec` fallback — **not used with Neon** (see below). |
| `PG_DUMP_BIN` / `PG_RESTORE_BIN` / `PSQL_BIN` | *(unset)* | Full command overrides when the tools live somewhere unusual. |
| `RESTORE_TEST_DATABASE` | `creainvoice_restore_check` | Isolated database used to prove a dump restores before production is touched. |

The scripts need `pg_dump` / `pg_restore` / `psql` (**PostgreSQL 16 client or
newer** — Neon runs PG16). They resolve the tools in this order: explicit
`PG_*_BIN` override → binaries on the host `PATH` → `docker exec` into a
local postgres container (used with the old Compose stack; with Neon, install
the client or set `PG_*_BIN`). Neon's pooled endpoint works for dumps, but
for large restores prefer the direct (non-pooler) endpoint.

### Scheduling

**Host cron:**

```cron
# Daily at 02:00
0 2 * * * cd /path/to/creainvoice && BACKUP_DEST=/backups scripts/backup.sh >> /var/log/creainvoice-backup.log 2>&1
```

### A backup on the same disk is not a final backup

If the host disk dies, both the file storage **and** `/backups` die with it.
Always copy backups to another device — a NAS, another machine, or object
storage. Set `BACKUP_EXTERNAL_PATH` to a mount on another device and every
run is copied there automatically; alternatively pull from elsewhere:

```bash
# From your NAS, every night: pull the newest backup off the app host.
rsync -av --delete host:/backups/ /mnt/nas/creainvoice-backups/
```

Check that the external copy actually arrives (monitor the
`backup disalin ke penyimpanan eksternal` log line, or the exit code — a
failed external copy makes the run exit `1` instead of `0`).

### Restoring

1. **Verify first** — `scripts/restore.sh --dry-run <backup-dir>` checks every
   checksum (manifest + each file inside the storage archive) and changes
   nothing.
2. **(Optional) rehearse into an isolated database** —
   `scripts/restore.sh --test-db <backup-dir>` rebuilds the check database
   (`RESTORE_TEST_DATABASE`, default `creainvoice_restore_check`) from the dump
   and extracts storage into a temporary directory, verifying both. The
   production database and `STORAGE_ROOT` are never touched.
3. **Stop the app** — a restore replaces the database, so the app must be down.
4. **Restore** — `scripts/restore.sh <backup-dir>`. The script asks you to
   **type the database name** as confirmation (pipe it in automation:
   `echo "creainvoice" | scripts/restore.sh <dir>`). Then it:
   - snapshots the current database + storage to
     `$BACKUP_DEST/pre-restore/<timestamp>*` **before changing anything**;
   - proves the dump restores into the isolated `RESTORE_TEST_DATABASE`
     first — a broken dump aborts here with production untouched;
   - overwrites the database, extracts the storage archive, and verifies
     every restored file against `storage-files.sha256`.
5. **Start the app**, then check `/health` and log in.

Exit codes: `0` success · `1` aborted before any change (declined
confirmation, tool missing) · `2` fatal — a failed verification or restore is
**rolled back** from the pre-restore snapshot automatically; if the rollback
itself cannot complete, the script prints the snapshot path for manual
recovery. The snapshot is kept after a successful restore and follows the
same retention rotation; delete it once you have confirmed the app is healthy.

### Troubleshooting

- **`pg_restore: error: invalid URI query parameter: "schema"`** — you are
  invoking the tools by hand with a Drizzle/Prisma-style URL. The scripts
  strip `?schema=public` and `?sslmode=require` automatically; when calling
  `pg_dump`/`psql` yourself, use the URL without the query string.
- **`pg_dump: error: server version mismatch`** — the client is newer than the
  server (PostgreSQL refuses a dump from a newer major client). Use tools
  matching the server (Neon runs PostgreSQL 16).
- **`permission denied to create database`** — the restore verifies dumps in
  an isolated database and rebuilds the target database, so the `DATABASE_URL`
  role needs `CREATEDB` (`neondb_owner` has it).
- **`pg_dump: command not found`** — install a PostgreSQL 16+ client on the
  host, or set `PG_DUMP_BIN` explicitly.

## Maintenance Jobs

`scripts/maintenance.sh` performs two idempotent sweeps:

1. **Orphan file cleanup** — walks `STORAGE_ROOT` (`uploads/` + `invoices/`)
   and deletes files not referenced by any database column (`UploadRecord.path`,
   `InvoicePdf.storagePath`, `Invoice.pdfPath`, `ProjectReference.attachmentPath`,
   `InvoiceProfile.logoPath`, `Signer.signatureImagePath`, `Payment.proofPath`).
   Hidden files (`.health-check`) are skipped; per-file failures do not abort
   the sweep.
2. **Overdue recompute (batched)** — updates `status` from `ISSUED`/`SENT`/
   `PARTIALLY_PAID` to `OVERDUE` where `dueDate < startOfTodayJakarta`, in
   batches of 100, stopping on no-progress/partial batch.

Output: JSON per event to stderr. Exit codes: `0` success, `1` partial,
`1` fatal. Idempotent — a second run reports `deleted:0, updated:0`.

### Scheduling

**Host cron** (daily, e.g. 03:30):

```cron
30 3 * * * cd /path/to/creainvoice && scripts/maintenance.sh >> /var/log/creainvoice-maintenance.log 2>&1
```

## Learn More

- [Next.js Documentation](https://nextjs.org/docs) — learn about Next.js features.
- [Clerk Documentation](https://clerk.com/docs) — authentication, Organizations,
  webhooks.
- [Drizzle ORM Documentation](https://orm.drizzle.team) — schema, migrations,
  queries.
- [Neon Documentation](https://neon.tech/docs) — Postgres connection strings,
  branching.
