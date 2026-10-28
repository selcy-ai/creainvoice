# Change 14 — Swap Clerk → better-auth (self-hosted, no vendor lock-in)

## Goal

Mencopot total ketergantungan Clerk dari creainvoice dan menggantinya dengan better-auth yang berjalan di database sendiri ( Neon via Drizzle ), sehingga aplikasi 100% self-hosted dan siap deploy ke Dokploy tanpa layanan auth eksternal maupun webhook publik. Skema multi-tenant ( `organizations` + `memberships` + `invoiceProfiles` ) tetap seperti adanya; hanya sumber otoritas yang berpindah.

## What This Changes

### Sumber kebenaran auth ( `src/lib/clerk.ts` )

- **Status quo:** Session dibaca dari Clerk ( `auth()` + `currentUser()` dari `@clerk/nextjs/server` ); organisasi dibuat lewat `clerkClient().organizations.createOrganization`; keanggotaan dicerminkan ke lokal oleh webhook.
- **New state:** Session dibaca dari better-auth ( `auth.api.getSession()` ) pada tabel Drizzle `users` + `sessions` lokal; organisasi dibuat dengan INSERT langsung ke `organizations` + `memberships`; tidak ada pencerminan — lokal adalah satu-satunya sumber.

### Middleware / proxy ( `src/proxy.ts` )

- **Status quo:** `clerkMiddleware` dari `@clerk/nextjs/server` dengan `createRouteMatcher` ( `/login(.*)` public, sisanya diproteksi ), `signInUrl: "/login"`.
- **New state:** Middleware baca session cookie better-auth ( pico-safe read via `auth.api.getSession({ headers })` ) dan melakukan proteksi route yang sama dengan keputusan redirect identik.

### Halaman login ( `src/app/(auth)/login/[[...rest]]/page.tsx` + layout )

- **Status quo:** Merender `<SignIn />` dari Clerk ( client-side, instance dev menolak origin LAN ).
- **New state:** Merender form login server-rendered milik aplikasi ( email + password ) yang memPOST ke route handler better-auth `/api/auth/[...all]`, dengan UI mengikuti token v4 ( layout `(auth)/layout` + kartu yang sudah ada tetap dipakai, hanya isi form yang diganti ). Tambahkan halaman sign-up `src/app/(auth)/register/page.tsx`.

### Webhook ( `src/app/api/clerk/webhook/route.ts` )

- **Status quo:** Menerima event Clerk ( user.created, organization.*, organizationMembership.* ) lewat Svix signature dan menulis ulang baris `users`/`organizations`/`memberships`.
- **New state:** **Dihapus seluruhnya.** Env `CLERK_WEBHOOK_SIGNING_SECRET` dihapus dari `src/server/env.ts`, `docker-compose.yml`, dan `.env.local`.

### Session helper ( `src/lib/clerk.ts` → `src/lib/auth.ts` )

- **Status quo:** `getSession()` / `requireSession()` membungkus Clerk `auth()`; `AuthSession` { userId, orgId, isAuthenticated, user }.
- **New state:** File diganti namanya ke `src/lib/auth.ts` dengan bentuk `AuthSession` yang **identik** ( signature tetap `{ userId, orgId, isAuthenticated, user }` ) — 34 file konsumen (`modules/*/actions.ts`, `app/(dashboard)/*`, `workspace/service.ts`) tetap compiling tanpa perubahan signature. `orgId` aktif dibaca dari `memberships` aktif ( default ke membership pertama saat login; switcher tetap bekerja melalui session cookie kustom yang better-auth keluarkan ).

### Env & Docker ( `src/server/env.ts`, `docker-compose.yml`, `Dockerfile` )

- **Status quo:** Wajib `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SIGNING_SECRET`; compose menolak start tanpa kunci tersebut.
- **New state:** Kunci Clerk dihapus; ditambah `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `BETTER_AUTH_TRUSTED_ORIGINS` ( pola identik invoice-me: `http://localhost:3000,http://127.0.0.1:3000,http://192.168.1.100:3000` + origin deploy Dokploy saat tersedia ). `@clerk/nextjs` di-uninstall; `better-auth` ditambahkan.

### Onboarding ( `src/modules/onboarding/actions.ts`, langkah 1 )

- **Status quo:** Langkah 1 memanggil `clerkClient().organizations.createOrganization({ name, createdBy })` — **sumber error terakhir Anda: fitur Organizations tidak aktif di instance.**
- **New state:** Langkah 1 INSERT ke `organizations` + `memberships` ( role admin ) via Drizzle dalam transaksi; organisasi langsung aktif tanpa ketergantungan instance pihak ketiga.

### Skema database ( `src/db/schema.ts` )

