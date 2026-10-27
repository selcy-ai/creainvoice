// tests/e2e/acceptance.spec.ts
// Feature 11C "Check When Done" — final E2E acceptance suite (master prompt
// bagian 32, 11 langkah) + verifikasi PDF bagian 33 + verifikasi seed
// acceptance (bagian 33) + halaman legal & cookie consent (spec 11C item 2–4).
//
// Alur mengikuti master prompt apa adanya: super admin membuat user lewat
// dialog (bukan fixture factory) sehingga flag `mustChangePassword` dan
// `onboardingComplete` berasal dari jalur produksi yang sebenarnya.
//
// `./setup-env` MUST stay the first import: it forces DATABASE_URL from
// .env.local so fixture rows land in the same database the dev server uses.
//
// Requires the dev app on :3000 (playwright starts it — the compose app
// container must NOT hold the port, or the stale image would be tested).

import "./setup-env";
import { rm } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { PDFParse } from "pdf-parse";
import { db } from "@/tests/helpers/test-db";
import { terbilang } from "@/lib/terbilang";
import {
  addMembership,
  createOrganization,
  createUser,
  type TestUser,
} from "../factories";
import { ctxFor } from "@/tests/helpers/context";

// ─── Fixtures ───────────────────────────────────────────────────────────────

let admin: TestUser;
let otherOrgUser: TestUser;
let otherOrganizationId: string;

// The acceptance user is created THROUGH THE ADMIN DIALOG in test 2 (the real
// production path), so its mustChangePassword=true / onboardingComplete=false
// come from createUserByAdmin — never from a test fixture shortcut.
const runStamp = Date.now().toString(36);
const acc = {
  username: `acc.user.${runStamp}`,
  email: `acc.user.${runStamp}@acc.test`,
  tempPassword: "Temp-Acc-12345",
  password: "KataSandi-Baru-9876",
};
let accUserId: string | undefined;

// Discovered from real data: the org the wizard creates, and the invoice the
// editor issues. Nothing is pre-created for this user outside the app.
let organizationId: string | undefined;
let invoiceId: string;
let invoiceNumber: string;

const ORG_NAME = "PT Acceptance E2E";
const CUSTOMER_NAME = "PT Acceptance Customer";
const PO_NUMBER = "5198021181";

function normalized(text: string): string {
  return text.replace(/\s+/g, "");
}
function lowerNormalized(text: string): string {
  return normalized(text).toLowerCase();
}

async function login(
  page: Page,
  who: { username: string; password: string },
): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Username atau email").fill(who.username);
  await page.getByLabel("Kata sandi").fill(who.password);
  // Wait for BOTH the auth response (cookie set) and the client-side
  // redirect — navigating away while the sign-in is still in flight lands
  // back on /login with no session.
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().includes("/api/auth/sign-in/") &&
        response.request().method() === "POST" &&
        response.ok(),
    ),
    page.getByRole("button", { name: "Masuk", exact: true }).click(),
  ]);
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 30_000,
  });
}

/** Wizard advance button (feature 02 spec): "Lanjut" or "Lanjut tanpa logo". */
async function advance(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^Lanjut( tanpa logo)?$/ }).click();
}

// ─── Spec ────────────────────────────────────────────────────────────────────

