# Feature 06: Invoice Preview & PDF

## Goal

Bangun render PDF profesional via pdf-service terpisah: shared renderer (preview = print), template Corporate Blue, A4 multi-page, storage persistent, secure download. Setelah feature ini, invoice issued menghasilkan PDF A4 yang siap dikirim ke customer.

## Design

- **Shared renderer**: satu komponen `InvoiceRenderer` (dari feature 04) dipakai untuk preview browser **dan** print route `/print/invoices/[id]`. Print route tidak pakai cookie session — pakai **signed short-lived token** (HMAC `INTERNAL_PDF_SECRET` + expiry, divalidasi server-side) karena pdf-service yang fetch.
- **pdf-service** (container terpisah, Playwright Chromium):
  - Route `/render` menerima `{ html, options }` + signature header; verifikasi HMAC + expiry.
  - Buka print route internal app (`INTERNAL_APP_URL/print/invoices/[id]?token=...`) atau menerima HTML inline (pilih: **fetch print route** agar token auth terpakai + HTML selalu dari app).
  - Playwright Chromium headless, `format: A4`, `printBackground: true`, margin aman, wait network idle.
  - Simpan PDF ke shared volume `/data/invoices/organizations/{orgId}/{year}/{safeFilename}.pdf`.
  - Return metadata: `{ storagePath, filename, sizeBytes, mimeType, sha256 }`.
  - Timeout (default 30s), retry terbatas (maks 3, backoff), logging jelas.
  - **Bukan screenshot** — HTML/CSS print agar teks tajam dan selectable.
- **Template Corporate Blue** (props accent dari profile `primaryColor`):
  - **Header**: kiri logo compact + nama perusahaan + alamat + WhatsApp/telepon/fax + email; kanan judul INVOICE + badge jenis + nomor + tanggal + referensi + tanggal PO + termin + jatuh tempo opsional.
  - **Bill To**: nama perusahaan, PIC, jabatan/divisi, alamat, kontak.
  - **Item table**: No, Deskripsi, Qty, Unit, Harga Satuan, Jumlah. Header berulang di halaman baru (`thead` + CSS `repeat`).
  - **Ringkasan** sesuai jenis invoice: Nilai Pekerjaan/PO, Sudah Ditagihkan, Down Payment/Termin, Diskon, PPN, Tambahan, Total Ditagihkan, Sisa Tagihan, Terbilang. Hide-zero rows jika profile settings memilih.
  - **Bawah**: informasi rekening (dari snapshot, nomor lengkap boleh tampil), notes (token ter-resolve), meterai + signature block, footer referensi, nomor halaman.
  - **Footer**: `Invoice ini dibuat berdasarkan Purchase Order {customer} Nomor {ref}.` atau `Invoice ini diterbitkan oleh {profile}.` + `Halaman {n} dari {total}` dari engine PDF (bukan statis).
  - **Multi-page**: A4 portrait, margin aman, header tabel berulang, item row tidak terpotong (break-inside avoid), deskripsi panjang wrap, total + signature sebisa mungkin bersama, footer setiap halaman, halaman 2+ tidak ulang seluruh header perusahaan berlebih, **tidak ada halaman kosong**, font container-safe (Inter + system), metadata PDF terisi, nama file aman.
  - **Meterai**: `NONE` (signature block rapi), `E_METERAI` (slot compact border dashed di kiri signature block, label `Slot E-Meterai`, proporsional, label bisa dimatikan, **bukan gambar palsu**), `PHYSICAL` (area meterai dalam signature area, guide halus optional ikut cetak), `BLANK_SPACE` (ruang kosong yang neat).
  - **Signature block**: nama, jabatan (show/hide), lokasi, tanggal, gambar tanda tangan opsional.
- **Storage**: `StorageService.saveInvoicePdf(buf, { orgId, year, filename })` → path, simpan record `InvoicePdf` (version, sha256, isOfficial).
- **Secure download**: route `/invoices/[id]/download` (`/api/invoices/[id]/pdf`) — authorization (org scope + permission), content-disposition attachment, filename aman, audit `PDF_DOWNLOADED`.
- **Filename**: `INV-SB-VII-2026-001.pdf` (dari nomor invoice, karakter aman).
- **Worker**: `modules/pdf/worker.ts` memproses PdfJob PENDING (poll interval, lock row, call pdf-service, update InvoicePdf, status SUCCESS/FAILED, attempt counter). Bisa dijalankan sebagai sidecar process di container app, atau interval di app process — pilih: **interval process di app container** (single instance, cukup untuk MVP).
- **PDF verification** (test): file valid, ukuran A4, page number benar, multi-page tidak kosong, header tabel berulang, grand total benar, terbilang benar, logo tidak terlalu besar, e-meterai compact, signature block tidak tabrakan, text tidak overflow (cek via `pdf-parse` + Playwright screenshot diff optional).

## Implementation

