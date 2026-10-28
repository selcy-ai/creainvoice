// tests/e2e/dashboard-invoice-list.spec.ts
// Feature 08 "Check When Done" in the browser:
//   - dashboard: kartu ringkas, grafik 12 bulan (recharts), timeline aktivitas
//   - invoice list: pagination server-side (page 1 → 2 + total), search lewat
//     filter bar, empty state saat hasil 0
//   - row action menu permission-aware: issued (preview/mark sent/cancel/
//     revise, TANPA terbitkan/hapus) dan draft (edit/duplicate/issue/delete,
//     TANPA cancel/revise)
//   - confirmation dialog untuk cancel & delete draft (dibuka dan ditutup
//     tanpa memutasi data)
//   - issue benar-benar menerbitkan invoice dari list (bukan tombol palsu)
//   - Cmd+K: command palette mencari invoice by nomor/customer dan menavigasi
//
// `./setup-env` MUST stay the first import (DATABASE_URL dari .env.local —
// fixture rows harus masuk ke database yang dibaca dev server).
//
// Requires the dev app on :3000 (playwright starts it — the compose app
// container must NOT hold the port, or the stale image would be tested).

import "./setup-env";
import { expect, test, type Page } from "@playwright/test";
import { db } from "@/tests/helpers/test-db";
import { createProfile } from "@/modules/profiles/service";
import { createCustomer, type CustomerFormInput } from "@/modules/customers/service";
import { createDraft } from "@/modules/invoices/service";
import { issueInvoice } from "@/modules/invoices/issue-service";
import type { InvoiceDraftFormOutput } from "@/modules/invoices/schema";
import {
  addMembership,
  createOrganization,
  createUser,
  type TestUser,
} from "../factories";
import { ctxFor } from "@/tests/helpers/context";

let user: TestUser;
let organizationId: string;
let profileId: string;
let demoCustomerId: string;
let issuedCustomerId: string;
let draftIssueId: string;
let draftDeleteId: string;
let issuedId: string;
let issuedNumber: string;

/** 21 bulk drafts → 24 rows total → two pages of 20. */
const BULK_COUNT = 21;

// Change 6: flat workspace — no role tier, ctxFor carries the full scope.
function ctx() {
  return ctxFor(organizationId, user.id);
}

function customerInput(name: string): CustomerFormInput {
  return {
    companyName: name,
    legalName: name,
    businessType: "Dagang",
    isActive: true,
  } as CustomerFormInput;
}

function draftFor(customerId: string, unitPrice: string, description: string) {
  return {
    profileId,
    customerId,
    invoiceType: "FULL",
    billingMode: "PERCENT",
    billingPercent: "100",
    invoiceDate: "2026-10-01",
    dueDate: "2026-10-31",
    items: [{ description, quantity: "1", unit: "Paket", unitPrice }],
  } as InvoiceDraftFormOutput;
}

/** The row whose number cell links to this invoice — previews collide. */
function rowFor(page: Page, invoiceId: string) {
  return page.locator(`tr:has(a[href="/invoices/${invoiceId}"])`);
}

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Kata sandi").fill(user.password);
  // Wait for BOTH the auth response (cookie set) and the client-side redirect.
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().includes("/api/auth/sign-in/") &&
        response.request().method() === "POST" &&
        response.ok(),
    ),
    page.getByRole("button", { name: "Masuk", exact: true }).click(),
  ]);
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 60_000 });
}

