# Change 6 — creainvoice: Clerk auth + Neon/Drizzle + rebrand + repo move

## Goal

Pindahkan invoice-me menjadi **creainvoice**: auth beralih dari better-auth ke **Clerk** ( dengan Organizations ), ORM dari Prisma ke **Drizzle** dengan database **Neon** Postgres, semua referensi personal dan merek lama diganti dengan data netral, seluruh branding `invoice-me` diganti `creainvoice`, dan repository dipindahkan dari `maulanaadib/invoice-me` ke `selcy-ai/creainvoice` (history penuh).

## What This Changes

### 1. Identitas dan branding ( seluruh repo )
- **Status quo:** nama project `invoice-me`, remote `maulanaadib/invoice-me`, 114 file memuat string `invoice-me`/`Invoice Me`, docker-compose service `invoice-me-*`, DATABASE_NAME `invoice_me`, judul app, metadata.
- **Setelah:** nama project `creainvoice` ( satu kata, seragam ) di package.json, docker-compose, env, metadata, UI copy, README. Remote satu-satunya `https://github.com/selcy-ai/creainvoice.git` ( sudah dilakukan orchestrator: repo dibuat, history dipush, `git remote set-url` selesai ).
- **Kaidah branding:** `creainvoice` ( lowercase satu kata ) untuk identifier, service, dan repo. `CreaInvoice` untuk judul manusia di UI. String `Invoice Me`/`invoice me` dihapus total.

### 2. Data personal dan merek lama ( 105 referensi )
- **Status quo:** nama pendiri, nama kontak, nama perusahaan customer lama, email domain lama, dan nama brand lama tersebar di `prisma/seed.mjs`, unit test, feature spec, docs, dan audit notes ( 105 referensi ).
- **Setelah:** **semua** data personal diganti dengan persona fiktif netral branding creainvoice: organisasi demo **CreaInvoice Studio**, user demo **admin@creainvoice.id** / password admin123, pelanggan demo **PT Cipta Karya Nusantara**, kontak **Andi Wijaya**, domain `creainvoice.id`. Gunakan `token ini` sebagai sumbernya.
- **Termasuk:** file `context/*` ( audit notes, feature spec yang memuat nama lama ), test fixtures, seed.

### 3. Auth: better-auth → Clerk
- **Status quo:** better-auth dengan server-side session, lockout store, suspension, audit login, admin plugin, organization + membership lokal, `PlatformRole` SUPER_ADMIN, halaman `/admin/*` platform-level.
- **Setelah:** **Clerk** mengelola auth ( sign-in/up/Organizations/invitations ). `@clerk/nextjs` dipasang dengan app `app_3LF40VVKeESi40CqagUuxiBaq5X`. Session dibaca via `auth()`, organisasi Clerk sync ke database lewat **webhook** ( `user.created`, `organizationMembership.created`, `user.deleted` ).
- **Konsekuensi wajib:** user existing ( better-auth hash hex 161-char custom ) **tidak bisa dimigrasikan** — semua wajib reset password via Clerk. Itu sudah disepakati.
- **Yang dihapus:** `PlatformRole` + halaman `/admin/users`, `/admin/audit-logs`, `/admin/organizations`, `/admin/storage`, `/admin/system`, modul `admin/`, `organizations/`, `permissions/` — karena setiap user setara dan tidak ada lagi platform super-admin ( keputusan engineer, lihat session notes ). Data audit **user-scope** tetap dipertahankan via Clerk events + AuditLog row per organisasi.

### 4. Database: Docker Postgres + Prisma → Neon + Drizzle
- **Status quo:** `invoice-me-postgres-1` + `invoice-me-pg-host` Docker, `prisma/schema.prisma` 20 model, 11 migration, `prisma/seed.mjs` 619 baris, 34 file query layer prisma.
- **Setelah:** **Drizzle ORM** schema di `src/db/schema/` ( atau `src/db/schema.ts` ), koneksi neon-serverless, DATABASE_URL mengarah ke Neon project `invoice-me` ( sudah dibuat: `lucky-hall-99090018`, region Singapore PG16 ). Local dev + **test juga ke Neon** ( engineer pilih, bukan Docker lokal ).
- **Data:** fresh start — schema dibangun ulang dari Drizzle sesuai bentuk baru, seed dijalankan ulang. Data lokal dibuang ( isinya fixture, bukan produksi ).

### 5. Struktur tenant: flat workspace
- **Status quo:** `OrganizationRole` ( OWNER/ADMIN/MEMBER/VIEWER ) + Membership dengan permission tiers + org switcher.
- **Setelah:** Organization Clerk tetap sebagai wadah workspace, **tanpa hierarki role** — semua member **admin penuh** workspace. `OrganizationRole` dihapus dari schema. Invite tetap jalan via Clerk Organizations. Org switcher di-keep ( karena multi-org per user masih possible di Clerk ).

## Design