- **Status quo:** `users.id` diisi ID Clerk ( `user_...` ); tidak ada kolom password; tidak ada tabel `sessions`.
- **New state:** Ditambah tabel `sessions` ( id, userId, expiresAt, token — sesuai kontrak better-auth ) dan kolom kredensial pada `users` ( `passwordHash`, opsional `emailVerifiedAt` ). `organizations` + `memberships` **tidak berubah** — struktur multi-tenant tetap. Skema `invoiceProfiles` tetap mengikat `organizationId`.

## Design

- **better-auth instance tunggal** di `src/lib/auth.ts` ( bukan `clerk.ts` ): email + password, session cookie `HttpOnly`, `trustedOrigins` dari env, plugin admin opsional **tidak dipakai** ( role lokal tetap di kolom `users.role` yang sudah ada ).
- **Route handler catch-all** `src/app/api/auth/[...all]/route.ts` mengekspor handler better-auth ( `{ GET, POST }` ) — pola resmi Next.js App Router.
- **Password hashing bcrypt/argon2** pilihan builder ( argon2 direkomendasikan ), diverifikasi via test.
- **`AuthSession` bentuk tetap** — kontrak yang dimakan 34 file tidak boleh berubah. Ini memastikan blast radius terbatas pada helper + UI login + onboarding.
- **Register + login server page**, UI mengikuti kartu v4 yang sudah ada ( `bg-card`, `rounded-xl`, token v4 ) — form dikirim ke `/api/auth/sign-in` / `/api/auth/sign-up` bawaan better-auth, tetapi dengan tampilan sendiri.
- **Session org aktif**: saat login, `orgId` = membership ACTIVE pertama; `workspace-switcher` menukar dengan menyimpan organisasi aktif ke record session ( kolom `sessions.activeOrganizationId` ). ini menggantikan session claim Clerk `orgId`.
- **role superadmin**: `users.role` lokal sudah ada ( `USER` / `SUPER_ADMIN` ) — diisi manual lewat seed/CLI admin, tidak ada area dashboard admin yang berubah.
- **Trusted origins**: pola invoice-me — host LAN masuk whitelist agar login dari HP di LAN jalan ( apha tujuan #1 Anda ).

## Implementation

1. `npm uninstall @clerk/nextjs && npm i better-auth argon2`
2. Buat `src/lib/auth.ts` ( better-auth instance + `AuthSession` helper: `getSession`/`requireSession` bentuk identik ).
3. Tambah tabel `sessions` + kolom users ( passwordHash, emailVerifiedAt, activeOrganizationId di sessions ) di `src/db/schema.ts`; `drizzle-kit push` ke Neon.
4. Buat `src/app/api/auth/[...all]/route.ts` ( handler better-auth ).
5. Hapus `src/app/api/clerk/webhook/route.ts`; update `src/proxy.ts` ke middleware baca-session-better-auth.
6. Rework halaman login + tambah halaman register ( UI v4, kartu yang ada ).
7. Update `src/modules/onboarding/actions.ts` langkah 1 → INSERT lokal.
8. Update `workspace-switcher` + `app-shell` baca membership lokal ( tidak ada Clerk `useOrganization` ).
9. Update `src/server/env.ts` + `docker-compose.yml` + `Dockerfile` + `.env.local` ( hapus Clerk env, tambah better-auth env ).
10. Update semua 34 file konsumen jika signature `AuthSession` ternyata butuh penyesuaian ( target: nol perubahan, verifikasi lewat typecheck ).
11. Hapus semua tes yang mengejek Clerk, ganti dengan tes better-auth ( login, register, org creation, IDOR tetap hijau ).
12. Seed admin: `admin@creainvoice.id` + password dari env `SEED_ADMIN_PASSWORD` ( tulis ke `.env.local`, bukan ke repo ).

## Dependencies

- **Depends-On:** 13 ( repo creainvoice saat ini head-of-trunk; ini melanjutkannya )
- Pustaka baru: `better-auth`, `argon2` ( atau `bcryptjs` )
- Tidak ada perubahan: `invoiceProfiles`, `invoices`, `customers`, `bankAccounts`, `signers`, `payments`, `auditLogs` — semua tetap org-scoped seperti sekarang.

## Blast Radius

### BR-1: Security standards ( `context/security-standards.md` )

- **Konsekuensi:** Berkas menyebut session cookie HttpOnly + org scoping dari session membership — aturan不法 berlaku, tapi seluruh referensi implisit "session dari Clerk" menjadi tidak lagi akurat; standar auth sekarang dipenuhi oleh better-auth ( cookie HttpOnly + SameSite, logout mengakhiri session server-side tetap berlaku — better-auth menghapus record `sessions` ).
- **Solusi:** Edit `context/security-standards.md` tambahkan satu baris: "Auth provider: better-auth ( self-hosted ); session disimpan di tabel `sessions`, tidak ada pihak ketiga."
- **Pencegahan:** Lakukan **sebelum** build, agar builder membaca kontrak baru sebelum menulis kode auth.

### BR-2: Feature spec 01-auth-multi-tenant ( `context/feature-specs/01-auth-multi-tenant.md` )

- **Konsekuensi:** Spesifikasi fitur awal menggambarkan auth better-auth + multi-tenant — spesifikasi ini menjadi **referensi kembali yang akurat** ( Change 14 mengembalikannya ); namun seluruh referensi Clerk pada spec 13 kini kedaluwarsa.
- **Solusi:** Tandai di `context/progress-tracker.md`: "Change 14 mengembalikan implementasi ke better-auth; spec 01 kembali jadi referensi multi-tenant, spec 13 Clerk dipensiunkan ( tetap dipertahankan untuk sejarah )."
- **Pencegahan:** Tidak ada regenerasi spec — tidak ada perubahan kebutuhan, hanya implementasi.

### BR-3: 34 file konsumen session ( `modules/*/actions.ts`, `app/(dashboard)/*`, `workspace/service.ts` )

- **Konsekuensi:** Semua halaman dan aksi membaca `AuthSession` dari `src/lib/clerk.ts`. Jika signature tetap ( rencana ini memastikan tetap ), nol perubahan; jika tidak, ini menjadi titik gagal terbesar.
- **Solusi:** Pertahankan signature `{ userId, orgId, isAuthenticated, user }` persis; verifikasi dengan `npm run typecheck` ( harus 0 error ) — typecheck adalah penggarisnya, bukan review manual.
- **Pencegahan:** Jalankan `npm run typecheck` setelah langkah 2 ( helper ), sebelum menyentuh UI; merah di sini berarti helper menyimpang — hentikan dan luruskan.

### BR-4: Tes yang mengejek Clerk ( `tests/**` )

- **Konsekuensi:** Tes yang memmock `@clerk/nextjs/server` akan gagal kompilasi setelah paket di-uninstall; tes integrasi yang memalsukan ctx `userId` Clerk tetap valid ( ctx.scope bersumber dari lokal ).
- **Solusi:** Ganti mock Clerk dengan helper test yang memanggil service login better-auth sungguhan ( buat user di DB test ) — sesuai pola invoice-me `tests/helpers/auth.ts`.
- **Pencegahan:** Inventarisasi dulu `grep -rln '@clerk' tests/` **sebelum** uninstall; tulis ulang mocknya lebih dulu, baru uninstall paket.

### BR-5: Environment Docker & `.env.local` ( `docker-compose.yml`, `Dockerfile`, `.env.local` )

- **Konsekuensi:** Compose menolak start tanpa 3 kunci Clerk ( `:?` required ); setelah uninstall, start gagal. Kredensial admin seed butuh password yang harus di-generate.
- **Solusi:** Ganti required keys: `BETTER_AUTH_SECRET:?`, `BETTER_AUTH_URL`, `BETTER_AUTH_TRUSTED_ORIGINS`, `SEED_ADMIN_PASSWORD:?`; generate secret lewat `openssl rand -base64 32` ke `.env.local` lokal.
- **Pencegahan:** Lakukan perubahan env bersamaan dengan langkah 9; uji `docker compose config` sebelum build pertama.

### BR-6: Halaman login &branding UI ( `src/app/(auth)/` )

- **Konsekuensi:** `<SignIn />` hapus; layout `(auth)/layout` ( branding CreaInvoice + tagline ) tetap dipakai, isi kartu diganti form milik sendiri; catch-all `[[...rest]]` dapat dihapus ( tidak ada lagi sub-route pihak ketiga ).
- **Solusi:** Form sederhana server action / POST ke route better-auth; styling tombol & input memakai token v4 yang ada ( `bg-card`, `rounded-xl`, `border-border` ); sesuaikan `antislop-ui` ( blur maksimal 1-2 elemen, no emoji, tabular-nums ).
- **Pencegahan:** Review visual ( screenshot ) setelah build — pastikan jika hasilnya tetap sesuai v4.

### BR-7: Sesuai UI context ( `context/ui-context.md` )

- **Konsekuensi:** Token v4 tetap, tidak ada perubahan; hanya tambahan komponen form login.
- **Solusi:** Tidak ada edit standar UI.
- **Pencegahan:** Cek `## Design Reference` — halaman login sudah ada, tidak ada mockup baru yang diperlukan ( bentuk form mengikuti kartu/layout yang ada ).

## Scope Limits

- **Ditangguhkan:** SSO/OAuth ( Google, GitHub ) — better-auth mendukung tapi di luar cakupan ini; fitur utuh email+password sudah berdiri. ( alasan: lingkup ubah auth sudah 20 file; SSO menambah konfigurasi provider + UI tambahan, layakke feature tersendiri ).
- **Ditangguhkan:** Password reset via email — butuh SMTP ( gunakan kredensial yang Anda miliki, atau lanjut ke feature tersendiri ). ( alasan: mencegah utang SMTP menghalangi tujuan utama: self-hosted siap pakai ).
- **Ditangguhkan:** Magic link / passkey — feature tersendiri.
- **Tidak diubah:** struktur multi-tenant, skema invoice/profile/customer/bank/signer/payment, UI v4 lainnya, PDF engine, role superadmin lokal.

## Check When Done

Setiap item harus dapat diverifikasi dengan menjalankan sesuatu, bukan dengan membaca kode. Minimal satu item membuktikan perilaku yang ada tetap bekerja.

- [ ] `npm run typecheck` → 0 error ( bukti signature `AuthSession` tidak menyimpang dari 34 konsumen ).
- [ ] `npm run lint` → 0 error ( warning pre-existing 12 tetap dapat diterima ).
- [ ] `npm run test` → **608/608+ hijau** ( tes yang diganti tetap memenuhi angka, tidak ada yang dihapus tanpa pengganti ).
- [ ] `grep -rln '@clerk' src/ tests/` → **kosong** ( dependensi Clerk benar-benar hilang ).
- [ ] `docker compose config` valid + `Dockerfile` build success ( `docker build -t ci14 .` ).
- [ ] `next build` PASS, `npm run dev` jalan, `/login` merender form lokal ( **tanpa** komponen eksternal ), `/register` tersedia.
- [ ] **Login sungguhan**: buat user via `/register`, POST kredensial, verifikasi cookie session lokal ter-set ( `curl -i` menampilkan `Set-Cookie: better-auth.session_token` ), dan akses `/dashboard` merender data ( bukan redirect ke login ).
- [ ] **Register + onboarding**: user baru menyelesaikan langkah 1 ( buat organisasi "PT Uji" ), baris `organizations` + `memberships` tercipta di Drizzle, error "organisasi tidak aktif" tidak muncul lagi.
- [ ] **Multi-tenant tetap bekerja** ( regression guard untuk fitur 01 ): buat 2 organisasi, masing-masing buat 1 invoice, verifikasi invoice hanya terlihat pada organisasi pemiliknya ( response API/DB bukan tampilan ) — perilaku utama yang TIDAK boleh berubah.
- [ ] **IDOR guard tetap bekerja** ( regression guard ): request invoice milik organisasi lain → 404 ( bukan 200/leak ) — sesuai `security-standards.md` baris 20.
- [ ] **Login dari LAN IP**: dari `http://192.168.1.100:3000/login` di browser ( via tunnel LAN atau langsung ), form muncul + login sukses — kredensial self-hosted tidak ditolak karena origin ( perbaikan masalah utama Anda ).
- [ ] `docker compose up -d --build` → app service healthy ( `/health` 200 ).

## Commit and Push

Perubahan ini hanya siap di-commit setelah `Check When Done` lulus dan suite tes hijau. Tidak sebelum, tidak dengan janji memperbaikinya nanti.

Urutannya tetap:

1. Setiap item `Check When Done` lulus, termasuk regression guard.
2. Tes lulus ( `npm run test` ).
3. Lint dan typecheck lulus ( `npm run lint`, `npm run typecheck` ).
4. Commit ke `main` ( strategi trunk-based bundle ini — tidak perlu ditanya lagi ).
5. Commit dengan pesan yang menyebut perubahan: `feat(auth): swap Clerk to self-hosted better-auth (Neon+Drizzle, multi-tenant preserved)`.
6. Push ke `main`. Jangan force push.

## Progress Tracker

Ketika perubahan ini land, perbarui `context/progress-tracker.md`. Bagian ini wajib: tanpa ini obrolan selanjutnya dimulai buta.

- Tambah `Change 14 — better-auth self-hosted` di bawah **Completed** saat `Check When Done` lulus, termasuk regression guard.
- Tambah ke **Open Questions**: `BETTER_AUTH_TRUSTED_ORIGINS` origin deploy Dokploy belum diketahui — engineer isi saat domain Dokploy tersedia; `SEED_ADMIN_PASSWORD` perlu rotasi setelah login pertama.
- Tambah ke **Architecture Decisions**: `Auth provider = better-auth ( self-hosted, Drizzle sessions )` — menggantikan keputusan Clerk feat-13; alasan: vendor lock-in (#3) + target deploy Dokploy (#4). Multi-tenant tetap ( skema organisasi tidak berubah ).
- Tambah satu baris ke **Session Notes**: Change 14 memensiunkan Clerk; spec 01 kembali jadi referensi auth, spec 13 tetap dipertahankan untuk sejarah; user "Thehars" di Clerk instance dev tidak dimigrasi — daftar ulang via `/register`.