test.describe("dashboard & invoice list end-to-end (fitur 08)", () => {
  test.beforeAll(async () => {
    test.setTimeout(180_000);
    user = await createUser({ username: `e2e08.${Date.now().toString(36)}` });
    const org = await createOrganization("PT E2E Dashboard Invoice List");
    organizationId = org.id;
    await addMembership(user.id, org.id, "OWNER");

    const profile = await createProfile(ctx(), { name: "E2E Profile", code: "E8" });
    profileId = profile.id;

    demoCustomerId = (
      await createCustomer(customerInput("PT Cipta Karya Nusantara E2E"), ctx())
    ).id;
    // Separate customer for the issued invoice: number PREVIEWS collide
    // between drafts (feature 04 contract), so the row/Cmd+K hit is pinned by
    // a customer name that only this invoice carries.
    issuedCustomerId = (
      await createCustomer(customerInput("PT Terbit E2E"), ctx())
    ).id;
    const bulkCustomerId = (
      await createCustomer(customerInput("PT Bulk E2E"), ctx())
    ).id;

    for (let index = 1; index <= BULK_COUNT; index += 1) {
      await createDraft(draftFor(bulkCustomerId, "1000000", `Pekerjaan bulk ${index}`), ctx());
    }

    const draftIssue = await createDraft(
      draftFor(demoCustomerId, "4500000", "Jasa terbitkan saya"),
      ctx(),
    );
    draftIssueId = draftIssue.id;

    const draftDelete = await createDraft(
      draftFor(demoCustomerId, "1250000", "Jasa hapus saya"),
      ctx(),
    );
    draftDeleteId = draftDelete.id;

    const issuedDraft = await createDraft(
      draftFor(issuedCustomerId, "7500000", "Jasa terbit"),
      ctx(),
    );
    await issueInvoice(issuedDraft.id, ctx());
    issuedId = issuedDraft.id;
    const row = await db.invoice.findUnique({ where: { id: issuedId } });
    issuedNumber = row?.number ?? "";
    expect(issuedNumber).not.toBe("");
  });

  test.afterAll(async () => {
    await db.auditLog.deleteMany({ where: { organizationId } });
    await db.invoice.deleteMany({ where: { organizationId } });
    await db.invoiceProfile.deleteMany({ where: { organizationId } });
    await db.customer.deleteMany({ where: { organizationId } });
    await db.membership.deleteMany({ where: { organizationId } });
    await db.organization.deleteMany({ where: { id: organizationId } });
    await db.user.deleteMany({ where: { id: user.id } });
  });

  test("dashboard menampilkan kartu, grafik, dan aktivitas terbaru", async ({ page }) => {
    await login(page);
    await page.goto("/dashboard");

    await expect(page.getByText("Halo,")).toBeVisible();
    await expect(page.getByText("Total ditagihkan")).toBeVisible();
    await expect(page.getByText("Outstanding")).toBeVisible();
    await expect(page.getByText("Jatuh tempo", { exact: true })).toBeVisible();
    // Grafik 12 bulan (recharts) — bukan placeholder.
    await expect(page.getByTestId("dashboard-chart")).toBeVisible();
    await expect(page.getByText("Aktivitas terbaru")).toBeVisible();
    await expect(page.getByText("Invoice diterbitkan").first()).toBeVisible();
  });

  test("invoice list: pagination server-side (page 1 → 2, total benar)", async ({ page }) => {
    await login(page);
    await page.goto("/invoices");

    const total = BULK_COUNT + 3; // bulk + draftIssue + draftDelete + issued
    await expect(page.getByText(`Total ${total} invoice · Halaman 1 dari 2`)).toBeVisible();
    await expect(page.locator("table tbody tr")).toHaveCount(20);

    await page.getByRole("button", { name: "Berikutnya" }).click();
    await page.waitForURL(/\/invoices\?page=2/);
    await expect(page.getByText(`Total ${total} invoice · Halaman 2 dari 2`)).toBeVisible();
    await expect(page.locator("table tbody tr")).toHaveCount(total - 20);
  });

  test("invoice list: search menilter dan empty state tampil saat 0 hasil", async ({ page }) => {
    await login(page);
    await page.goto("/invoices");

    await page.locator("#invoice-search").fill("Cipta");
    await page.getByRole("button", { name: "Terapkan" }).click();
    await page.waitForURL(/\/invoices\?q=Cipta/);
    await expect(page.getByText("Total 2 invoice", { exact: false })).toBeVisible();
    await expect(page.getByText("PT Cipta Karya Nusantara E2E")).toHaveCount(2);

    await page.locator("#invoice-search").fill("TidakAdaSamaSekali");
    await page.getByRole("button", { name: "Terapkan" }).click();
    await expect(
      page.getByText("Tidak ada invoice yang cocok dengan filter ini."),
    ).toBeVisible();
  });

  test("invoice list: filter status lewat URL (kombinasi server-side)", async ({ page }) => {
    await login(page);
    await page.goto("/invoices?status=ISSUED");

    await expect(page.getByText(`Total 1 invoice`, { exact: false })).toBeVisible();
    await expect(page.getByText(issuedNumber, { exact: true })).toBeVisible();
    await expect(page.getByText("PT Bulk E2E")).toHaveCount(0);
  });

  test("row action menu (issued): preview/mark sent/cancel/revise saja", async ({ page }) => {
    await login(page);
    await page.goto("/invoices?q=Terbit");

    await rowFor(page, issuedId).getByRole("button", { name: /Aksi invoice/ }).click();
    const menu = page.getByRole("menu");
    await expect(menu.getByText("Preview invoice")).toBeVisible();
    await expect(menu.getByText("Tandai terkirim")).toBeVisible();
    await expect(menu.getByText("Batalkan invoice")).toBeVisible();
    await expect(menu.getByText("Buat revisi")).toBeVisible();
    // Draft-only actions never appear on an issued invoice.
    await expect(menu.getByText("Terbitkan")).toHaveCount(0);
    await expect(menu.getByText("Hapus draft")).toHaveCount(0);
    await expect(menu.getByText("Edit draft")).toHaveCount(0);

    // Cancel opens the confirmation dialog WITH the mandatory reason field —
    // then close it again (data untouched).
    await menu.getByText("Batalkan invoice").click();
    await expect(page.getByText("Batalkan invoice?")).toBeVisible();
    await expect(page.getByLabel("Alasan pembatalan")).toBeVisible();
    await page.getByRole("button", { name: "Batal", exact: true }).click();
    await expect(page.getByText("Batalkan invoice?")).toBeHidden();

    const row = await db.invoice.findUnique({ where: { id: issuedId } });
    expect(row?.status).toBe("ISSUED");
  });

  test("row action menu (draft): edit/duplicate/issue/delete + dialog hapus", async ({ page }) => {
    await login(page);
    await page.goto("/invoices?q=Cipta&status=DRAFT");

    await rowFor(page, draftDeleteId).getByRole("button", { name: /Aksi invoice/ }).click();
    const menu = page.getByRole("menu");
    await expect(menu.getByText("Edit draft")).toBeVisible();
    await expect(menu.getByText("Duplikat draft")).toBeVisible();
    await expect(menu.getByText("Terbitkan")).toBeVisible();
    await expect(menu.getByText("Hapus draft")).toBeVisible();
    // Lifecycle actions of issued invoices never appear on a draft.
    await expect(menu.getByText("Batalkan invoice")).toHaveCount(0);
    await expect(menu.getByText("Buat revisi")).toHaveCount(0);
    await expect(menu.getByText("Tandai terkirim")).toHaveCount(0);

    await menu.getByText("Hapus draft").click();
    await expect(page.getByText("Hapus draft ini?")).toBeVisible();
    await page.getByRole("button", { name: "Batal", exact: true }).click();
    await expect(page.getByText("Hapus draft ini?")).toBeHidden();

    const stillThere = await db.invoice.findUnique({ where: { id: draftDeleteId } });
    expect(stillThere).not.toBeNull();
  });

  test("issue dari row action benar-benar menerbitkan invoice", async ({ page }) => {
    await login(page);
    await page.goto("/invoices?q=Cipta&status=DRAFT");

    await rowFor(page, draftIssueId)
      .getByRole("button", { name: /Aksi invoice/ })
      .click();
    await page.getByRole("menu").getByText("Terbitkan").click();
    await expect(page.getByText("Terbitkan invoice ini?")).toBeVisible();
    await page.getByRole("button", { name: "Terbitkan invoice" }).click();
    await expect(page.getByText("Invoice diterbitkan")).toBeVisible();

    const row = await db.invoice.findUnique({ where: { id: draftIssueId } });
    expect(row?.status).toBe("ISSUED");
    expect(row?.number).toBeTruthy();
  });

  test("Cmd+K membuka command palette, mencari invoice, dan menavigasi", async ({ page }) => {
    await login(page);
    await page.goto("/dashboard");

    await page.keyboard.press("Control+k");
    const input = page.getByPlaceholder("Ketik menu, nomor invoice, atau customer...");
    await expect(input).toBeVisible();

    // Route navigation from the palette.
    await input.fill("Pembayaran");
    await page.getByRole("option", { name: "Pembayaran" }).click();
    await page.waitForURL(/\/payments/);

    // Invoice lookup (server query by number/customer).
    await page.keyboard.press("Control+k");
    const input2 = page.getByPlaceholder("Ketik menu, nomor invoice, atau customer...");
    await input2.fill("Terbit E2E");
    await expect(page.getByText(issuedNumber, { exact: true }).first()).toBeVisible();
    await page.getByRole("option", { name: new RegExp(issuedNumber) }).click();
    await page.waitForURL(new RegExp(`/invoices/${issuedId}`));
  });
});
