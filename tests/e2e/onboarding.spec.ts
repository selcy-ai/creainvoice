// tests/e2e/onboarding.spec.ts
// Feature 02 "Check When Done" — browser walkthrough of the 12-step onboarding
// wizard against the dev app (context/testing-standards.md: E2E runs against
// the dev DB). Proves what vitest cannot: auto-redirect after login, the full
// wizard flow, close-and-resume, upload rules surfaced in the UI, the static
// INV/SB/VII/2026/001 example, live accent-color preview, meterai disclaimer,
// completion gating, /profiles/[id] edit — then the raw-DB facts (encrypted
// account number, onboardingComplete, PROFILE_CHANGED audit, random path).
//
// `./setup-env` MUST stay the first import: it forces DATABASE_URL from
// .env.local so fixture rows land in the same database the dev server uses.

import "./setup-env";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { db } from "@/tests/helpers/test-db";
import { createUser, type TestUser } from "../factories";

// ─── Fixtures (real rows in the dev DB; removed in afterAll) ─────────────────

const USER_NAME = "Andi E2E";
const ORG_NAME = "PT Uji Onboarding E2E";
const ACCOUNT_NUMBER = "123456783449"; // 12 digits → mask "**** **** 3449"
const ACCENT = "#7c3aed";
const ACCENT_RGB = "rgb(124, 58, 237)";
const PATTERN = "INV/{CODE}/{ROMAN_MONTH}/{YYYY}/{SEQ:3}";
const FINAL_PATTERN = "INV/{CODE}/{YYYY}/{SEQ:3}";
const STAMP_DISCLAIMER =
  "Aplikasi hanya mengatur layout placeholder, belum melakukan pembubuhan e-meterai resmi.";

// Verified 1×1 PNG (70 bytes) — sniffs as image/png and sharp decodes it.
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
// Oversize (> UPLOAD_MAX_MB=2 from .env.local); content is irrelevant because
// validateUpload checks size before sniffing.
const PNG_OVERSIZE = Buffer.concat([PNG_1PX, Buffer.alloc(2 * 1024 * 1024 + 1)]);
// A real PDF header wearing a .png filename — the server sniffs magic bytes.
const PDF_BYTES = Buffer.from(
  "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n",
  "utf8",
);

const accountMask = `**** **** ${ACCOUNT_NUMBER.slice(-4)}`;
const alertBox = (page: Page, text: RegExp) =>
  page.locator('p[role="alert"]').filter({ hasText: text });

let user: TestUser;
let organizationId: string;
let profileId: string;
let firstLogoPath: string;

// ─── Helpers ────────────────────────────────────────────────────────────────

async function login(page: Page, who: TestUser): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Username atau email").fill(who.username);
  await page.getByLabel("Kata sandi").fill(who.password);
  await page.getByRole("button", { name: "Masuk", exact: true }).click();
}

async function expectStep(page: Page, step: number, title?: string): Promise<void> {
  await expect(page.getByText(`Langkah ${step} dari 12`, { exact: true })).toBeVisible();
  if (title) await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
}

async function advance(page: Page, fromStep: number): Promise<void> {
  await page.getByRole("button", { name: /^Lanjut( tanpa logo)?$/ }).click();
  await expectStep(page, fromStep + 1);
}

// ─── Spec ────────────────────────────────────────────────────────────────────

