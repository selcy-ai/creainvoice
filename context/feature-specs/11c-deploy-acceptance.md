# Feature 11C: Coolify Deploy, Legal Pages, Seed & Final Acceptance

> **Parent:** Feature 11 (audit-backup-deploy-final). Bagian 3 dari 3 — li juga 11A (audit + maintenance) dan 11B (backup/restore). Setelah tiga sub-feature selesai, feature 11 complete dan project GA.

## Goal

Tutup GA: README deployment Coolify yang benar-benar bisa dipakai, halaman legal (privacy/terms UU PDP), cookie consent, seed acceptance data lengkap, **final E2E acceptance test** master prompt bagian 32 + 33, dan final Docker verification dari bersih. Setelah feature ini, project siap pakai di ZimaOS/Coolify tanpa menebak-nebak.

## Design

- **README deployment Coolify** lengkap (prasyarat, langkah, env var, first login, ganti password seed, backup/restore link ke 11B, troubleshoot, ZimaOS-specific notes).
- **Privacy policy + terms** halaman publik (`/privacy`, `/terms`) sesuai UU PDP (feature scope security-standards).
- **Cookie consent** banner minimal (session cookie essential + analytics non-esensial jika diaktifkan).
- **Seed acceptance data** lengkap (master prompt bagian 33): super admin env, org CreaInvoice Studio, profile SB (alamat Yogyakarta, WhatsApp 0851 5688 8959), bank Mandiri 1370021873449, customer PT Cipta Karya Nusantara + PIC Andi Wijaya Purchasing, PO 5198021181 tanggal 15 Juli 2026 nilai 4.500.000, item 5 × 900.000, invoice acceptance sample DOWN_PAYMENT 50% tanggal 31 Juli 2026 → nomor `INV/SB/VII/2026/001`.
- **Final acceptance**: jalankan seluruh acceptance criteria master prompt bagian 35 (40 poin) + E2E master prompt bagian 32 + seed bagian 33.

## Implementation

1. **Privacy/terms page** static content Bahasa Indonesia (UU PDP) — content legal-aware, bukan lorem ipsum.
2. **Cookie consent**: component banner + consent store (defer analytics actual — hanya consent infrastructure).
3. **README**: tulis ulang section deployment untuk Coolify (bukan hanya Docker Compose generic): create project, link repo `maulanaadib/invoice-me`, set env, deploy, verify `/health`, first login + ganti password seed, scheduled backup (link 11B), scheduled maintenance (link 11A).
4. **`.env.example`** lengkap + komentar jelas untuk setiap var.
5. **Seed lengkap** idempotent (super admin dari env, org + profile + bank + customer + PIC + PO + invoice acceptance sample). Invoice sample harus menghasilkan nomor `INV/SB/VII/2026/001` via numbering engine asli, bukan hardcode.
6. **Final E2E suite** (`tests/e2e/acceptance.spec.ts`): alur master prompt bagian 32 (11 langkah):
   1. Admin login. 2. Admin membuat user. 3. User login dengan temporary password. 4. User mengganti password. 5. User onboarding. 6. User membuat invoice DP 50%. 7. Preview menampilkan angka benar. 8. User issue invoice. 9. PDF dapat diunduh. 10. Admin dapat melihat invoice (audit-on-view tercatat). 11. User organisasi lain tidak dapat membuka invoice melalui URL langsung (404).
   Plus verifikasi PDF acceptance bagian 33: badge DOWN PAYMENT 50%, item 5 × Rp900.000, nilai pekerjaan 4.500.000, total 2.250.000, terbilang "Dua juta dua ratus lima puluh ribu rupiah", slot e-meterai compact kiri + signature kanan, logo compact, footer PO reference, `Halaman 1 dari 1`.
7. **Final Docker verification**: `docker compose up -d --build` dari bersih (down -v, prune), semua healthcheck healthy, migration + seed jalan di entrypoint, login flow manual smoke test.

## Dependencies

- Semua feature 00–10 + 11A + 11B (ini adalah feature penutup GA).
- `context/master-prompt.md` bagian 32, 33, 35 untuk acceptance criteria.

## Scope Limits

- **Tidak** ada DSR (data subject request) automation UI — struktur siap, implementation defer (catat open questions).
- **Tidak** ada analytics produk actual — hanya consent infrastructure.
- **Tidak** ada e-meterai resmi integration — tetap placeholder.
- **Tidak** ada multi-region deploy / HA — single instance Coolify.
- **Tidak** ada audit log retention policy UI — keep forever default.

## Check When Done

- [ ] README Coolify: prasyarat, create project, link repo `maulanaadib/invoice-me`, set env, deploy, verify `/health`, first login + ganti password seed.
- [ ] `.env.example` lengkap + komentar jelas.
- [ ] Halaman `/privacy` + `/terms` render (Bahasa Indonesia, UU PDP).
- [ ] Cookie consent banner tampil + functional (accept/reject).
- [ ] Seed lengkap: org CreaInvoice Studio, profile SB, bank Mandiri, customer PT Cipta Karya Nusantara + PIC Andi Wijaya, PO 5198021181.
- [ ] Invoice acceptance sample: DOWN_PAYMENT 50%, tanggal 31 Juli 2026, nomor `INV/SB/VII/2026/001`, grand total 2.250.000, terbilang "Dua juta dua ratus lima puluh ribu rupiah", stamp E_METERAI.
- [ ] PDF acceptance (dari feature 06 sample): badge DOWN PAYMENT 50%, item 5 × Rp900.000, nilai pekerjaan 4.500.000, total 2.250.000, slot e-meterai compact kiri + signature kanan, logo compact, footer PO reference, `Halaman 1 dari 1`.
- [ ] E2E acceptance 11 langkah lulus (login → buat user → user login+ganti password → onboarding → buat invoice DP → preview benar → issue → PDF download → admin view audit → org lain 404).
- [ ] `docker compose up -d --build` dari bersih (down -v, prune) sukses.
- [ ] Database health check healthy; app health check healthy; pdf-service health check healthy.
- [ ] Migration jalan di entrypoint; seed jalan idempotent (jalankan 2x, tidak error, tidak duplikat).
- [ ] Lint, typecheck, **unit test**, **integration test**, **E2E utama**, production build: semua lulus.

## Commit and Push

1. Every item in `Check When Done` passes (termasuk E2E acceptance).
2. Tests pass (`npm run test`).
3. Lint and typecheck pass (`npm run lint`, `npm run typecheck`).
4. Ask which branch: **`main`** (recommended) atau new branch. Never commit silently.
5. Commit: `feat(11c): coolify deploy docs, legal pages, acceptance seed, final E2E + docker verification`.
6. Push. Never force push.

## Progress Tracker

Update `context/progress-tracker.md`: tandai 11C selesai — **feature 11 complete, project GA**.
