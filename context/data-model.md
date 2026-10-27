# Data Model

The canonical entities. A feature spec may add a field or a relation, but it may not redefine an entity that already lives here. Two features describing the same entity differently is the bug this file exists to prevent.

## Conventions

- ID: `String @id @default(cuid())` (cuid, tidak sequential untuk hindari enumeration).
- Timestamps: `DateTime` (UTC), `createdAt` + `updatedAt` (`@updatedAt`).
- Uang: `Decimal @db.Decimal(18, 2)`. Persentase: `Decimal @db.Decimal(5, 2)`.
- Soft delete: hanya Customer (`deletedAt`), Invoice issued tidak pernah dihapus.
- Enum di Prisma (`enum`), bukan string.
- Referential actions hati-hati: **tidak cascade-delete invoice resmi**.
- Org scoping: setiap entity bisnis punya `organizationId`; composite unique + index selalu menyertakan.

## Entities

### User (Better Auth managed)

Better Auth model resmi (`user`, `account`, `session`, `verification`). Tambah field platform:

| Field | Type | Constraints | Notes |
| --- | --- | --- | --- |
| id | String | @id, cuid | |
| name | String? | | |
| email | String | unique | login alternatif |
| username | String | unique | login alternatif |
| emailVerified | Boolean | default false | |
| platformRole | PlatformRole | default USER | SUPER_ADMIN atau USER |
| mustChangePassword | Boolean | default false | force change setelah admin create/reset |
| status | UserStatus | default ACTIVE | ACTIVE / SUSPENDED |
| role | String? | | kolom admin-plugin Better Auth: mirror `platformRole` verbatim (SUPER_ADMIN ↔ "SUPER_ADMIN"), dibaca `hasPermission()` |
| banned / banReason / banExpires | Boolean / String? / DateTime? | default false / null / null | admin plugin; suspend → `banned=true` + hapus semua session |
| memberships | Membership[] | relation | |
| createdAt / updatedAt | DateTime | | |

Migrasi feature 01: `20261005232013_auth_multi_tenant` (additive) — kolom platform di atas + kolom admin plugin.

### Session (Better Auth managed)

| Field | Type | Constraints | Notes |
| --- | --- | --- | --- |
| id | String | @id, cuid | |
| token | String | unique | nilai cookie session |
| activeOrganizationId | String? | | workspace aktif (feature 01); ditulis server-side hanya setelah membership ACTIVE diverifikasi; setiap scoped read wajib re-validasi membership (fail closed) |
| expiresAt / createdAt / updatedAt | DateTime | | masa aktif 7 hari, perpanjangan 1 hari |
| ipAddress / userAgent | String? | | |
| userId | String | relation ke user | cascade delete saat user dihapus |
| impersonatedBy | String? | | kolom admin plugin |

### Organization

| Field | Type | Constraints | Notes |
| --- | --- | --- | --- |
| id | String | @id, cuid | |
| name | String | | |
| slug | String | unique | |
| status | OrgStatus | default ACTIVE | |
| createdAt / updatedAt | DateTime | | |

### Membership

| Field | Type | Constraints | Notes |
| --- | --- | --- | --- |
| id | String | @id, cuid | |
| userId | String | relation | |
| organizationId | String | relation | |
| role | OrganizationRole | | OWNER / ADMIN / STAFF / VIEWER |
| permissions | Json? | | permission granular opsional |
| status | MembershipStatus | default ACTIVE | |
| joinedAt | DateTime | | |
| **unique** | | `@@unique([userId, organizationId])` | |

### InvoiceProfile

| Field | Type | Constraints | Notes |
| --- | --- | --- | --- |
| id | String | @id, cuid | |
| organizationId | String | relation | |
| name | String | | mis. "CreaInvoice Studio" |
| code | String | | mis. "SB" |
| legalName | String? | | |
| logoPath | String? | | storage path |
| primaryColor | String | default "#2563eb" | |
| address | String? | | |
| phone / whatsapp / fax / email / website | String? | | |
| taxId | String? | | NPWP |
| defaultBankAccountId | String? | relation BankAccount | |
| defaultSignerId | String? | relation Signer | |
| numberPattern | String | default "INV/{CODE}/{ROMAN_MONTH}/{YYYY}/{SEQ:3}" | |
| sequenceResetPolicy | SequenceResetPolicy | default YEARLY | MONTHLY / YEARLY / NEVER |
| defaultCurrency | String | default "IDR" | |
| defaultTaxMode | TaxMode | default NONE | |
| defaultTaxPercent | Decimal? | @db.Decimal(5,2) | |
| defaultStampMode | StampMode | default NONE | |
| defaultNotes | String? | | boleh token |
| templateKey | String | default "corporate-blue" | |
| settings | Json? | | logo size/posisi, hide-zero rows |
| isActive | Boolean | default true | |
| createdAt / updatedAt | DateTime | | |
| **unique** | | `@@unique([organizationId, code])` | |