test.describe("final acceptance (fitur 11C — master prompt bagian 32 + 33)", () => {
  test.beforeAll(async () => {
    test.setTimeout(180_000);
    // Change 6: no platformRole exists — every user is a plain workspace user.
    admin = await createUser({
      username: `acc.admin.${runStamp}`,
    });
    otherOrgUser = await createUser({ username: `acc.other.${runStamp}` });
    const otherOrg = await createOrganization("PT Other Org E2E");
    otherOrganizationId = otherOrg.id;
    await addMembership(otherOrgUser.id, otherOrg.id, "OWNER");
  });

  test.afterAll(async () => {
    test.setTimeout(60_000);
    // Explicit FK-safe order, scoped cleanup only (dev DB keeps everything else).
    for (const orgId of [organizationId, otherOrganizationId]) {
      if (!orgId) continue;
      await db.auditLog.deleteMany({ where: { organizationId: orgId } });
      await db.invoice.deleteMany({ where: { organizationId: orgId } });
      await db.invoiceProfile.deleteMany({ where: { organizationId: orgId } });
      await db.bankAccount.deleteMany({ where: { organizationId: orgId } });
      await db.signer.deleteMany({ where: { organizationId: orgId } });
      await db.projectReference.deleteMany({ where: { organizationId: orgId } });
      await db.customer.deleteMany({ where: { organizationId: orgId } });
      await db.membership.deleteMany({ where: { organizationId: orgId } });
      await db.organization.deleteMany({ where: { id: orgId } });
      await rm(path.join(".data", "uploads", "organizations", orgId), {
        recursive: true,
        force: true,
      });
      await rm(path.join(".data", "invoices", "organizations", orgId), {
        recursive: true,
        force: true,
      });
    }
    for (const u of [admin, otherOrgUser]) {
      if (!u) continue;
      await db.auditLog.deleteMany({ where: { actorUserId: u.id } });
      await db.user.deleteMany({ where: { id: u.id } });
    }
    if (accUserId) {
      await db.auditLog.deleteMany({ where: { actorUserId: accUserId } });
      await db.user.deleteMany({ where: { id: accUserId } });
    }
  });

  test("0a. Seed acceptance data lengkap (CreaInvoice Studio, bagian 33)", async () => {
    // Spec 11C Check When Done: "Seed lengkap: org CreaInvoice Studio, profile SB,
    // bank Mandiri, customer PT Cipta Karya Nusantara + PIC Andi Wijaya,
    // PO 5198021181" dan "Invoice acceptance sample: DOWN_PAYMENT 50%, tanggal
    // 31 Juli 2026, nomor INV/SB/VII/2026/001, grand total 2.250.000, terbilang
    // …, stamp E_METERAI". Diverifikasi terhadap baris DB nyata, bukan klaim.
    const org = await db.organization.findUnique({ where: { slug: "karya-nusantara" } });
    expect(org?.name).toBe("CreaInvoice Studio");

    const profile = await db.invoiceProfile.findFirst({
      where: { organizationId: org!.id, code: "SB" },
    });
    expect(profile?.name).toBe("CreaInvoice Studio");
    expect(profile?.address).toContain("Yogyakarta");
    expect(profile?.whatsapp).toBe("0812 3456 7890");

    const bank = await db.bankAccount.findFirst({
      where: { organizationId: org!.id, bankName: "Bank Mandiri" },
    });
    expect(bank?.accountNumberLast4).toBe("0123");
    expect(bank?.isDefault).toBe(true);
    // Encrypted at rest: the plaintext number never appears in the row.
    expect(bank?.accountNumberEncrypted).not.toContain("1234567890123");

    const customer = await db.customer.findFirst({
      where: { organizationId: org!.id, companyName: "PT Cipta Karya Nusantara" },
    });
    expect(customer).not.toBeNull();
    const pic = await db.customerContact.findFirst({
      where: { customerId: customer!.id, name: "Andi Wijaya" },
    });
    expect(pic?.division).toBe("Purchasing");

    const po = await db.projectReference.findFirst({
      where: { organizationId: org!.id, referenceNumber: "5198021181" },
    });
    expect(po?.referenceDate?.toISOString().slice(0, 10)).toBe("2026-07-15");
    // Prisma Decimal.toString() normalizes away trailing zeros — compare
    // numerically (same gotcha as feature 08's roundMoney note).
    expect(Number(po?.workValue)).toBe(4500000);

    const invoice = await db.invoice.findFirst({
      where: { organizationId: org!.id, number: "INV/SB/VII/2026/001" },
    });
    const items = await db.invoiceItem.findMany({
      where: { invoiceId: invoice!.id },
    });
    expect(invoice).not.toBeNull();
    expect(invoice!.status).toBe("ISSUED");
    expect(invoice!.invoiceType).toBe("DOWN_PAYMENT");
    expect(Number(invoice!.billingPercent)).toBe(50);
    expect(invoice!.invoiceDate.toISOString().slice(0, 10)).toBe("2026-07-31");
    expect(Number(invoice!.grandTotal)).toBe(2250000);
    expect(invoice!.stampMode).toBe("E_METERAI");
    expect(items).toHaveLength(1);
    expect(Number(items[0]!.quantity)).toBe(5);
    expect(Number(items[0]!.unitPrice)).toBe(900000);
    // Terbilang of the seeded grand total matches the spec phrase exactly.
    expect(terbilang(invoice!.grandTotal)).toBe(
      "Dua juta dua ratus lima puluh ribu rupiah",
    );
  });

  test("0b. Halaman legal publik + cookie consent banner berfungsi", async ({ page }) => {
    // /privacy dan /terms wajib render tanpa session (proxy PUBLIC_PATHS).
    await page.goto("/privacy");
    await expect(page.getByRole("heading", { level: 1, name: "Kebijakan Privasi" })).toBeVisible();
    await expect(page.getByText(/UU No\. 27 Tahun 2022/)).toBeVisible();

    await page.goto("/terms");
    await expect(
      page.getByRole("heading", { level: 1, name: "Syarat & Ketentuan" }),
    ).toBeVisible();

    // Cookie consent banner: tampil, accept/reject berfungsi, pilihan persist.
    await page.goto("/login");
    const banner = page.getByLabel("Persetujuan cookie");
    await expect(banner).toBeVisible();
    // Banner is click-through: the login submit button stays operable under it.
    await expect(page.getByRole("button", { name: "Masuk", exact: true })).toBeEnabled();

    // Reject path.
    await page.getByRole("button", { name: "Hanya esensial" }).click();
    await expect(banner).toHaveCount(0);
    expect(
      await page.evaluate(() => localStorage.getItem("invoice-me.cookie-consent")),
    ).toBe("rejected");
    await page.reload();
    await expect(banner).toHaveCount(0);

    // Accept path (after resetting the stored choice).
    await page.evaluate(() => localStorage.removeItem("invoice-me.cookie-consent"));
    await page.reload();
    await expect(banner).toBeVisible();
    await page.getByRole("button", { name: "Terima", exact: true }).click();
    await expect(banner).toHaveCount(0);
    expect(
      await page.evaluate(() => localStorage.getItem("invoice-me.cookie-consent")),
    ).toBe("accepted");
  });

  test("1. Admin login", async ({ page }) => {
    await login(page, admin);
    await expect(page).toHaveURL(/\/dashboard$/, { timeout: 30_000 });
  });

  test("2. Admin creates a user with a temporary password", async ({ page }) => {
    await login(page, admin);
    await page.goto("/admin/users");
    await page.getByRole("button", { name: "Buat user" }).click();
    await expect(page.getByText("Buat pengguna baru")).toBeVisible();

    await page.locator("#create-username").fill(acc.username);
    await page.locator("#create-email").fill(acc.email);
    await page.locator("#create-name").fill("User Acceptance");
    await page.locator("#create-temp-password").fill(acc.tempPassword);
    await page.getByRole("button", { name: "Buat pengguna" }).click();

    // Success toast (exact: the dialog DESCRIPTION also starts "User dibuat…"
    // but with more words) + the dialog closes on success.
    await expect(page.getByText("User dibuat", { exact: true })).toBeVisible();
    await expect(page.getByText("Buat pengguna baru")).toHaveCount(0);

    // The row exists with the production contract: forced change + no onboarding.
    const created = await db.user.findUnique({ where: { username: acc.username } });
    expect(created).not.toBeNull();
    expect(created!.onboardingComplete).toBe(false);
    accUserId = created!.id;
  });

  test("3. User logs in with the temporary password", async ({ page }) => {
    await login(page, { username: acc.username, password: acc.tempPassword });
    // Proxy forces the change before anything else (security-standards).
    await expect(page).toHaveURL(/\/change-password$/, { timeout: 30_000 });
    await expect(page.getByText("Ubah kata sandi sementara")).toBeVisible();
  });

  test("4. User changes the password", async ({ page }) => {
    await login(page, { username: acc.username, password: acc.tempPassword });
    await expect(page).toHaveURL(/\/change-password$/, { timeout: 30_000 });

    await page.locator("#currentPassword").fill(acc.tempPassword);
    await page.locator("#newPassword").fill(acc.password);
    await page.locator("#confirmPassword").fill(acc.password);
    await page.getByRole("button", { name: "Simpan kata sandi baru" }).click();

    await expect(page.getByText("Kata sandi diubah")).toBeVisible();
    // Leaves /change-password (the success handler redirects to the app).
    await expect(page).not.toHaveURL(/\/change-password/, { timeout: 30_000 });

    const reloaded = await db.user.findUnique({ where: { username: acc.username } });
  });

  test("5. User is routed to onboarding, not the dashboard", async ({ page }) => {
    // Evidence first: the flag must be false after test 4's change, so the
    // next landing proves the ONBOARDING gate, not the password gate.
    const row = await db.user.findUnique({ where: { username: acc.username } });
    expect(row?.onboardingComplete).toBe(false);

    await login(page, acc);
    await expect(page).toHaveURL(/\/onboarding$/, { timeout: 30_000 });
    await expect(page.getByText("Langkah 1 dari 12", { exact: true })).toBeVisible();
  });

  test("6. User completes onboarding and creates a DP 50% invoice", async ({ page }) => {
    test.setTimeout(300_000);
    await login(page, acc);
    await expect(page).toHaveURL(/\/onboarding$/, { timeout: 30_000 });

    // ── 12-langkah wizard (recipe identik dengan onboarding.spec.ts) ────────
    await page.getByLabel("Nama organisasi").fill(ORG_NAME);
    await advance(page);
    await expect(page.getByText("Langkah 2 dari 12", { exact: true })).toBeVisible();

    await page.getByLabel("Nama legal (opsional)").fill("PT Acceptance E2E");
    await page.getByLabel("Alamat (opsional)").fill("Jl. Acceptance No. 1, Yogyakarta");
    await advance(page);

    await advance(page); // 3 — tanpa logo ("Lanjut tanpa logo")
    await advance(page); // 4 — warna default

    await page.getByLabel("Telepon").fill("0274 555 0100");
    await page.getByLabel("Email").fill("halo@acceptance.test");
    await advance(page); // 5

    await page.getByLabel("Nama bank").fill("Bank Mandiri");
    await page.getByLabel("Nomor rekening").fill("998877665544");
    await page.getByLabel("Atas nama").fill("PT Acceptance E2E");
    await advance(page); // 6

    await page.getByLabel("Nama penanda tangan").fill("Penanda Acceptance");
    await page.getByLabel("Jabatan (opsional)").fill("Direktur");
    await advance(page); // 7

    await page.getByLabel("Nama profil invoice").fill("Acceptance Profile");
    await page.getByLabel("Kode singkat").fill("AP");
    await advance(page); // 8

    await advance(page); // 9 — pola nomor default

    await page.getByRole("radio", { name: "E-meterai (placeholder)" }).click();
    await advance(page); // 10

    await advance(page); // 11 — preview

    await page.getByRole("button", { name: "Selesaikan onboarding" }).click();
    await expect(page).toHaveURL(/\/dashboard$/, { timeout: 60_000 });

    const membership = await db.membership.findFirst({ where: { userId: accUserId! } });
    organizationId = membership!.organizationId;

    // ── Customer ────────────────────────────────────────────────────────────
    await page.goto("/customers/new");
    await page.locator("#companyName").fill(CUSTOMER_NAME);
    await page.getByRole("button", { name: "Buat customer" }).click();
    await expect(page).toHaveURL(/\/customers\/[^/]+$/, { timeout: 30_000 });

    // ── Editor: invoice DP 50% ──────────────────────────────────────────────
    // The editor renders the FORM twice in the DOM (desktop split-screen +
    // mobile tab panel — the mobile copy is CSS-hidden). Every form locator
    // therefore resolves two matches: take the first (desktop) everywhere.
    await page.goto("/invoices/new");
    await expect(page.getByRole("heading", { level: 1, name: "Invoice baru" }).first()).toBeVisible({
      timeout: 30_000,
    });

    await page.locator("#invoice-type").first().click();
    await page.getByRole("option", { name: "Down Payment (DP)" }).click();

    await page.locator("#invoice-customer").first().click();
    await page.getByRole("option", { name: CUSTOMER_NAME, exact: true }).click();

    await page.locator("#billing-percent").first().fill("50");

    await page.getByLabel("Deskripsi item 1").first().fill("Pemasangan bracket frame");
    await page.getByLabel("Qty item 1").first().fill("5");
    await page.getByLabel("Unit item 1").first().click();
    await page.getByRole("option", { name: "Unit", exact: true }).click();
    await page.getByPlaceholder("Harga/satuan").first().fill("900000");

    await page.locator("#invoice-date").first().fill("2026-07-31");
    await page.locator("#reference-number").first().fill(PO_NUMBER);

    await page.locator("#stamp-mode").first().click();
    await page.getByRole("option", { name: "E-Meterai", exact: true }).click();

    await page.getByRole("button", { name: /^Simpan (draft|perubahan)$/ }).first().click();
    await expect(page.getByTestId("autosave-indicator").first()).toHaveText("Tersimpan", {
      timeout: 30_000,
    });

    const draft = await db.invoice.findFirst({
      where: { organizationId: organizationId!, status: "DRAFT" },
    });
    expect(draft).not.toBeNull();
    expect(draft!.invoiceType).toBe("DOWN_PAYMENT");
    expect(Number(draft!.billingPercent)).toBe(50);
    invoiceId = draft!.id;
  });

  test("7. Live preview shows the correct numbers", async ({ page }) => {
    await login(page, acc);
    await page.goto(`/invoices/${invoiceId}/edit`);

    const document = page.getByLabel("Pratinjau invoice");
    await expect(document).toBeVisible({ timeout: 30_000 });
    await expect(document).toContainText("DOWN PAYMENT 50%");
    await expect(document).toContainText("Rp 4.500.000"); // nilai pekerjaan
    await expect(document).toContainText("Rp 2.250.000"); // total ditagihkan
    await expect(document).toContainText(
      "Dua juta dua ratus lima puluh ribu rupiah", // terbilang
    );
    await expect(document).toContainText("Pemasangan bracket frame");
    await expect(document).toContainText("900.000");
    await expect(document).toContainText(PO_NUMBER);
  });

  test("8. User issues the invoice", async ({ page }) => {
    await login(page, acc);
    await page.goto(`/invoices/${invoiceId}`);

    await page.getByRole("button", { name: "Terbitkan invoice", exact: true }).click();
    await expect(page.getByText("Terbitkan invoice ini?")).toBeVisible();
    await page.getByRole("button", { name: "Terbitkan invoice", exact: true }).click();

    // The success toast only fires when the server action returned ok WITH the
    // allocated number (invoice-lifecycle-actions: title + `Nomor ${number}`).
    await expect(page.getByText("Invoice diterbitkan")).toBeVisible({ timeout: 30_000 });
    const toastWithNumber = page.getByText(/^Nomor INV\//);
    await expect(toastWithNumber).toBeVisible({ timeout: 10_000 });
    const numberFromToast = (await toastWithNumber.textContent())!.replace(/^Nomor\s+/, "");

    // The commit precedes the toast (server action await), but poll anyway so
    // a pooler/replica visibility lag can never masquerade as a bug.
    await expect
      .poll(async () => (await db.invoice.findUnique({ where: { id: invoiceId } }))?.status, {
        timeout: 20_000,
        message: "invoice must be ISSUED in the database after the success toast",
      })
      .toBe("ISSUED");

    const issued = await db.invoice.findUnique({ where: { id: invoiceId } });
    // Number comes from the REAL engine (profile pattern, code AP, VII 2026).
    expect(issued?.number).toMatch(/^INV\/AP\/VII\/2026\/\d{3}$/);
    expect(issued?.number).toBe(numberFromToast);
    // Issue side-effects in the same transaction: audit + PDF job enqueued.
    const issueAudit = await db.auditLog.findFirst({
      where: { action: "INVOICE_ISSUED", entityId: invoiceId },
    });
    expect(issueAudit).not.toBeNull();
    const pdfJob = await db.pdfJob.findFirst({ where: { invoiceId } });
    expect(pdfJob?.status).toBe("PENDING");
    invoiceNumber = issued!.number!;
  });

  test("9. PDF is generated, downloadable, and carries the acceptance values", async ({ page }) => {
    await login(page, acc);
    await page.goto(`/invoices/${invoiceId}`);

    // In-process worker → real pdf-service (Playwright Chromium). The worker
    // polls every 5s and a crashed browser may cost one requeue cycle — allow
    // a generous window (feature 06's own E2E allows 90s; headroom here).
    await expect(page.getByText("PDF siap", { exact: true })).toBeVisible({ timeout: 180_000 });
    const expectedFilename = `${invoiceNumber.replace(/\//g, "-")}.pdf`;
    await expect(page.getByText(expectedFilename, { exact: true })).toBeVisible();

    const downloadButton = page.getByTestId("download-pdf");
    await expect(downloadButton).toBeVisible();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      downloadButton.click(),
    ]);
    expect(download.suggestedFilename()).toBe(expectedFilename);

    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const bytes = Buffer.concat(chunks);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(bytes.length).toBeGreaterThan(1_000);

    // ── Acceptance PDF values (bagian 33) on the extracted, selectable text ──
    const parser = new PDFParse({ data: new Uint8Array(bytes) });
    const info = await parser.getInfo();
    expect(info.info?.Title).toBe(invoiceNumber); // metadata Title = nomor
    const text = await parser.getText();
    await parser.destroy();
    const flat = normalized(text.text);
    const lower = lowerNormalized(text.text);

    expect(flat).toContain(invoiceNumber);
    expect(flat).toContain(normalized("DOWN PAYMENT 50%")); // badge
    expect(flat).toContain("900.000"); // item 5 × Rp900.000
    expect(flat).toContain(normalized("Rp 4.500.000")); // nilai pekerjaan
    expect(flat).toContain(normalized("Rp 2.250.000")); // total
    expect(lower).toContain(
      lowerNormalized("Dua juta dua ratus lima puluh ribu rupiah"), // terbilang
    );
    // Slot e-meterai compact di KIRI blok tanda tangan (DOM/PDF text order).
    const stampIndex = flat.indexOf(normalized("Slot E-Meterai"));
    const signatureIndex = flat.indexOf(normalized("Hormat kami"));
    expect(stampIndex).toBeGreaterThanOrEqual(0);
    expect(signatureIndex).toBeGreaterThan(stampIndex);
    // Footer referensi PO dari pdf-service (Playwright displayHeaderFooter).
    expect(lower).toContain(
      lowerNormalized(
        `Invoice ini dibuat berdasarkan Purchase Order ${CUSTOMER_NAME} Nomor ${PO_NUMBER}.`,
      ),
    );
    expect(flat).toContain(normalized("Halaman 1 dari 1"));
  });

  test("10. Admin can view the invoice and audit-on-view is recorded", async ({ page }) => {
    await login(page, admin);
    const response = await page.goto(`/admin/invoices/${invoiceId}`);
    expect(response?.status()).toBe(200);
    // Body-level contains check (the invoice number renders inside the frozen
    // snapshot card); avoids text-engine quirks of getByText on slashy strings.
    await expect(page.locator("body")).toContainText(invoiceNumber, { timeout: 30_000 });

    const audit = await db.auditLog.findFirst({
      where: { action: "ADMIN_VIEWED_INVOICE", entityId: invoiceId },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actorUserId).toBe(admin.id);
  });

  test("11. A user from another org cannot open the invoice via direct URL", async ({ page }) => {
    expect(invoiceNumber, "test 8 must have issued the invoice first").not.toBe("");
    await login(page, otherOrgUser);
    // Clerk holds the active organization in ITS session, not ours — a user
    // from another organization cannot set it to this org, and the detail page
    // resolves no workspace scope for them at all. The IDOR guard decides.
    const response = await page.goto(`/invoices/${invoiceId}`);
    // IDOR guard contract: the service answers NOT_FOUND and the page throws
    // notFound(). Because the dashboard SHELL layout streams first, the
    // transport status stays 200 and Next client-renders the 404 fallback
    // (NEXT_HTTP_ERROR_FALLBACK;404) — the user sees a 404 page either way.
    await expect(page.locator("body")).toContainText("404");
    // No document data ever reaches this user — page DOM AND raw HTML.
    await expect(page.locator("body")).not.toContainText(invoiceNumber);
    await expect(page.locator("body")).not.toContainText("Data saat diterbitkan");
    await expect(page.locator("body")).not.toContainText("Grand total");
    const html = await response!.text();
    expect(html).not.toContain(invoiceNumber);
    expect(html).not.toContain("Grand total");
  });
});
