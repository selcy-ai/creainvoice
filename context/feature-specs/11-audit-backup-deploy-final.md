# Feature 11: Audit, Backup, Deploy & Final Acceptance

> **PECAH JADI 3 SUB-SPEC** — spec ini terlalu besar untuk satu worker run (30 checklist, 4 domain terpisah). Build dalam urutan:
> 1. **`11a-audit-maintenance.md`** — audit gap fill 22 action + maintenance jobs (orphan cleanup, overdue recompute)
> 2. **`11b-backup-restore.md`** — backup/restore script + dokumentasi
> 3. **`11c-deploy-acceptance.md`** — Coolify README, legal pages, cookie consent, seed acceptance, final E2E + docker verification
>
> Spec ini tetap menjadi rujukan kontrak tingkat tinggi. Setelah ketiga sub-feature selesai, feature 11 complete.

## Goal

Tutup GA: lengkapi audit log ke 22 action, backup/restore script, README deployment Coolify yang benar-benar bisa dipakai, maintenance job, final Docker verification, dan jalankan **seluruh E2E acceptance test** master prompt bagian 32 + 33. Setelah feature ini, project siap pakai di ZimaOS/Coolify tanpa menebak-nebak.

## Design

- **Audit log 22 action** (verifikasi + gap fill):
  LOGIN_SUCCESS, LOGIN_FAILED, LOGOUT, USER_CREATED, USER_SUSPENDED, PASSWORD_RESET, ORGANIZATION_CREATED, MEMBERSHIP_CHANGED, PROFILE_CHANGED, CUSTOMER_CREATED, CUSTOMER_UPDATED, CUSTOMER_DELETED, PROJECT_CREATED, PROJECT_UPDATED, INVOICE_DRAFT_CREATED, INVOICE_UPDATED, INVOICE_ISSUED, PDF_GENERATED, PDF_DOWNLOADED, INVOICE_SENT, INVOICE_CANCELLED, INVOICE_REVISED, PAYMENT_RECORDED, ADMIN_VIEWED_INVOICE.
  (Cek setiap action ada emit point-nya di modul terkait; tambah yang terlewat.)
- **Backup script** (`scripts/backup.sh`): `pg_dump` compressed, archive uploads + PDFs, checksum, timestamp, retention configurable (default keep 30), output ke `/backups` volume. Plus `scripts/restore.sh`: konfirmasi eksplisit, restore db, restore file, verifikasi checksum, petunjuk downtime. Dokumentasi: backup di disk ZimaOS/Coolify yang sama **bukan backup final** — beri opsi copy ke NAS/external (rsync ke path configurable).
- **Maintenance job** (`scripts/maintenance.sh` atau internal cron-style): hapus orphan file (file di storage yang tidak ada record-nya), recompute OVERDUE status invoice massal, hapus expired audit? (no — audit keep forever default). Schedule via Coolify scheduled task atau host cron.
- **README deployment Coolify** lengkap (prasyarat, langkah, env var, first login, ganti password seed, backup/restore, troubleshoot, ZimaOS-specific notes).
- **Privacy policy + terms** halaman publik (`/privacy`, `/terms`) sesuai UU PDP (feature scope security-standards).
- **Cookie consent** banner minimal (session cookie essential + analytics non-esensial jika diaktifkan).
- **Final acceptance**: jalankan seluruh acceptance criteria master prompt bagian 35 (40 poin) + E2E master prompt bagian 32 + seed bagian 33.

## Implementation

1. **Audit gap audit**: enum `AuditAction` + grep codebase untuk emit point setiap action; tambah yang hilang.
2. **Backup/restore script** full implementation (replace feature 00 stub) + dokumentasi README.
3. **Maintenance script**: orphan cleanup (scan storage vs DB record), overdue recompute, log output.
4. **Privacy/terms page** static content Bahasa Indonesia (UU PDP).
5. **Cookie consent**: component banner + consent store (defer analytics actual — hanya consent infrastructure).
6. **README**: tulis ulang section deployment untuk Coolify (bukan hanya Docker Compose generic): create project, link repo, set env, deploy, verify health, scheduled backup.
7. **Seed acceptance data** lengkap (master prompt bagian 33): super admin env, org CreaInvoice Studio, profile SB (alamat Yogyakarta, WhatsApp 0851 5688 8959), bank Mandiri 1370021873449, customer PT Cipta Karya Nusantara + PIC Andi Wijaya Purchasing, PO 5198021181 tanggal 15 Juli 2026 nilai 4.500.000, item 5 × 900.000, invoice acceptance sample DOWN_PAYMENT 50% tanggal 31 Juli 2026 → nomor `INV/SB/VII/2026/001`.
8. **Final E2E suite** (`tests/e2e/acceptance.spec.ts`): jalankan alur master prompt bagian 32 (11 langkah) + verifikasi PDF acceptance bagian 33.
9. **Final Docker verification**: `docker compose up -d --build` dari bersih, semua healthcheck healthy, migration + seed jalan di entrypoint, login flow manual smoke test.

## Dependencies

- Semua feature 00–10 (ini adalah feature penutup GA).

## Scope Limits