- UI v4 Bento Kausal ( Change 5 ) tetap menjadi source of truth visual. Tidak ada perubahan design dalam change ini.
- `ClerkProvider` di root layout, komponen `<SignIn />`, `<SignUp />`, `<UserButton />`, `<OrganizationSwitcher />` mengikuti tema v4 ( navy/emerald/ivory ).
- Print route + PDF worker: `output: "standalone"` di next.config tetap. Deploy ke **Vercel** ( engineer punya akun, auth nanti saat bangun ).

## Implementation

1. **Branding rename ( lakukan pertama, mechanical ).** package.json name → `creainvoice`, docker-compose service name, env DATABASE name, semua UI copy, README, title. Hapus file-file legacy caching plugin note ( `.build04-prompt.txt`, `.build04-r5-prompt.txt` jika isinya mengandung merek lama ).
2. **Data personal replace.** `prisma/seed.mjs` → ganti semua personal name/brand dengan token netral ( CreaInvoice Studio, PT Cipta Karya Nusantara, Andi Wijaya, admin@creainvoice.id ). Juga di unit test fixtures dan `context/*` audit/spec yang memuat nama lama.
3. **Bongkar auth lama, pasang Clerk.** Hapus `better-auth`, pasang `@clerk/nextjs`. Baru: `src/lib/clerk.ts` ( auth() wrapper ), `src/app/api/clerk/webhook/route.ts` sync user/org. Middleware: `clerkMiddleware()`. Hapus modul `admin/`, `organizations/`, `permissions/` + halaman `/admin/*` platform-level. Upayakan semua query DB beralih membaca userId/orgId dari Clerk session.
4. **Prisma → Drizzle.** Tulis `src/db/schema.ts` dari `prisma/schema.prisma` ( tanpa PlatformRole, tanpa role tier di Membership ), `src/db/client.ts` ( neon-serverless + drizzle ). Pindahkan 34 file query layer. Migration via `drizzle-kit generate` + push ke Neon.
5. **Seed ulang** lewat Drizzle, data demo netral.
6. **Update context bundle.** `architecture-context.md` stack table ( Clerk/Drizzle/Neon/Vercel ), `security-standards.md` ( auth section rewrite ), `data-model.md` ( entities tanpa role tier ), `progress-tracker.md` ( Change 6 entry + session notes ). `AGENTS.md` read order tetap.

## Scope Limits

- **Tidak** mengubah UI v4 ( Change 5 ) — tidak ada perubahan design.
- **Tidak** membangun SaaS billing / payment gateway — dibahas di change terpisah saat engineer bangun ( eksplisit ditangguhkan ).
- **Tidak** deploy di change ini — infrastruktur disiapkan, deploy saat engineer supervisi.
- **Tidak** migrasi data existing — fresh start ( keputusan engineer ).
- **Tidak** menambah fitur baru — semua yang ada dipertahankan, hanya auth/ORM/branding yang berubah.

## Check When Done

- [ ] `grep -rniE 'sigit|berkarya|nugraha|dharma|polimetal' src prisma context tests docs` = 0 match
- [ ] `grep -rniE 'invoice[- ]?me' src prisma context package.json docker-compose.yml README.md` = 0 match ( pengecualian: komentar sejarah di progress-tracker yang menjelaskan asal repo )
- [ ] `npm run build` PASS, `npm run lint` 0 error, `npm run typecheck` PASS
- [ ] Unit + integration test: suite hijau ( target 723, boleh berubah sesuai refactor auth/admin removal — pastikan tidak ada test merah yang unrelated )
- [ ] E2E: login Clerk jalan, halaman utama render, invoice CRUD lewat demo user
- [ ] Drizzle schema ter-push ke Neon, seed jalan, data demo netral muncul
- [ ] Clerk webhook sync user → row di DB ( test via webhook simulator atau manual trigger )
- [ ] `git remote -v` = `https://github.com/selcy-ai/creainvoice.git` saja, no `maulanaadib`
- [ ] Commit + tag `feat-13` di main

## Commit and Push

Trunk-based pada `main`. Commit message: `feat: rebrand to creainvoice + migrate auth to Clerk and DB to Neon/Drizzle`. Tag `feat-13`. Push dengan credential default ( gh auth selcy-ai ). Delete repo `maulanaadib/invoice-me` dan `selcy-ai/invoice-me` setelah engineer konfirmasi ( **tidak otomatis** — engineer akan konfirmasi saat bangun ).

## Progress Tracker

Update `context/progress-tracker.md`:
- Completed: Change 6 ( creainvoice rebrand + Clerk + Neon/Drizzle )
- Open Questions: SaaS billing + payment gateway dibahas terpisah, deploy Vercel saat engineer supervisi, hapus repo lama setelah konfirmasi
- Session Notes: keputusan flat workspace ( tanpa OrganizationRole ), fresh start data, PlatformRole dihapus, test suite ke Neon, model build `omniroute/intern-ai/Atria-Dawn`