test.describe("onboarding 12 langkah (fitur 02)", () => {
  test.beforeAll(async () => {
    // A transient dev-DB blip (e.g. right after a concurrent production build)
    // must not nuke the whole file before a single step runs: retry briefly,
    // then fail loudly with the real error.
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        user = await createUser({ onboardingComplete: false, name: USER_NAME });
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
    throw lastError;
  });

  test.afterAll(async () => {
    if (!user) return;
    const memberships = await db.membership.findMany({
      where: { userId: user.id },
      select: { organizationId: true },
    });
    organizationId = memberships[0]?.organizationId ?? organizationId;
    if (organizationId) {
      const storageDir = path.resolve(
        process.env.STORAGE_ROOT ?? "./.data",
        "uploads/organizations",
        organizationId,
      );
      if (existsSync(storageDir)) rmSync(storageDir, { recursive: true, force: true });
      // Scoped cleanup only — other rows of the dev DB stay untouched.
      await db.auditLog.deleteMany({ where: { organizationId } });
      await db.organization.delete({ where: { id: organizationId } });
    }
    await db.auditLog.deleteMany({ where: { actorUserId: user.id } });
    // Change 6: session/account were better-auth tables; Clerk owns them now.
    await db.user.deleteMany({ where: { id: user.id } });
  });

  test("login mengarahkan user baru ke onboarding", async ({ page }) => {
    await login(page, user);
    await expect(page).toHaveURL(/\/onboarding$/, { timeout: 60_000 }); // first hit may compile the route
    await expectStep(page, 1, "Organisasi");
  });

  test("wizard 12 langkah end-to-end, close di tengah lalu resume", async ({
    page,
    context,
  }) => {
    await login(page, user);
    await expect(page).toHaveURL(/\/onboarding$/, { timeout: 60_000 });

    // ── Langkah 1: buat organisasi ─────────────────────────────────────────
    await expectStep(page, 1, "Organisasi");
    await expect(
      page.getByText(
        "Progres tersimpan otomatis — Anda bisa menutup halaman dan lanjut nanti.",
      ),
    ).toBeVisible();
    await page.getByLabel("Nama organisasi").fill(ORG_NAME);
    await advance(page, 1);

    // ── Langkah 2: profil perusahaan (membuat InvoiceProfile) ──────────────
    await expectStep(page, 2, "Profil perusahaan");
    await page.getByLabel("Nama legal (opsional)").fill("PT Uji Onboarding Nusantara");
    await page.getByLabel("NPWP (opsional)").fill("01.234.567.8-901.000");
    await page.getByLabel("Alamat (opsional)").fill("Jl. Uji Blok A No. 1, Jakarta");
    await advance(page, 2);

    // ── Langkah 3: logo — ukuran, MIME palsu, nama file traversal ─────────
    await expectStep(page, 3, "Logo perusahaan");
    const logoInput = page.getByLabel("File logo");
    const uploadButton = page.getByRole("button", { name: "Unggah logo" });

    await logoInput.setInputFiles({
      name: "besar.png",
      mimeType: "image/png",
      buffer: PNG_OVERSIZE,
    });
    await uploadButton.click();
    await expect(alertBox(page, /Ukuran file melebihi batas 2 MB/)).toBeVisible();

    await logoInput.setInputFiles({
      name: "palsu.png",
      mimeType: "image/png",
      buffer: PDF_BYTES,
    });
    await uploadButton.click();
    await expect(alertBox(page, /Format file terdeteksi sebagai PDF/)).toBeVisible();

    // Hostile filename must never reach the stored path.
    await logoInput.setInputFiles({
      name: "../../etc/passwd",
      mimeType: "image/png",
      buffer: PNG_1PX,
    });
    await uploadButton.click();
    await expect(page.getByText("Logo berhasil diunggah")).toBeVisible();
    const logoImg = page.locator('img[alt="Logo perusahaan"]');
    await expect(logoImg).toBeVisible();
    const logoSrc = (await logoImg.getAttribute("src")) ?? "";
    expect(logoSrc).toMatch(
      /^\/api\/storage\/uploads\/organizations\/[^/]+\/logo\/[0-9a-f-]+\.png$/,
    );
    expect(logoSrc).not.toContain("..");
    expect(logoSrc).not.toContain("passwd");
    firstLogoPath = logoSrc.replace("/api/storage/", "");
    // The UI claim is backed by a real file on disk.
    await expect
      .poll(() => existsSync(path.resolve(process.env.STORAGE_ROOT ?? "./.data", firstLogoPath)))
      .toBe(true);
    await advance(page, 3); // button sudah berubah menjadi "Lanjut"

    // ── Langkah 4: warna aksen → preview berubah live ──────────────────────
    await expectStep(page, 4, "Warna utama");
    await expect(page.locator("#primaryColor")).toHaveValue(/^#[0-9a-f]{6}$/i);
    const previewHeader = page.locator(".invoice-preview > div").first();
    await expect(previewHeader).not.toHaveCSS("background-color", ACCENT_RGB);
    await page.getByRole("button", { name: `Pilih warna ${ACCENT}` }).click();
    await expect(page.locator("#primaryColor")).toHaveValue(ACCENT);
    await expect(previewHeader).toHaveCSS("background-color", ACCENT_RGB);
    await advance(page, 4);

    // ── Langkah 5: kontak ──────────────────────────────────────────────────
    await expectStep(page, 5, "Kontak");
    await page.getByLabel("Telepon").fill("021 555 0100");
    await page.getByLabel("Email").fill("halo@uji.co.id");
    await page.getByLabel("Website").fill("https://uji.co.id");
    await advance(page, 5);

    // ── Close di tengah wizard + resume dari langkah terakhir ─────────────
    const midUser = await db.user.findUnique({
      where: { id: user.id },
      select: { onboardingStep: true, onboardingComplete: true },
    });
    expect(midUser?.onboardingStep).toBe(6);
    expect(midUser?.onboardingComplete).toBe(false);
    const membership = await db.membership.findFirst({
      where: { userId: user.id },
      select: { organizationId: true },
    });
    expect(membership).not.toBeNull();
    organizationId = membership!.organizationId;

    await context.clearCookies(); // "tutup browser"
    await login(page, user); // login ulang dari nol
    await expect(page).toHaveURL(/\/onboarding$/, { timeout: 60_000 });
    await expectStep(page, 6, "Rekening bank");
    await expect(
      page.getByText("Melanjutkan dari langkah terakhir yang Anda isi."),
    ).toBeVisible();

    // ── Langkah 6: rekening bank (nomor disimpan terenkripsi) ──────────────
    await expect(page.getByText("Rekening tersimpan")).toBeHidden(); // belum ada
    await page.getByLabel("Nama bank").fill("Bank Central Asia");
    await page.getByLabel("Kode bank (opsional)").fill("BCA");
    await page.getByLabel("Nomor rekening").fill(ACCOUNT_NUMBER);
    await page.getByLabel("Atas nama").fill("Siti Uji");
    await advance(page, 6);

    // ── Langkah 7: penanda tangan ──────────────────────────────────────────
    await expectStep(page, 7, "Penanda tangan");
    await page.getByLabel("Nama penanda tangan").fill("Ahmad Uji");
    await page.getByLabel("Jabatan (opsional)").fill("Direktur");
    await page.getByLabel("Lokasi (opsional)").fill("Jakarta");
    await advance(page, 7);

    // ── Langkah 8: identitas profil invoice ────────────────────────────────
    await expectStep(page, 8, "Profil invoice");
    await page.getByLabel("Nama profil invoice").fill("Uji Onboarding");
    await page.getByLabel("Kode singkat").fill("SB");
    await advance(page, 8);

    // ── Langkah 9: pola nomor — contoh statis + token invalid ditolak ─────
    await expectStep(page, 9, "Pola nomor invoice");
    const patternInput = page.locator("#numberPattern");
    await expect(patternInput).toHaveValue(PATTERN);
    await expect(
      page.getByText(`Contoh (Juli 2026, kode SB, pola ${PATTERN}):`),
    ).toBeVisible();
    await expect(page.locator("span", { hasText: "INV/SB/VII/2026/001" }).first()).toBeVisible();

    // Token tak dikenal: peringatan langsung di input, DAN server menolak
    // saat disimpan (tetap di langkah 9).
    await patternInput.fill("INV/{UNKNOWN}/{SEQ:3}");
    await expect(patternInput).toHaveAttribute("aria-invalid", "true");
    await expect(alertBox(page, /Token tidak dikenal/).first()).toBeVisible();
    await page.getByRole("button", { name: /^Lanjut$/ }).click();
    await expectStep(page, 9, "Pola nomor invoice");
    await expect(alertBox(page, /Token tidak dikenal/).first()).toBeVisible();

    // Pattern valid → server menerima dan langkah lanjut.
    await patternInput.fill(PATTERN);
    await expect(patternInput).not.toHaveAttribute("aria-invalid", "true");
    await advance(page, 9);

    // ── Langkah 10: preferensi meterai + disclaimer wajib ──────────────────
    await expectStep(page, 10, "Preferensi meterai");
    await expect(page.getByText(STAMP_DISCLAIMER)).toBeVisible();
    const stampRadio = page.getByRole("radio", { name: "E-meterai (placeholder)" });
    await stampRadio.click();
    await expect(stampRadio).toHaveAttribute("aria-checked", "true");
    await advance(page, 10);

    // ── Langkah 11: preview invoice (accent + mask, tanpa plaintext) ──────
    await expectStep(page, 11, "Preview invoice");
    await expect(page.locator(".invoice-preview > div").first()).toHaveCSS(
      "background-color",
      ACCENT_RGB,
    );
    await expect(page.getByText(accountMask).first()).toBeVisible();
    await expect(page.getByText(ACCOUNT_NUMBER, { exact: true })).toHaveCount(0);
    await advance(page, 11);

    // ── Langkah 12: ringkasan + selesai → dashboard ───────────────────────
    await expectStep(page, 12, "Selesai");
    await expect(page.getByText("Ringkasan profil invoice")).toBeVisible();
    await expect(page.getByText("Uji Onboarding (SB)")).toBeVisible();
    await expect(page.getByText(PATTERN, { exact: true })).toBeVisible();
    await expect(page.getByText(accountMask).first()).toBeVisible();
    await expect(page.getByText("Ahmad Uji")).toBeVisible();
    await expect(page.getByText("Terunggah")).toBeVisible();
    await page.getByRole("button", { name: "Selesaikan onboarding" }).click();
    await expect(page.getByText("Onboarding selesai. Mengalihkan ke dashboard…")).toBeVisible();
    await expect(page).toHaveURL(/\/dashboard$/, { timeout: 30_000 });

    // Setelah selesai: onboardingComplete=true + wizard dikunci.
    const doneUser = await db.user.findUnique({
      where: { id: user.id },
      select: { onboardingComplete: true, onboardingStep: true },
    });
    expect(doneUser?.onboardingComplete).toBe(true);
    expect(doneUser?.onboardingStep).toBe(12);

    await page.goto("/onboarding");
    await expect(page).toHaveURL(/\/dashboard$/, { timeout: 15_000 });

    // ── Fakta mentah di DB ─────────────────────────────────────────────────
    const bank = await db.bankAccount.findFirst({
      where: { organizationId, isActive: true },
    });
    expect(bank).not.toBeNull();
    expect(bank!.accountNumberEncrypted).not.toContain(ACCOUNT_NUMBER);
    expect(bank!.accountNumberEncrypted.split(":")).toHaveLength(3); // iv:tag:ciphertext
    for (const part of bank!.accountNumberEncrypted.split(":")) {
      expect(part).toMatch(/^[0-9a-f]+$/i);
    }
    expect(bank!.accountNumberLast4).toBe(ACCOUNT_NUMBER.slice(-4));

    const profile = await db.invoiceProfile.findFirst({
      where: { organizationId, isActive: true },
    });
    expect(profile).not.toBeNull();
    profileId = profile!.id;
    expect(profile!.primaryColor).toBe(ACCENT);
    expect(profile!.numberPattern).toBe(PATTERN);
    expect(profile!.defaultStampMode).toBe("E_METERAI");
    expect(profile!.logoPath).toBe(firstLogoPath);

    const audits = await db.auditLog.count({
      where: { action: "PROFILE_CHANGED", organizationId },
    });
    expect(audits).toBeGreaterThan(0);
  });

  test("/profiles/[id] mengubah field, pattern, dan logo", async ({ page }) => {
    test.skip(!profileId, "profil belum dibuat oleh tes wizard");
    await login(page, user);
    await expect(page).toHaveURL(/\/dashboard$/);

    // /profiles mengarah langsung ke profil satu-satunya milik workspace.
    await page.goto("/profiles");
    await expect(page).toHaveURL(new RegExp(`/profiles/${profileId}$`));
    await expect(page.getByRole("heading", { level: 1, name: "Profil Invoice" })).toBeVisible();
    await expect(page.getByText(/perubahan tercatat di audit log sebagai PROFILE_CHANGED/))
      .toBeVisible();

    // Edit field + pola nomor (contoh statis tetap tampil).
    await page.locator("#defaultNotes").fill("Termin pembayaran 14 hari setelah invoice.");
    await page.locator("#numberPattern").fill(FINAL_PATTERN);
    await expect(page.locator("span", { hasText: "INV/SB/VII/2026/001" }).first()).toBeVisible();

    // Ganti logo lewat uploader yang sama.
    await page.getByLabel("File logo").setInputFiles({
      name: "logo-baru.png",
      mimeType: "image/png",
      buffer: PNG_1PX,
    });
    await page.getByRole("button", { name: "Unggah logo" }).click();
    await expect(page.getByText("Logo berhasil diunggah")).toBeVisible();

    await page.getByRole("button", { name: "Simpan perubahan" }).click();
    await expect(page.getByText("Profil invoice disimpan")).toBeVisible();

    // Bertahan setelah reload (persist di server, bukan state client).
    await page.reload();
    await expect(page.locator("#defaultNotes")).toHaveValue(
      "Termin pembayaran 14 hari setelah invoice.",
    );
    await expect(page.locator("#numberPattern")).toHaveValue(FINAL_PATTERN);

    const updated = await db.invoiceProfile.findUnique({ where: { id: profileId } });
    expect(updated?.defaultNotes).toBe("Termin pembayaran 14 hari setelah invoice.");
    expect(updated?.numberPattern).toBe(FINAL_PATTERN);
    expect(updated?.logoPath).not.toBe(firstLogoPath);
    expect(updated?.logoPath).toMatch(/^uploads\/organizations\/[^/]+\/logo\/[0-9a-f-]+\.png$/);
    expect(updated!.logoPath!.startsWith("..")).toBe(false);
    expect(updated!.logoPath).not.toContain("passwd");

    const audits = await db.auditLog.count({
      where: { action: "PROFILE_CHANGED", organizationId },
    });
    expect(audits).toBeGreaterThan(1); // edit menambah baris audit baru
  });
});