### InvoiceSequence

| Field | Type | Constraints | Notes |
| --- | --- | --- | --- |
| id | String | @id, cuid | |
| invoiceProfileId | String | relation | |
| sequenceKey | String | | mis. "2026-VII" (year+month untuk reset) |
| currentValue | Int | default 0 | |
| updatedAt | DateTime | @updatedAt | |
| **unique** | | `@@unique([invoiceProfileId, sequenceKey])` | |

### Customer

| Field | Type | Constraints | Notes |
| --- | --- | --- | --- |
| id | String | @id, cuid | |
| organizationId | String | relation | |
| companyName | String | | |
| legalName | String? | | |
| businessType | String? | | |
| taxId | String? | | NPWP |
| address / city / province / postalCode / country | String? | | |
| phone / whatsapp / email | String? | | |
| notes | String? | | catatan internal |
| isActive | Boolean | default true | |
| deletedAt | DateTime? | | soft delete |
| createdAt / updatedAt | DateTime | | |
| contacts | CustomerContact[] | | |

### CustomerContact (PIC)

| Field | Type | Constraints | Notes |
| --- | --- | --- | --- |
| id | String | @id, cuid | |
| customerId | String | relation | |
| name | String | | |
| title / division | String? | | jabatan / divisi |
| email / phone / whatsapp | String? | | |
| isPrimary | Boolean | default false | |

### ProjectReference

| Field | Type | Constraints | Notes |
| --- | --- | --- | --- |
| id | String | @id, cuid | |
| organizationId | String | relation | |
| customerId | String | relation | |
| referenceType | ReferenceType | | PURCHASE_ORDER / SPK / CONTRACT / QUOTATION / OTHER / NONE |
| referenceNumber | String | | |
| referenceDate | DateTime? | | |
| title | String | | |
| description | String? | | |
| workValue | Decimal | @db.Decimal(18,2) | |
| currency | String | default "IDR" | |
| startDate / endDate | DateTime? | | |
| status | ProjectStatus | default ACTIVE | |
| attachmentPath | String? | | |
| notes | String? | | |
| createdAt / updatedAt | DateTime | | |
| **index** | | `@@index([organizationId, referenceNumber])` | |

### BankAccount

| Field | Type | Constraints | Notes |
| --- | --- | --- | --- |
| id | String | @id, cuid | |
| organizationId | String | relation | |
| profileId | String? | relation InvoiceProfile | |
| bankName | String | | |
| bankCode | String? | | |
| accountNumberEncrypted | String | | ciphertext (AES-256-GCM) |
| accountNumberLast4 | String | | untuk masking |
| accountHolder | String | | |
| branch | String? | | |
| currency | String | default "IDR" | |
| isDefault | Boolean | default false | |
| isActive | Boolean | default true | |
| createdAt / updatedAt | DateTime | | |
| **index** | | `@@index([organizationId])` (feature 10) | list pagination per org |

### Signer

| Field | Type | Constraints | Notes |
| --- | --- | --- | --- |
| id | String | @id, cuid | |
| organizationId | String | relation | |
| name | String | | |
| title | String? | | jabatan |
| location | String? | | mis. "Yogyakarta" |
| signatureImagePath | String? | | storage path |
| isDefault | Boolean | default false | |
| isActive | Boolean | default true | |
| **index** | | `@@index([organizationId])` (feature 10) | list pagination per org |

### Invoice

