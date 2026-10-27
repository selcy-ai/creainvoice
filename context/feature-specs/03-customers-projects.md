# Feature 03: Customers & Projects/PO

## Goal

Bangun modul master data: customer + PIC (contact) dan ProjectReference (PO/SPK/Contract/Quotation) sebagai dasar penagihan. Setelah feature ini, user bisa mengelola customer dan project, dan saat membuat invoice dari project, data terisi otomatis + sistem menghitung sudah/belum ditagihkan.

## Design

- **Customer** (`/customers`): CRUD lengkap sesuai `data-model.md` — companyName, legalName, businessType, taxId (NPWP), alamat lengkap, kontak, catatan internal, status aktif, soft delete.
- **CustomerContact / PIC**: satu customer banyak PIC (nama, jabatan, divisi, email, WhatsApp, telepon, isPrimary). Saat invoice, pilih customer + PIC → data terisi otomatis.
- **ProjectReference** (`/projects`): referenceType (PURCHASE_ORDER / SPK / CONTRACT / QUOTATION / OTHER / NONE), referenceNumber, referenceDate, title, description, workValue, currency, startDate, endDate, status, attachmentPath (upload PO file), notes.
- **Perhitungan tagihan**: `billedToDate(projectId)` = Σ billingBase invoice ISSUED (bukan CANCELLED, bukan REVISED) yang terlink project ini. `remaining = workValue − billedToDate`. Tampil di project detail + dipakai saat create invoice dari project.
- **Create invoice dari project** (preparation, UI penuh feature 04): endpoint/service `prefillFromProject(projectId)` → return `{ customerId, referenceNumber, referenceDate, workValue, items }`. Di feature ini hanya service-nya, UI pemanggilan ada di feature 04.
- **Upload PO reference file**: PDF/image, max 2MB, MIME sniff, random filename.
- **Permission**: STAFF+ bisa CRUD customer & project; VIEWER read-only. Org scoped.

## Implementation

1. **Schema migration**: `Customer`, `CustomerContact`, `ProjectReference` + index. Migration `customers-projects`.
2. **`modules/customers/service.ts`**: CRUD + soft delete + list dengan pagination server-side + search.
3. **`modules/projects/service.ts`**: CRUD + list dengan pagination/search. **`billedToDate` (sudah ditagihkan per project) TIDAK diimplementasi di feature ini** — baru muncul di feature 05 setelah table Invoice ada. Project detail menampilkan workValue dan baris "Sudah ditagihkan" yang mengacu ke feature 05 secara eksplisit (placeholder jujur, bukan angka 0 yang menyamar sebagai fitur). **Alasan: jangan membuat forward reference table Invoice sebelum feature 04/05**, dan jangan menampilkan angka yang belum dihitung.
4. **Halaman**: `/customers` list (TanStack Table, server pagination/search), `/customers/new`, `/customers/[id]` (edit + tab PIC), `/projects` list, `/projects/new`, `/projects/[id]` (detail + attachment).
5. **Form**: React Hook Form + Zod. Field NPWP tampil masked optional (PII).
6. **Audit**: customer created/updated/deleted, project created/updated.

## Dependencies

- Feature 01 (auth, org, permission, audit, layout).
- Feature 02 (storage service).
- `data-model.md` untuk Customer/CustomerContact/ProjectReference.

## Scope Limits

- **Tidak** membuat invoice — feature 04.
- **Tidak** menghitung billedToDate di feature ini (feature 05, setelah invoice table ada). Project detail menampilkan placeholder jujur, bukan angka 0 yang menyamar.
- **Tidak** ada item pekerjaan (work item) di project — defer (master prompt menyebut opsional).
- **Tidak** ada export customer CSV — defer.
- **Tidak** ada merge customer / duplicate detection — defer.

## Check When Done

- [ ] CRUD customer lengkap: create, read, update, soft delete (delete tidak hard delete, bisa dilihat di audit).
- [ ] CRUD PIC per customer; PIC primary bisa di-set; delete customer soft-delete contact juga.
- [ ] CRUD ProjectReference dengan semua referenceType; upload PO file diterima (PDF/image), >2MB ditolak, MIME palsu ditolak.
- [ ] List customer & project: server-side pagination + search berfungsi.
- [ ] Search "Cipta" menemukan customer seed.
- [ ] Permission: VIEWER tidak bisa create/update (403), STAFF bisa.
- [ ] Org isolation: user org A tidak bisa lihat customer org B (404 via IDOR guard).
- [ ] NPWP tidak muncul di log atau audit metadata.
- [ ] Audit log: customer created/updated/deleted + project created/updated tercatat.
- [ ] Integration test: CRUD flow dengan test DB + org isolation.
- [ ] Lint, typecheck, production build lulus.

## Commit and Push

1. Every item in `Check When Done` passes.
2. Tests pass (`npm run test`).
3. Lint and typecheck pass (`npm run lint`, `npm run typecheck`).
4. Ask which branch: **`main`** (recommended) atau new branch. Never commit silently.
5. Commit: `feat(03): customers + PIC + project/PO reference module`.
6. Push. Never force push.

## Progress Tracker

When this feature lands, update `context/progress-tracker.md`:

- Move `customers-projects` from **Next Up** to **In Progress** at build start, then to **Completed** when `Check When Done` passes.
- Add to **Open Questions**: apakah "item pekerjaan" di project perlu sebelum GA; apakah billedToDate perlu tampil di project detail sebelum feature 05.
- Add to **Architecture Decisions**: soft delete customer; billedToDate defer ke feature 05 (tidak forward reference invoice table).
- Add one line to **Session Notes**: "Feature 03 done: customer+PIC CRUD, project/PO CRUD, PO attachment upload, org-scoped."
- Do not touch other features' rows.
