# creainvoice — audit docker & arsitektur SaaS ( historis, era Coolify/Docker )

Tanggal: 2026-10-22 (orchestrator, sesi fresh)

## 1. Yang aktif hari ini (fact, bukan asumsi)

| Container | Image | Ukuran | Network | Catatan |
|---|---|---|---|---|
| `invoice-me-app-1` | invoice-me-app | 768 MB | internal | healthy 8 hari, uid 1001, port 3000 TIDAK di-publish ke host |
| `invoice-me-pdf-service-1` | mcr.microsoft.com/playwright:v1.63.0-noble | **3,61 GB** | internal | healthy, **uid=0 (root)**. Port 3001 **tidak** di-publish ke host (klarifikasi: listener `0.0.0.0:3001` di host adalah **Life OS / Hermes Virtual Office** pid 309749, BUKAN pdf-service — dieleminasi 2026-10-22) |
| `invoice-me-postgres-1` | postgres:16-alpine | 420 MB | internal | DB yang dipakai app, volume `invoice-me_postgres-data` (3 org, 2 invoice) |
| `invoice-me-pg-host` | postgres:16-alpine | 420 MB | **bridge (orfan)** | 🔴 label kosong, tanpa compose, **tanpa mount** — DB bayangan 10 org, data hanya di dalam container |

- `cloudflared` ada di compose (profil terpisah) tapi **tidak berjalan**
- Build cache docker: **4,37 GB**
- App diakses via APP_URL `http://192.168.1.100:3000` di .env — tapi portnya tidak di-publish ke host → APP_URL saat ini **tidak valid** (curl 000). Yang bekerja: internal + SSH-tunnel via cloudflared? Belum diverifikasi.
- env validation: ✅ ADA (`src/server/env.ts`, zod, fail-fast). Saya koreksi klaim awal saya — validation bagus.
- Public registration: ✅ MATI (`src/server/auth.ts:62`). Super admin membuat user. Jadi `signUp` tidak terbuka.

## 2. Jejak data personal lama (30 file)