| Field | Type | Constraints | Notes |
| --- | --- | --- | --- |
| id | String | @id, cuid | |
| organizationId | String | relation | |
| profileId | String | relation | |
| customerId | String | relation | |
| customerContactId | String? | relation | |
| projectReferenceId | String? | relation | |
| invoiceType | InvoiceType | | DOWN_PAYMENT / SETTLEMENT / FULL / TERM / CUSTOM |
| status | InvoiceStatus | default DRAFT | DRAFT / ISSUED / SENT / PARTIALLY_PAID / PAID / OVERDUE / CANCELLED / REVISED |
| number | String? | nullable saat draft | nomor final, dialokasikan saat ISSUED |
| numberPreview | String? | | nomor preview untuk draft |
| invoiceDate | DateTime | | |
| dueDate | DateTime? | | |
| referenceType | ReferenceType? | | snapshot relasi |
| referenceNumber | String? | | |
| referenceDate | DateTime? | | |
| paymentTerms | String? | | |
| currency | String | default "IDR" | |
| workValue | Decimal | @db.Decimal(18,2) | |
| itemsSubtotal | Decimal | @db.Decimal(18,2) | |
| previouslyBilled | Decimal | @db.Decimal(18,2) default 0 | |
| billingPercent | Decimal? | @db.Decimal(5,2) | |
| billingBase | Decimal | @db.Decimal(18,2) | |
| discountAmount | Decimal | @db.Decimal(18,2) default 0 | |
| additionalAmount | Decimal | @db.Decimal(18,2) default 0 | |
| taxMode | TaxMode | default NONE | |
| taxPercent | Decimal? | @db.Decimal(5,2) | |
| taxAmount | Decimal | @db.Decimal(18,2) default 0 | |
| roundingAmount | Decimal | @db.Decimal(18,2) default 0 | |
| grandTotal | Decimal | @db.Decimal(18,2) | |
| remainingAfter | Decimal | @db.Decimal(18,2) | |
| amountPaid | Decimal | @db.Decimal(18,2) default 0 | |
| notes | String? | | boleh token ({INVOICE_NUMBER} dll.) |
| footerText | String? | | |
| stampMode | StampMode | default NONE | |
| signerId | String? | relation | |
| bankAccountId | String? | relation | |
| issuerSnapshot / customerSnapshot / contactSnapshot / bankSnapshot / signerSnapshot / calculationSnapshot / templateSnapshot | Json | | snapshot immutability saat ISSUED |
| createdById | String | relation | |
| issuedById | String? | relation | |
| issuedAt | DateTime? | | |
| cancelledAt | DateTime? | | |
| cancellationReason | String? | | wajib saat cancel |
| revisedFromId | String? | relation Invoice | revision parent |
| replacedById | String? | relation Invoice | revision replacement |
| createdAt / updatedAt | DateTime | | |
| items | InvoiceItem[] | | |
| payments | Payment[] | | |
| **unique** | | `@@unique([organizationId, number])` | |
| **indexes** | | `@@index([organizationId, status])`, `@@index([organizationId, invoiceDate])`, `@@index([organizationId, customerId])`, `@@index([organizationId, projectReferenceId])` | |

### InvoiceItem

| Field | Type | Constraints | Notes |
| --- | --- | --- | --- |
| id | String | @id, cuid | |
| invoiceId | String | relation | |
| position | Int | | urutan (drag reorder) |
| description | String | | |
| details | String? | | subdeskripsi |
| quantity | Decimal | @db.Decimal(18,2) | qty > 0 |
| unit | String | | Unit/Pcs/Set/Lot/Paket/Jasa/Jam/Hari/Bulan/custom |
| unitPrice | Decimal | @db.Decimal(18,2) | >= 0 |
| discountAmount | Decimal | @db.Decimal(18,2) default 0 | |
| lineAmount | Decimal | @db.Decimal(18,2) | qty × price − discount |
| metadata | Json? | | |

### Payment

| Field | Type | Constraints | Notes |
| --- | --- | --- | --- |
| id | String | @id, cuid | |
| organizationId | String | relation | org isolation — semua read/mutation di-scope |
| invoiceId | String | relation | riwayat per invoice; invoice ISSUED+ saja |
| paymentDate | DateTime | | kalender day (UTC midnight), tampil Asia/Jakarta |
| amount | Decimal | @db.Decimal(18,2) | nominal; > 0 |
| method | PaymentMethod | | BANK_TRANSFER / CASH / QRIS / OTHER |
| referenceNumber | String? | | nomor referensi mutasi/struk (opsional, maks 100) |
| proofPath | String? | | bukti pembayaran — `uploads/organizations/{orgId}/payment-proofs/{uuid}.{ext}` |
| notes | String? | | catatan (maks 500) |
| overpaymentReason | String? | | wajib terisi saat OWNER/ADMIN override pembayaran melebihi sisa |
| createdById | String | relation | recorded by |
| createdAt | DateTime | | |
| **indexes** | | `@@index([organizationId, paymentDate])`, `@@index([invoiceId, paymentDate])` | list `/payments` + riwayat per invoice |

