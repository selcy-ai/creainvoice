// tests/e2e/invoice-pdf.spec.ts
// Feature 06 "Check When Done" — E2E: issue → in-process PdfJob worker →
// real pdf-service (Playwright Chromium, started by playwright.config
// webServer on :3090) → file on the shared storage → the detail page offers a
// REAL download → the browser download is a valid PDF.
//
// `./setup-env` MUST stay the first import: it forces DATABASE_URL from
// .env.local so fixture rows land in the same database the dev server uses
// (and INTERNAL_PDF_SECRET/PDF_SERVICE_URL line up with the pdf-service
// process playwright starts).
//
// Requires the dev app on :3000 (playwright starts it — the compose app
// container must NOT hold the port, or the stale image would be tested).

import "./setup-env";
import { ctxFor } from "@/tests/helpers/context";
import { rm } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { db } from "@/tests/helpers/test-db";
import { createProfile } from "@/modules/profiles/service";
import { saveBankAccount } from "@/modules/bank-accounts/service";
import { saveSigner } from "@/modules/signers/service";
import { createCustomer } from "@/modules/customers/service";
import { createDraft } from "@/modules/invoices/service";
import type { InvoiceDraftFormOutput } from "@/modules/invoices/schema";
import { issueInvoice } from "@/modules/invoices/issue-service";
import { addMembership, createOrganization, createUser, type TestUser } from "../factories";

let user: TestUser;
let organizationId: string;
let profileId: string;
let customerId: string;
let invoiceId: string;
let invoiceNumber: string;

// Change 6: flat workspace — no role tier, ctxFor carries the full scope.
function ctx() {
  return ctxFor(organizationId, user.id);
}

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Username atau email").fill(user.username);
  await page.getByLabel("Kata sandi").fill(user.password);
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
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15_000 });
}

test.describe("invoice PDF end-to-end (fitur 06)", () => {
  test.beforeAll(async () => {
    // Playwright has no (fn, timeout) overload — extend the hook budget from
    // inside (fresh dev DB + first-compile latency).
    test.setTimeout(120_000);
    user = await createUser({ username: `pdfe2e.${Date.now().toString(36)}` });
    const org = await createOrganization("PT E2E Invoice PDF");
    organizationId = org.id;
    await addMembership(user.id, org.id, "OWNER");

    const profile = await createProfile(ctx(), { name: "CreaInvoice Studio", code: "SB" });
    profileId = profile.id;

    const customer = await createCustomer(
      {
        companyName: "PT Cipta Karya Nusantara",
        legalName: "PT Cipta Karya Nusantara",
        businessType: "Manufaktur",
        taxId: "01.2345.6789.000008",
        address: "Jl. Industri No. 7",
        city: "Bekasi",
        province: "Jawa Barat",
        postalCode: "17111",
        country: "Indonesia",
        phone: "0215550177",
        whatsapp: "",
        email: "ap@ciptakarya.co.id",
        isActive: true,
      },
      ctx(),
    );
    customerId = customer.id;

    const bank = await saveBankAccount(
      {
        bankName: "Bank Mandiri",
        accountNumber: "1234567890123456",
        accountHolder: "PT CreaInvoice Studio",
        branch: "KCP Sudirman",
      },
      ctx(),
    );
    const signer = await saveSigner(
      { name: "CreaInvoice Studio", title: "Direktur", location: "Yogyakarta" },
      ctx(),
    );

    const draft = await createDraft(
      {
        profileId,
        customerId,
        bankAccountId: bank.id,
        signerId: signer.id,
        invoiceType: "DOWN_PAYMENT",
        billingMode: "PERCENT",
        billingPercent: "50",
        invoiceDate: "2026-07-01",
        referenceType: "PURCHASE_ORDER",
        referenceNumber: "5198021181",
        stampMode: "E_METERAI",
        items: [
          {
            description: "Pemasangan bracket frame",
            quantity: "5",
            unit: "Unit",
            unitPrice: "900000",
            discountAmount: "0",
          },
        ],
      } as InvoiceDraftFormOutput,
      ctx(),
    );
    await issueInvoice(draft.id, ctx());
    invoiceId = draft.id;
    const row = await db.invoice.findUnique({ where: { id: invoiceId } });
    invoiceNumber = row?.number ?? "";
    expect(invoiceNumber).not.toBe("");
  });

  test.afterAll(async () => {
    // Explicit order (invoice → profile FK restrict), dev DB stays clean.
    await db.auditLog.deleteMany({ where: { organizationId } });
    await db.invoice.deleteMany({ where: { organizationId } });
    await db.invoiceProfile.deleteMany({ where: { organizationId } });
    await db.bankAccount.deleteMany({ where: { organizationId } });
    await db.signer.deleteMany({ where: { organizationId } });
    await db.customer.deleteMany({ where: { organizationId } });
    await db.membership.deleteMany({ where: { organizationId } });
    await db.organization.deleteMany({ where: { id: organizationId } });
    await db.user.deleteMany({ where: { id: user.id } });
    await rm(path.join(".data", "invoices", "organizations", organizationId), {
      recursive: true,
      force: true,
    });
  });

  test("issue → worker → detail page → download valid PDF", async ({ page }) => {
    await login(page);
    await page.goto(`/invoices/${invoiceId}`);

    // The worker polls every 5s; pdf-service renders with Chromium. The card
    // must flip from the honest queue state to a REAL file.
    await expect(page.getByText("PDF siap", { exact: true })).toBeVisible({ timeout: 90_000 });
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

    // Both halves of the audit contract.
    const generated = await db.auditLog.findFirst({
      where: { organizationId, action: "PDF_GENERATED", entityId: invoiceId },
    });
    expect(generated).not.toBeNull();
    const downloaded = await db.auditLog.findFirst({
      where: { organizationId, action: "PDF_DOWNLOADED", entityId: invoiceId },
    });
    expect(downloaded).not.toBeNull();

    // invoice.pdfPath points at the stored official file.
    const row = await db.invoice.findUnique({ where: { id: invoiceId } });
    expect(row?.pdfPath).toBe(
      `invoices/organizations/${organizationId}/2026/${expectedFilename}`,
    );
  });

  test("download without a session answers 401", async ({ request }) => {
    // The `request` fixture is a fresh API context — no browser cookies.
    const response = await request.get(`/api/invoices/${invoiceId}/pdf`);
    expect(response.status()).toBe(401);
  });

  test("print route without a token answers 401", async ({ request }) => {
    const response = await request.get(`/print/invoices/${invoiceId}`);
    expect(response.status()).toBe(401);
  });
});
