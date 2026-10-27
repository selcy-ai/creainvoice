# Feature 08: Dashboard & Invoice List

## Goal

Bangun dashboard user dan invoice list dengan server-side pagination/search/filter/sort serta row actions lengkap. Setelah feature ini, user memiliki "home" aplikasi dan bisa mengelola semua invoice dari satu halaman.

## Design

- **Dashboard** (`/dashboard`):
  - Cards: invoice bulan ini, total ditagihkan, total dibayar, outstanding, overdue, draft, jumlah customer.
  - Grafik ringkas tagihan vs pembayaran per bulan (12 bulan terakhir). Pakai chart library stabil (recharts) — ringkas, bukan dashboard penuh chart.
  - Recent activity timeline: invoice baru, issued, pembayaran, revisi, overdue.
  - Skeleton loading, empty state, responsive layout, permission-aware menu (sidebar item tampil sesuai role).
- **Invoice list** (`/invoices`):
  - Kolom: nomor invoice, tanggal, customer, referensi, jenis, grand total, status, due date, pembuat, aksi.
  - Server-side: pagination, search (nomor/customer), filter tanggal, filter customer, filter profile, filter status, filter jenis invoice, sort per kolom.
  - Row actions (permission-aware): preview, edit draft, duplicate, issue, download PDF, create settlement, mark sent, record payment, cancel, revise.
  - Confirmation dialog untuk aksi destruktif (cancel, delete draft).
  - TanStack Table untuk client state, data dari server (pagination mode).
- **Sidebar menu** (permission-aware): Dashboard, Invoice, Project / PO, Customer, Invoice Profile, Rekening Bank, Pembayaran, Anggota Tim, Pengaturan.
- **Topbar**: workspace switcher (dari feature 01), command search (`Cmd+K`) untuk navigasi cepat, theme toggle, profile dropdown.
- **Command search**: navigasi route + cari invoice by nomor (server query).

## Implementation

1. **`modules/invoices/query-service.ts`**: `listInvoices({ orgId, page, search, filters, sort })` → server-side query dengan Prisma `findMany` + `count` untuk total.
2. **Dashboard cards query**: aggregate per org (invoice bulan ini, sum grandTotal issued, sum amountPaid, sum outstanding, count overdue, count draft, count customer).
3. **Chart data query**: group by month (Prisma `groupBy` atau raw SQL dengan `date_trunc`), tagihan vs pembayaran.
4. **Recent activity**: query AuditLog + invoice events, timeline component.
5. **UI**: dashboard cards (shadcn Card), chart (recharts), table (TanStack Table + shadcn table), filter bar, row action dropdown, confirmation dialog.
6. **Row actions**: panggil service yang sudah ada di feature 04/05/06/07 — **tidak** membuat service baru.
7. **Permission-aware menu**: hide item berdasarkan role (VIEWER tidak lihat Anggota Tim/Pengaturan).
8. **Empty state** per filter combination (bukan blank).

## Dependencies

- Feature 01 (layout shell, permission, workspace switcher), Feature 04 (invoice draft), Feature 05 (lifecycle actions), Feature 06 (PDF download), Feature 07 (payment status).
- `recharts` (chart library stabil).

## Scope Limits

- **Tidak** ada chart custom kompleks / dashboard customizable — ringkas saja.
- **Tidak** ada export CSV/Excel invoice list — defer.
- **Tidak** ada saved filter / saved view — defer.
- **Tidak** ada bulk action (checkbox multiple invoice) — defer.
- **Tidak** ada invoice list super admin (lintas org) — feature 09 adalah monitoring, bukan list operasional.

## Check When Done

- [ ] Dashboard cards menampilkan angka benar untuk org session (seed data: invoice bulan ini > 0 setelah seed acceptance).
- [ ] Grafik tagihan vs pembayaran per bulan render, ada data (atau empty state jelas jika kosong).
- [ ] Recent activity timeline menampilkan 5 event terbaru.
- [ ] Invoice list: server-side pagination berfungsi (page 1 → 2, total record benar).
- [ ] Search "Cipta" / nomor invoice men-filter list.
- [ ] Filter status + jenis + customer + profile + tanggal range berfungsi secara kombinasi.
- [ ] Sort per kolom (tanggal, grand total, nomor) berfungsi.
- [ ] Row actions sesuai permission: VIEWER hanya preview/download; STAFF edit/issue/duplicate/mark sent/record payment; OWNER/ADMIN + cancel/revise.
- [ ] Confirmation dialog untuk cancel & delete draft.
- [ ] Empty state tampil saat filter hasil 0 (bukan blank page).
- [ ] Sidebar menu permission-aware (VIEWER tidak lihat Anggota Tim).
- [ ] Command search `Cmd+K` navigasi + cari invoice.
- [ ] Dashboard responsive (mobile grid collapse).
- [ ] Skeleton loading tampil saat data loading.
- [ ] Org isolation: dashboard + list hanya data org session.
- [ ] Lint, typecheck, production build lulus.

## Commit and Push

1. Every item in `Check When Done` passes.
2. Tests pass (`npm run test`).
3. Lint and typecheck pass (`npm run lint`, `npm run typecheck`).
4. Ask which branch: **`main`** (recommended) atau new branch. Never commit silently.
5. Commit: `feat(08): dashboard cards + activity + invoice list server-side with row actions`.
6. Push. Never force push.

## Progress Tracker

When this feature lands, update `context/progress-tracker.md`:

- Move `dashboard-invoice-list` from **Next Up** to **In Progress** at build start, then to **Completed** when `Check When Done` passes.
- Add to **Open Questions**: apakah recharts atau chart lain lebih ringan; apakah export CSV perlu sebelum GA.
- Add to **Architecture Decisions**: server-side pagination/filter via query-service; row actions reuse service feature sebelumnya (no new service); permission-aware menu.
- Add one line to **Session Notes**: "Feature 08 done: dashboard cards+chart+activity, invoice list pagination/search/filter/sort, row actions, command search."
- Do not touch other features' rows.