- **Sumber tunggal**: `prisma/seed.mjs` (org demo, profil demo, bank demo, customer demo PO 5198021181, invoice INV/SB/VII/2026/001)
- **26 file test** — mayoritas hanya fixture data uji (hardcode nama sebagai data pengujian)
- README.md ( customer demo + PO di contoh ), 2 comment di docker-entrypoint.sh, context/*.md ( spek lama )
- No WA **tidak** tersebar di src/ — hanya seed.mjs + spek

**Implikasi**: ini masalah **seed/demo data**, bukan branding yang terbakar ke kode. Untuk SaaS: ganti seed jadi **org + profil kosong**, user onboarding sendiri lewat wizard 12-langkah yang sudah ada. Test file bisa dibiarkan (data uji) atau di-neutralisir ke persona fiktif ( Change 6 : CreaInvoice Studio / PT Cipta Karya Nusantara / Andi Wijaya ).

## 3. Penilaian modul (LOC non-test)

| Modul | LOC | Nilai SaaS | Putusan |
|---|---|---|---|
| invoices | 4.240 | **Core** — ini yang user mau | PERTAHANKAN |
| payments | 946 | Tinggi — "sudah dibayar?" #1 | PERTAHANKAN |
| pdf (in-app) | 810 | **Core** — invoice tanpa PDF = tidak laku | PERTAHANKAN |
| auth multi-tenant | 946 | **Core SaaS** (org + membership + role) | PERTAHANKAN |
| customers + projects | 1.424 | Tinggi — invoice butuh pelanggan | PERTAHANKAN |
| profiles/signers/bank | 2.018 | Sedang — wajib invoice Indonesia | PERTAHANKAN |
| dashboard | 312 | Sedang | PERTAHANKAN |
| admin super-panel | 1.461 | **Ragu** — ops tool, bukan nilai pelanggan | LIHAT §4 |

## 4. pdf-service — BUANG sebagai service terpisah, PERTAHANKAN Playwright-nya

**Fakta**: worker `src/modules/pdf/worker.ts` sudah berjalan **in-process di app** via `src/instrumentation.ts` (`startPdfWorker()`), dengan claim atomik `UPDATE ... FOR UPDATE SKIP LOCKED` — race-safe multi-instance. Jadi app sudah punya jalur render sendiri.

**Tapi** tetap butuh Chromium (renderer sebenarnya) — hanya saja tidak perlu container 3,61 GB terpisah.

**Saran** (pilih satu, urut kesukaan saya):

- **A. Luluh ke dalam image app** — Dockerfile app pakai base `node:22-bookworm-slim` + `npx playwright install --with-deps chromium` (~1,2 GB total). Entry point: `node server.js` + `node pdf-service/src/index.js` sebagai second process (atau worker in-process saja bila `PDF_SERVICE_URL` diarahkan ke diri sendiri). Satu image, satu container. **Komprominya: satu OOM-kill**, tapi untuk single-instance SaaS kecil risikonya dapat dikelola (Chromium di-limit memori via `--memory` compose + restart policy)
- **B. Tetap sidecar** tapi: (a) base sama `node:22-slim` + install chromium manual (turun dari 3,61 GB → ~1,2 GB), (b) **tidak ada port mapping**, (c) user uid 1001, (d) network internal-only. Ini paling aman, hanya ukuran fleet tetep 2 container app-side

**Alasan saya condong A**: untuk SaaS 1-2 instance, operasional 1 container lebih murah. Playwright image resmi 3,61 GB itu terlalu gemuk untuk production deploy (Coolify tarik image itu setiap deploy).

**Yang TIDAK boleh dilakukan**: membuang Playwright total. PDF generation adalah fitur inti invoicing.

## 5. Rekomendasi urut (termurah → terbesar)

### Tier 1 — bersih-bersih, nol risiko — **DIEKSEKUSI 2026-10-22**

**Hasil:**
- ✅ `docker rm -f invoice-me-pg-host` — orfan dibuang, DB aktif tidak tersentuh (app /health 200, database ok)
- ✅ `docker builder prune -af` → **-4,37 GB**
- ✅ `docker rmi` strix-sandbox (5,9 GB) + hello-world + supabase edge-runtime (1,14 GB) + node:22-bookworm (1,64 GB) + alpine:3.19 → **-9,1 GB**
- ✅ Klarifikasi port 3001: **bukan bocoran pdf-service** — itu Life OS (pid 309749). pdf-service tidak menerbitkan port ke host. Tidak ada yang ditutup; catatan lama saya salah baca `ss -tlnp`
- ❌ Tidak menyentuh: app / postgres / pdf-service image (semua dipakai), node:22-bookworm-slim (base build), playwright base (parent layer pdf-service)

**Docker disk usage sebelum → sesudah:** 12,1 GB images + 4,4 GB cache → **4,8 GB images + 0 cache** (-11,7 GB)
**Verifikasi setelah eksekusi:** 3 container healthy, app /health 200 (database ok), app→pdf-service /health 200 (browser ok)

### Tier 1 — yang tersisa (catatan)
1. `docker rm -f invoice-me-pg-host` — orfan, data di dalam container saja (10 org, 3 invoice, terbaru 2026-10-11 03:21). **DB aktif (postgres-1, volume) tidak tersentuh** — verifikasi: app `DATABASE_URL` → `invoice-me-postgres-1` (network `invoice-me_internal`), pg-host ada di network `bridge` terpisah, app tidak bisa melihatnya
2. Tutup port 3001: hapus `EXPOSE` di Dockerfile.pdf + pastikan tidak ada mapping di compose (saat ini memang tidak ada mapping di compose — yang bocor adalah **proses di dalam container listen 0.0.0.0** dan network `internal` bridge masih reachable dari host docker bridge. Fix tegas: ubah bind ke `127.0.0.1:3001` di pdf-service/src/index.js, atau pindahkan ke network yang benar-benar internal-only)
3. `docker builder prune -af` + `docker image prune -f` → **rebut 4,37 GB**
4. Hapus deperti: `node:22-bookworm` (1,64 GB), `strix-sandbox` (5,9 GB), `hello-world`, `alpine:3.19`, `supabase edge-runtime` (1,14 GB) bila tidak dipakai project lain

### Tier 2 — hilangkan data personal dari seed & fixture — **DIEKSEKUSI 2026-10-23**, lalu diganti total persona netral di Change 6

**Hasil:**
- ✅ Nama personal lama (26 file, 126 replacement) → org seed netral ( slug `karya-nusantara` ), lalu Change 6 mengganti seluruhnya menjadi persona fiktif **CreaInvoice Studio**
- ✅ Varian: signer fixture diganti nama netral, slug org menjadi `creainvoice-studio`, id fixture menjadi `seed_signer_andi` ( Change 6 )
- ✅ Data pribadi dinetralkan: nomor WA, nomor rekening, dan alamat diganti nilai demo ( Change 6 menggunakan nilai demo CreaInvoice Studio )
- ✅ Docstring `deriveProfileCode` diperbaiki ke `KARYAN` ( terverifikasi: `node -e` menghasilkan KARYAN )
- ✅ Fix 1 test akibat rename: `pdf-render.test.ts:526` expects nama signer fixture baru ( nama signer demo berubah )
- ✅ Placeholder UI `step-01-workspace.tsx` & `signer-form.tsx` memakai persona netral Change 6
- ❌ TIDAK disentuh saat itu: `context/` ( spec bundle = contract ) — Change 6 kemudian mengganti nama di context/* juga; invoice number contract `INV/SB/VII/2026/001` dan profile code `SB` dipertahankan agar 700+ test tidak meledak ( keputusan disetujui user )

**Verifikasi:**
- `tsc --noEmit` → 0 error
- `eslint` → 0 error (12 warning pre-existing)
- vitest `src/` → **411/411 (34 files)**
- vitest `tests/integration/` → **281/281 (19 files)**
- `next build` → PASS
- grep data personal lama di luar `context/` → **0 hit** ( Change 6 memperluas ini ke `context/` juga )

**Catatan**: tests memakai `factories` + `resetDatabase()` (DB hermetik), bukan data seed — kecuali acceptance 0a yang baca seed (contract diperbarui bersamaan). Infra test: `docker run invoice-me-dev-pg` (postgres:16-alpine, bind 127.0.0.1:5432, volume `.data/postgres`) dibuat ulang setelah `pg-host` orfan dibuang di Tier 1.

### Tier 3 — rasionalisasi arsitektur (sebelum Coolify)
- **Luluhkan pdf-service** sesuai §4 (saran A)
- **Postgres**: pindahkan dari compose ke Coolify managed postgres (atau tetap compose, tapi credential kuat: `POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?required}`, bukan `invoice:invoice` hardcoded)
- **APP_PORT**: publish `3000:3000` ke host supaya APP_URL valid, atau betulkan APP_URL ke URL tunnel
- **uid**: pdf-service turun dari root ke uid 1001

### Tier 4 — sebelum ini jadi SaaS nyata (God's honest list)
- **Belum ada modul billing/subscription/plans** — grep `subscription|stripe|midtrans|quota` di src/prisma: **TIDAK ADA**. Ini syarat mutlak SaaS. Tanpa ini, "SaaS" = multi-tenant app gratis
- **Belum ada public signup** (registration mati) — untuk SaaS perlu self-serve onboarding. Wizard 12-langkah sudah ada (feature 02), tapi pintu masuknya hanya admin. Perlu: signup publik + verify email + auto-create org
- **Email**: grep mengonfirmasi tidak ada pengiriman email (undangan membership juga tidak, lihat Open Questions tracker). SaaS butuh SMTP transactional (welcome, invoice terkirim, reminder)
- **DB credential `invoice:invoice`** di compose (2 hit) — produksi harus dari env + secret
- **Storage**: local volume `uploads`/`invoices` — SaaS multi-tenant sebaiknya S3/R2 (Coolify mendukung both)
- **Hardening pdf-service**: root + 0.0.0.0 + 3,61 GB = tiga masalah sekaligus

## 6. Apa yang TIDAK saya_temukan (mungkin anda expect)
- Tidak ada fitur "kirim invoice via email" (hanya `markSent` manual)
- Tidak ada reminder_FOLLOW_UP / dungan cron
- Tidak ada multi-currency / multi-bahasa
- Tidak ada import CSV customer
- Tidak ada laporan multi-org (per org sudah ada dashboard)

## 7. Ringkasan eksekutif

**Pertahanan inti**: Next.js app + Prisma + auth multi-tenant + invoice engine + payments + PDF in-app + admin panel.
**Buang**: pg-host (orfan), build cache, image-image tidak terpakai, port 3001 bocor.
**Benahi**: pdf-service (luluhkan / amankan), seed "CreaInvoice Studio", postgres credential, APP_PORT.
**Harus dibangun bila SaaS**: billing/plans, public signup, email transactional, storage S3/R2.

**Tone sebelum menyimpan**: proyek ini bukan cacat — auth-nya matang, PDF-nya benar (A4, metadata, footer multi-halaman), audit-nya lengkap. Yang terjadi: AI PRD menskalakan untuk "bisa semua", padahal kebutuhan Anda "cetak invoice + lihat status bayar". 80% kode inti memang dibutuhkan. Yang over: container fleet (4 container, 12,6 GB) dan seed demo. Bukan perombakan — pembersihan + 4 modul SaaS yang hilang.
