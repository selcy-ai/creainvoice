# Security Standards

Non negotiable rules. Every feature spec inherits these; a feature may add to them but never relax them. If a spec contradicts this file, this file wins.

## Auth and Session

- Login dengan username **atau** email + password via Better Auth. **Public sign-up diaktifkan** ( Change 14: self-hosted, siapa saja bisa daftar di `/register`; wajib verifikasi email sebelum bisa login ).
- Session cookie: `HttpOnly`, `Secure` di production, `SameSite`. Remember session opsional (extended expiry).
- **Rate limit login**: maksimal percobaan gagal beruntun per username+IP, lalu **lockout sementara** (durasi escalating). Login berhasil/gagal tercatat di audit log.
- **Force password change**: saat login pertama (password dari admin) atau setelah admin reset password. User tidak bisa pakai temporary password untuk akses fitur.
- Admin membuat user dengan temporary password; user dipaksa ganti. Halaman akun dinonaktifkan (admin-side managed).
- Halaman "lupa password" menjelaskan untuk menghubungi admin (MVP). Struktur kode siap integrasi SMTP nanti.
- Password tidak pernah disimpan atau ditampilkan plaintext. Hash via Better Auth (bcrypt/argon2).
- Logout mengakhiri session server-side, tidak hanya menghapus cookie.

## Authorization

- **Org scoping wajib**: setiap query/mutation data bisnis harus di-scope `organizationId` dari session membership aktif. Tidak ada exception untuk user biasa.
- **Central permission service** (`modules/permissions`): satu fungsi `can(action, resource, ctx)`. Role string (`OWNER`/`ADMIN`/`STAFF`/`VIEWER`) hanya hidup di satu tempat (matrix permission), tidak disebar sebagai perbandingan string acak di banyak file.
- **Cegah IDOR**: resource id yang direquest diverifikasi kepemilikannya terhadap org session. `getInvoice(id, ctx)` → 404 jika bukan milik org session, bukan leak data.
- **Super admin** (`SUPER_ADMIN` platform role) dapat melihat data lintas org untuk support, **tetapi setiap view sensitif dan download tercatat di audit log**.
- Matrix role organization:
  - **OWNER** — seluruh akses org: kelola anggota, profile, hapus draft, issue, batalkan, lihat laporan.
  - **ADMIN** — sama dengan owner kecuali hapus organization dan pindah kepemilikan.
  - **STAFF** — buat/edit draft, kelola customer & PO (jika diizinkan), preview, ekspor. Tidak boleh ubah pengaturan sensitif, tidak boleh hapus invoice resmi.
  - **VIEWER** — hanya lihat dan unduh invoice yang diizinkan.
- Mutation penting (issue, cancel, revise, payment, user management) wajib lewat service layer yang memanggil permission service.

## Input Validation

- **Zod di boundary**: setiap form (client) dan API route handler (server) memvalidasi input sebelum logic runs.
- Server tidak mempercayai input client. Termasuk total uang, persentase, dan id resource.
- **Upload**: validasi MIME dari **isi file** (magic bytes/sniffing), bukan hanya ekstensi. Maksimal `UPLOAD_MAX_MB` (2 MB). Filename random (`crypto.randomUUID`), nama asli tidak dipercaya. Hanya tipe yang diizinkan (PNG/JPEG/WebP untuk logo, PDF untuk PO reference, image untuk bukti pembayaran).
- **Path traversal prevention**: path file selalu dibangun dari `organizationId` (dari session) + random filename, tidak pernah dari input user string.
- Pagination limit wajib (cegah `limit=999999`).

## Secrets and Environment

- Semua secret dari env: `BETTER_AUTH_SECRET`, `INTERNAL_PDF_SECRET`, `BANK_ACCOUNT_ENCRYPTION_KEY`. **Tidak pernah hardcoded, tidak pernah di log.**
- Production values set di Coolify dashboard, tidak pernah di repo. `.env.local` gitignored (dev only).
- Env validation saat startup (Zod schema): app **fail-fast** jika variable wajib hilang.
- **Tidak ada secret di client bundle.** `NEXT_PUBLIC_*` hanya untuk nilai non-rahasia (APP_URL public).
- pdf-service request ditandatangani `INTERNAL_PDF_SECRET` dengan token berumur pendek (HMAC + expiry), divalidasi server-side.

## Data Protection

- **Nomor rekening encrypt at rest** (`BANK_ACCOUNT_ENCRYPTION_KEY`). Simpan ciphertext + `accountNumberLast4`. Nomor lengkap hanya tampil di invoice dan halaman berizin; di list/menu lain tampil masked (`**** **** 3449`).
- **PII** (NPWP, data customer, kontak) ditangani sebagai data sensitif: tidak di log, tidak di audit metadata mentah, akses terbatas role.
- **Log sanitization**: audit metadata disanitasi sebelum disimpan (tidak ada password, token, nomor rekening lengkap).
- **Audit log** wajib untuk 22 action (lihat feature 11 / `data-model.md`).
- Password/token/rekening tidak masuk JSON response atau error message.
- Health endpoint tidak membocorkan secret atau detail infra internal.

## Compliance

- **UU PDP (Indonesia)**: data pribadi (nama, kontak, NPWP) adalah data pribadi yang dilindungi. Dasar pemrosesan: hubungan kontrak (pemrosesan invoice). Retensi data mengikuti ketentuan kontrak+aturan perpajakan (10 tahun untuk dokumen pajak).
- **Cookie consent**: banner/notice minimal (cookie session esensial + analytics non-esensial jika diaktifkan).
- **Privacy policy + terms**: halaman publik minimal (rute `/privacy` dan `/terms`) menjelaskan data yang diproses. Disediakan di feature 11.
- **Pengguna EU**: jika ada, GDPR fallback. Tidak ada transfer data keluar self-hosted infra (semua lokal di host pengguna), sehingga data residency terpenuhi secara default.
- **PCI**: tidak berlaku — aplikasi tidak memproses kartu kredit. Nomor rekening bukan card data.
- **Hak subjek data**: struktur kode siap export/hapus data per organization (defer implementasi full DSR ke luar MVP, catat di progress-tracker open questions).

## Security Checklist (per feature)

Every feature spec must be able to answer these. Any "no" is either a scope limit stated in the spec, or a gap.

- [ ] Does it authenticate before reading?
- [ ] Does it authorize before mutating?
- [ ] Is all external input validated at the boundary?
- [ ] Are secrets read from env, never hardcoded or logged?
- [ ] Does it log without leaking secrets or PII?
- [ ] Are errors handled without leaking internals?