### InvoicePdf

| Field | Type | Constraints | Notes |
| --- | --- | --- | --- |
| id | String | @id, cuid | |
| invoiceId | String | relation | |
| version | Int | | |
| storagePath | String | | |
| originalFilename | String | | |
| mimeType | String | | |
| sizeBytes | BigInt | | |
| sha256 | String | | |
| templateVersion | String | | |
| generatedById | String | relation | |
| generatedAt | DateTime | | |
| isOfficial | Boolean | default false | |
| **unique** | | `@@unique([invoiceId, version])` | |

### PdfJob

| Field | Type | Constraints | Notes |
| --- | --- | --- | --- |
| id | String | @id, cuid | |
| invoiceId | String | relation | |
| status | PdfJobStatus | default PENDING | PENDING / RUNNING / SUCCESS / FAILED |
| attempt | Int | default 0 | retry terbatas (maks 3) |
| errorMessage | String? | | |
| startedAt / finishedAt | DateTime? | | |
| durationMs | Int? | | |
| createdAt | DateTime | | |

### AuditLog

| Field | Type | Constraints | Notes |
| --- | --- | --- | --- |
| id | String | @id, cuid | |
| actorUserId | String? | relation | nullable untuk system action |
| organizationId | String? | relation | |
| action | AuditAction | enum | 30 action (lihat feature 11; 3 ditambahkan feature 01, 3 feature 09) |
| entityType | String | | |
| entityId | String | | |
| metadata | Json | | disanitasi (no secret/PII) |
| ipAddress | String? | | atau ipHash sesuai kebijakan |
| userAgent | String? | | |
| createdAt | DateTime | | |
| **indexes** | | `@@index([organizationId, createdAt])`, `@@index([actorUserId, createdAt])` | |

### UploadRecord (feature 09)

| Field | Type | Constraints | Notes |
| --- | --- | --- | --- |
| id | String | @id, cuid | |
| organizationId | String | relation | org isolation; cascade delete |
| path | String | unique | root-relative `uploads/organizations/{orgId}/{kind}/{filename}` |
| sizeBytes | BigInt | | dijumlah untuk storage usage |
| mimeType | String | | dari sniff saat upload (ekstensi hasil upload saat reconcile) |
| kind | String | | `logos` / `signatures` / `references` / `payment-proofs` |
| createdAt | DateTime | default now | |
| **index** | | `@@index([organizationId])` | daftar per org |

Dicatat oleh `RecordingStorageService` (decorator di `getStorageService`) pada setiap upload/delete, plus `reconcileUploadRecords()` (idempoten, insert-only, hanya org yang masih ada) sebelum total dihitung.

## Enums