- **Tidak** ada DSR (data subject request) automation UI — struktur siap, implementation defer (catat open questions).
- **Tidak** ada analytics produk actual — hanya consent infrastructure.
- **Tidak** ada e-meterai resmi integration — tetap placeholder.
- **Tidak** ada multi-region deploy / HA — single instance Coolify.
- **Tidak** ada automated restore test (restore script ada + terdokumentasi, tapi test restore ke DB live di-skip — hanya dry-run verify checksum).
- **Tidak** ada audit log retention policy UI — keep forever default.

## Check When Done

**Audit**
- [ ] Semua 22+ `AuditAction` punya emit point di codebase (grep bukti).
- [ ] Audit log viewer feature 09 menampilkan semua action dengan filter.
- [ ] Audit metadata tidak mengandung password/token/rekening lengkap (verifikasi sample).

**Backup / Restore**
- [ ] `scripts/backup.sh` jalan: pg_dump compressed + archive uploads+PDFs + checksum + timestamp; retention delete old backup berfungsi.
- [ ] `scripts/restore.sh` dry-run: verifikasi checksum + konfirmasi eksplisit; restore db ke test DB berhasil (isolated test, bukan production).
- [ ] README dokumentasi backup + catatan "backup di disk yang sama bukan backup final" + opsi NAS/external.

**Maintenance**
- [ ] Orphan cleanup: file tanpa record terhapus (test dengan seed orphan file).
- [ ] Overdue recompute: invoice lewat due_date → status OVERDUE terupdate massal.

**Deploy / Docs**
- [ ] README Coolify: prasyarat, create project, link repo `maulanaadib/invoice-me`, set env, deploy, verify `/health`, first login + ganti password seed.
- [ ] `.env.example` lengkap + komentar jelas.
- [ ] Halaman `/privacy` + `/terms` render (Bahasa Indonesia, UU PDP).
- [ ] Cookie consent banner tampil + functional (accept/reject).

**Seed acceptance**
- [ ] Seed lengkap: org CreaInvoice Studio, profile SB, bank Mandiri, customer PT Cipta Karya Nusantara + PIC Andi Wijaya, PO 5198021181.
- [ ] Invoice acceptance sample: DOWN_PAYMENT 50%, tanggal 31 Juli 2026, nomor `INV/SB/VII/2026/001`, grand total 2.250.000, terbilang "Dua juta dua ratus lima puluh ribu rupiah", stamp E_METERAI.
- [ ] PDF acceptance (dari feature 06 sample): badge DOWN PAYMENT 50%, item 5 × Rp900.000, nilai pekerjaan 4.500.000, total 2.250.000, slot e-meterai compact kiri + signature kanan, logo compact, footer PO reference, `Halaman 1 dari 1`.

**Final E2E (master prompt bagian 32)**
- [ ] 1. Admin login.
- [ ] 2. Admin membuat user.
- [ ] 3. User login dengan temporary password.
- [ ] 4. User mengganti password.
- [ ] 5. User onboarding.
- [ ] 6. User membuat invoice DP 50%.
- [ ] 7. Preview menampilkan angka benar.
- [ ] 8. User issue invoice.
- [ ] 9. PDF dapat diunduh.
- [ ] 10. Admin dapat melihat invoice (audit-on-view tercatat).
- [ ] 11. User organisasi lain tidak dapat membuka invoice melalui URL langsung (404).

**Final Docker**
- [ ] `docker compose up -d --build` dari bersih (down -v, prune) sukses.
- [ ] Database health check healthy; app health check healthy; pdf-service health check healthy.
- [ ] Migration jalan di entrypoint; seed jalan idempotent.
- [ ] Lint, typecheck, **unit test**, **integration test**, **E2E utama**, production build: semua lulus.

## Commit and Push

1. Every item in `Check When Done` passes (termasuk E2E acceptance).
2. Tests pass (`npm run test`).
3. Lint and typecheck pass (`npm run lint`, `npm run typecheck`).
4. Ask which branch: **`main`** (recommended) atau new branch. Never commit silently.
5. Commit: `feat(11): audit gap fill, backup/restore, maintenance, privacy/terms, Coolify README, final acceptance E2E + seed`.
6. Push. Never force push.

## Progress Tracker

When this feature lands, update `context/progress-tracker.md`:

- Move `audit-backup-deploy-final` from **Next Up** to **In Progress** at build start, then to **Completed** when `Check When Done` passes.
- Set **Current Phase** ke `Build complete — all features done, ready for production use`.
- Set **Current Goal** ke `None — all 12 features completed`.
- Add to **Open Questions**: DSR automation UI, analytics actual integration, e-meterai resmi, QRIS, multi-currency, audit retention policy — semua defer post-GA.
- Add to **Architecture Decisions**: backup pg_dump + archive + checksum + retention; maintenance orphan cleanup + overdue recompute; audit keep-forever default.
- Add one line to **Session Notes**: "Feature 11 done: audit 22 actions complete, backup/restore, maintenance, privacy/terms, Coolify deploy docs, final acceptance E2E lulus. Project siap GA."
- Do not touch other features' rows.