1. **Schema**: `InvoicePdf` fields (storagePath, sha256, sizeBytes, version, isOfficial, generatedById, generatedAt) + `PdfJob` update. Migration `invoice-pdf`.
2. **Print route** `app/print/invoices/[id]/route.ts`: token verification (HMAC + expiry), render HTML InvoiceRenderer (server component, snapshot data), minimal layout (no app chrome), print CSS.
3. **pdf-service** (`pdf-service/src/`): HTTP server minimal (Node http atau `hono`), `/health`, `/render` (signature verify → Playwright → write shared volume → return metadata), graceful shutdown.
4. **`modules/pdf/client.ts`**: `requestRender(invoiceId)` → signed token (HMAC + expiry 60s) → POST pdf-service `/render` → return metadata.
5. **`modules/pdf/worker.ts`**: poll PdfJob PENDING (interval 5s), lock via `UPDATE ... WHERE status='PENDING' LIMIT 1` (atomic), call client, simpan InvoicePdf, update job status, update invoice `pdfPath`.
6. **Download route**: authorization + content-disposition + audit.
7. **InvoiceRenderer print polish**: print CSS `@media print` (A4, margin, repeat thead, break rules, page number via CSS counter atau Playwright `displayHeaderFooter` — pilih Playwright footer template untuk `Halaman x dari y`).
8. **Docker**: compose pdf-service build dari `Dockerfile.pdf` (Playwright deps), shared volume `invoices`, internal network, healthcheck.
9. **Tests**: PDF verification suite (`pdf-parse` untuk text + page count), integration test issue → job → PDF ada.

## Dependencies

- Feature 04 (InvoiceRenderer, calculation, terbilang), Feature 05 (issue flow, PdfJob enqueue, snapshot).
- Playwright Chromium di container pdf-service; `pdf-parse` untuk test.

## Scope Limits

- **Tidak** ada template editor / template picker — Corporate Blue saja.
- **Tidak** ada gambar e-meterai resmi — slot placeholder saja (disclaimer di pengaturan).
- **Tidak** ada upload PDF custom / replace PDF — PDF resmi hanya dari issue flow.
- **Tidak** ada QRIS di PDF — defer.
- **Tidak** ada preview PDF interaktif (flipbook dll) — download file saja.
- Multi-currency: IDR saja, format `id-ID`.

## Check When Done

- [ ] Preview browser == PDF yang dihasilkan (satu InvoiceRenderer, perbedaan hanya media).
- [ ] pdf-service `/health` 200; `/render` tanpa signature → 401; signature kedaluwarsa → 401.
- [ ] pdf-service tidak reachable dari luar Docker network (cek port tidak di-expose di compose).
- [ ] Issue invoice → PdfJob PENDING → worker proses → InvoicePdf record + file di storage → invoice `pdfPath` terisi.
- [ ] Job gagal (mis. pdf-service mati) → retry maks 3, status FAILED, errorMessage jelas, invoice tetap ISSUED.
- [ ] Download PDF: butuh session + org scope + permission; tanpa auth → 401/404; response `Content-Disposition: attachment; filename="INV-SB-VII-2026-001.pdf"`.
- [ ] Audit `PDF_GENERATED` + `PDF_DOWNLOADED` tercatat.
- [ ] **PDF acceptance** (master prompt bagian 33 sample): badge `DOWN PAYMENT 50%`; item 5 unit × Rp900.000; nilai pekerjaan Rp4.500.000; total ditagihkan Rp2.250.000; terbilang "Dua juta dua ratus lima puluh ribu rupiah"; slot e-meterai compact di kiri; signature di kanan; logo compact; footer `Invoice ini dibuat berdasarkan Purchase Order PT Cipta Karya Nusantara Nomor 5198021181.`; `Halaman 1 dari 1`.
- [ ] **Multi-page**: invoice dengan banyak item (seed 30+ item) → halaman 2 ada header tabel berulang, footer `Halaman 2 dari 2`, tidak ada halaman kosong, item row tidak terpotong.
- [ ] PDF metadata terisi (Title invoice number, Author profile name).
- [ ] Text PDF selectable (bukan screenshot): `pdf-parse` bisa ekstrak "INV/SB/VII/2026/001".
- [ ] Snapshot immutability PDF: edit profile logo → PDF resmi lama tidak berubah (file tersimpan, tidak render ulang).
- [ ] Permission: STAFF+ bisa download; VIEWER bisa download jika diizinkan; org lain 404.
- [ ] E2E: issue → download → file valid (PDF magic bytes).
- [ ] Lint, typecheck, production build lulus; `docker compose up -d --build` semua service healthy.

## Commit and Push

This feature is only ready to commit after its `Check When Done` passes and the test suite is green.

1. Every item in `Check When Done` passes.
2. Tests pass (`npm run test`).
3. Lint and typecheck pass (`npm run lint`, `npm run typecheck`).
4. Ask which branch: **`main`** (recommended) atau new branch. Never commit silently.
5. Commit: `feat(06): invoice PDF — shared renderer, Corporate Blue template, pdf-service, storage, secure download`.
6. Push. Never force push.

## Progress Tracker

When this feature lands, update `context/progress-tracker.md`:

- Move `invoice-preview-pdf` from **Next Up** to **In Progress** at build start, then to **Completed** when `Check When Done` passes.
- Add to **Open Questions**: apakah Playwright `displayHeaderFooter` cukup untuk page number multi-page kompleks; apakah worker interval di app process cukup vs sidecar.
- Add to **Architecture Decisions**: pdf-service fetch print route dengan signed token (bukan inline HTML); Playwright footer template untuk page number; worker interval di app container; PDF official immutable (file stored, tidak render ulang).
- Add one line to **Session Notes**: "Feature 06 done: PDF rendering via pdf-service, Corporate Blue multi-page, secure download, snapshot-consistent PDF."
- Do not touch other features' rows.