- PlatformRole: `SUPER_ADMIN` | `USER`
- UserStatus: `ACTIVE` | `SUSPENDED`
- OrgStatus: `ACTIVE` | `SUSPENDED`
- OrganizationRole: `OWNER` | `ADMIN` | `STAFF` | `VIEWER`
- MembershipStatus: `ACTIVE` | `INVITED` | `REMOVED`
- InvoiceType: `DOWN_PAYMENT` | `SETTLEMENT` | `FULL` | `TERM` | `CUSTOM`
- InvoiceStatus: `DRAFT` | `ISSUED` | `SENT` | `PARTIALLY_PAID` | `PAID` | `OVERDUE` | `CANCELLED` | `REVISED`
- ReferenceType: `PURCHASE_ORDER` | `SPK` | `CONTRACT` | `QUOTATION` | `OTHER` | `NONE`
- ProjectStatus: `ACTIVE` | `COMPLETED` | `ON_HOLD` | `CANCELLED`
- SequenceResetPolicy: `MONTHLY` | `YEARLY` | `NEVER`
- TaxMode: `NONE` | `EXCLUSIVE` | `INCLUSIVE` | `MANUAL`
- StampMode: `NONE` | `E_METERAI` | `PHYSICAL` | `BLANK_SPACE`
- PdfJobStatus: `PENDING` | `RUNNING` | `SUCCESS` | `FAILED`
- PaymentMethod: `BANK_TRANSFER` | `CASH` | `QRIS` | `OTHER`
- AuditAction: enum 30 action — canonical list tetap final di feature 11; feature 01 menambah `USER_ACTIVATED`, `SESSION_REVOKED`, `PASSWORD_CHANGED` (migrasi `20261005232013_auth_multi_tenant`); feature 09 menambah `USER_ROLE_CHANGED`, `ORGANIZATION_STATUS_CHANGED`, `PDF_JOB_RETRIED` (migrasi `20261008142337_feature09_super_admin_panel`). Daftar saat ini: LOGIN_SUCCESS, LOGIN_FAILED, LOGOUT, USER_CREATED, USER_SUSPENDED, USER_ACTIVATED, PASSWORD_RESET, PASSWORD_CHANGED, SESSION_REVOKED, ORGANIZATION_CREATED, MEMBERSHIP_CHANGED, PROFILE_CHANGED, CUSTOMER_CREATED, CUSTOMER_UPDATED, CUSTOMER_DELETED, PROJECT_CREATED, PROJECT_UPDATED, INVOICE_DRAFT_CREATED, INVOICE_UPDATED, INVOICE_ISSUED, PDF_GENERATED, PDF_DOWNLOADED, INVOICE_SENT, INVOICE_CANCELLED, INVOICE_REVISED, PAYMENT_RECORDED, ADMIN_VIEWED_INVOICE, USER_ROLE_CHANGED, ORGANIZATION_STATUS_CHANGED, PDF_JOB_RETRIED

## Indexes

- Semua composite index menyertakan `organizationId` (lihat per-entity di atas).
- `AuditLog`: `[organizationId, createdAt]` dan `[actorUserId, createdAt]` untuk panel admin.
- `Invoice`: `[organizationId, status]`, `[organizationId, invoiceDate]`, `[organizationId, customerId]`, `[organizationId, projectReferenceId]`.
- `Payment`: `[organizationId, paymentDate]`, `[invoiceId, paymentDate]`.
- `ProjectReference`: `[organizationId, referenceNumber]`.
- `BankAccount` / `Signer`: `[organizationId]` (feature 10).
- Unique constraint: `[organizationId, number]` di Invoice, `[organizationId, code]` di InvoiceProfile, `[invoiceProfileId, sequenceKey]` di InvoiceSequence, `[invoiceId, version]` di InvoicePdf, `[userId, organizationId]` di Membership.

## Migration Rules

- Migrations are forward only and additive first. A breaking migration is a spec decision, not a build time surprise.
- `prisma migrate deploy` di Docker entrypoint (production); `prisma migrate dev` untuk dev.
- **Tidak ada migrasi yang menghapus data invoice issued.** Tidak ada `DROP TABLE` di invoice-related setelah ada data.
- Setiap feature yang menambah entity wajib membuat migration baru via `prisma migrate dev --name <feature>`.
- Feature 01: `20261005232013_auth_multi_tenant` (additive) — kolom platform + admin plugin di `user`, `activeOrganizationId` di `session`, 3 nilai AuditAction baru.
- Feature 07: `20261008102333_payments` (additive) — tabel `Payment` + enum `PaymentMethod` + index; tidak ada perubahan pada tabel invoice selain pemakaian kolom `amountPaid`/`remainingAfter`/`status` yang sudah ada.
- Feature 09: `20261008142337_feature09_super_admin_panel` (additive) — tabel `UploadRecord` + 3 nilai enum `AuditAction` baru; tidak ada perubahan pada tabel lain.
- Feature 10: `20261009001701_bank_signers` (additive) — index `[organizationId]` di `BankAccount` dan `Signer`; tidak ada perubahan kolom/tabel lain (multi-account CRUD, `bankSnapshot.accountNumber`, dan token notes adalah perilaku aplikasi di atas skema yang sudah ada).
- Seed (`prisma db seed`) terpisah dari migration, idempotent, hanya untuk dev/acceptance test data (master prompt bagian 33: CreaInvoice Studio, PT Cipta Karya Nusantara, PO 5198021181).
- Breaking migration (rename column, change type) hanya jika feature spec eksplisit dan ada data migration script.
