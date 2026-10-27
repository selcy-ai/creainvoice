// tests/e2e/bank-signers.spec.ts
// Feature 10 "Check When Done" in the browser:
//   - token notes: unknown token {FOOBAR} stays literal in the preview AND the
//     warning banner names it (spec: "dibiarkan literal dengan warning di
//     preview"), while {INVOICE_NUMBER} resolves to the draft preview number
//   - editor dropdowns are org-scoped and MASKED (menu shows **** **** 7666,
//     never the plaintext number)
//   - /bank-accounts list renders masked; the authorized detail page carries
//     the FULL number in the form input for an OWNER
//   - "Jadikan utama" from the list really moves the default (row badge flips)
//   - /signers renders the org's signers
//
// `./setup-env` MUST stay the first import (DATABASE_URL dari .env.local —
// fixture rows harus masuk ke database yang dibaca dev server).
//
// Requires the dev app on :3000 (playwright starts it — the compose app
// container must NOT hold the port, or the stale image would be tested).

import "./setup-env";
import { ctxFor } from "@/tests/helpers/context";
import { expect, test, type Page } from "@playwright/test";
import { db } from "@/tests/helpers/test-db";
import { createProfile } from "@/modules/profiles/service";
import { createBankAccount } from "@/modules/bank-accounts/service";
import { createSigner } from "@/modules/signers/service";
import { addMembership, createOrganization, createUser, type TestUser } from "../factories";

let user: TestUser;
let profileId: string;
let bankDefaultId: string;
let bankSecondId: string;

const BANK_A_NUMBER = "999888777666"; // mask ends 7666
const BANK_B_NUMBER = "111222333456";

// Change 6: flat workspace — no role tier, ctxFor carries the full scope.
function ctx() {
  return ctxFor(organizationId, user.id);
}

let organizationId: string;

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Username atau email").fill(user.username);
  await page.getByLabel("Kata sandi").fill(user.password);
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

test.describe("bank accounts & signers end-to-end (fitur 10)", () => {
  test.beforeAll(async () => {
    test.setTimeout(180_000);
    user = await createUser({ username: `e2e10.${Date.now().toString(36)}` });
    const org = await createOrganization("PT E2E Bank Signers");
    organizationId = org.id;
    await addMembership(user.id, org.id, "OWNER");

    const profile = await createProfile(ctx(), { name: "E2E Bank Profile", code: "E10" });
    profileId = profile.id;
    // Unknown token rides along with a resolvable one so the banner and the
    // resolved text appear as soon as the editor prefills from the profile.
    await db.invoiceProfile.update({
      where: { id: profileId },
      data: { defaultNotes: "Nomor preview {INVOICE_NUMBER} — token asing {FOOBAR}." },
    });

    const bankDefault = await createBankAccount(
      { bankName: "BCA E2E", accountNumber: BANK_A_NUMBER, accountHolder: "PT E2E" },
      ctx(),
    );
    bankDefaultId = bankDefault.id;
    const bankSecond = await createBankAccount(
      { bankName: "Mandiri E2E", accountNumber: BANK_B_NUMBER, accountHolder: "PT E2E" },
      ctx(),
    );
    bankSecondId = bankSecond.id;

    await createSigner({ name: "Penanda E2E", title: "Direktur" }, ctx());
    // Second signer so the editor round-trip is observable (the first one
    // auto-claims the default and prefills the editor via profile sync).
    await createSigner({ name: "Penanda Kedua", title: "Finance" }, ctx());
  });

  test.afterAll(async () => {
    test.setTimeout(60_000);
    await db.invoiceProfile.deleteMany({ where: { organizationId } });
    await db.signer.deleteMany({ where: { organizationId } });
    await db.bankAccount.deleteMany({ where: { organizationId } });
    await db.membership.deleteMany({ where: { organizationId } });
    await db.organization.deleteMany({ where: { id: organizationId } });
  });

  test("token notes: unknown token literal + warning in the preview", async ({ page }) => {
    await login(page);
    await page.goto("/invoices/new");

    // The warning banner names the unknown token (spec Check When Done).
    const warning = page.locator('[role="status"]').filter({
      hasText: "Token catatan tidak dikenali",
    });
    await expect(warning).toBeVisible({ timeout: 30_000 });
    await expect(warning).toContainText("{FOOBAR}");

    // The document preview keeps {FOOBAR} literal but resolves {INVOICE_NUMBER}
    // to the real draft preview number — nothing is silently rewritten.
    const document = page.getByLabel("Pratinjau invoice");
    await expect(document).toContainText("token asing {FOOBAR}");
    await expect(document).toContainText("Nomor preview INV/E10/");
    await expect(document).not.toContainText("{INVOICE_NUMBER}");
  });

  test("editor dropdowns are org-scoped and masked", async ({ page }) => {
    await login(page);
    await page.goto("/invoices/new");

    const document = page.getByLabel("Pratinjau invoice");
    // The first account/signer claimed the default at fixture time, so the
    // editor prefills them — the document starts on BCA E2E.
    await expect(document).toContainText("BCA E2E a.n.", { timeout: 30_000 });

    // Rekening tujuan: both options are org-scoped and carry the mask, never
    // the digits (spec: list/menu tampil masked).
    const bankTrigger = page.getByLabel("Rekening tujuan");
    await bankTrigger.click();
    await expect(
      page.getByRole("option").filter({ hasText: "**** **** 7666" }),
    ).toBeVisible();
    await expect(
      page.getByRole("option").filter({ hasText: "**** **** 3456" }),
    ).toBeVisible();
    await expect(page.locator("body")).not.toContainText(BANK_A_NUMBER);
    await expect(page.locator("body")).not.toContainText(BANK_B_NUMBER);
    await page.getByRole("option", { name: /Mandiri E2E/ }).click();
    await expect(page.getByRole("option")).toHaveCount(0); // accepted → popup closed
    // The document now renders the OTHER account — the selection round-trips.
    await expect(document).toContainText("Mandiri E2E a.n.");

    // Penanda tangan: same org-scoped list; switching signer is observable in
    // the signature block of the document.
    const signerTrigger = page.getByLabel("Penanda tangan");
    await signerTrigger.click();
    await page.getByRole("option", { name: /Penanda Kedua/ }).click();
    await expect(page.getByRole("option")).toHaveCount(0);
    await expect(document).toContainText("Penanda Kedua");
    await expect(document).not.toContainText("Penanda E2E");
  });

  test("list masks the number; the authorized detail carries the full one", async ({ page }) => {
    await login(page);
    await page.goto("/bank-accounts");

    await expect(page.getByText("BCA E2E")).toBeVisible();
    await expect(page.getByText("**** **** 7666")).toBeVisible();
    await expect(page.getByText("**** **** 3456")).toBeVisible(); // Mandiri
    // The plaintext number never reaches the list HTML.
    await expect(page.locator("body")).not.toContainText(BANK_A_NUMBER);
    await expect(page.locator("body")).not.toContainText(BANK_B_NUMBER);

    await page.goto(`/bank-accounts/${bankDefaultId}`);
    // OWNER holds bankAccount.update → the form input carries the full number.
    await expect(page.locator("#accountNumber")).toHaveValue(BANK_A_NUMBER);
  });

  test("“Jadikan utama” from the list really moves the default", async ({ page }) => {
    await login(page);
    await page.goto("/bank-accounts");

    const defaultRow = page.locator(`tr:has-text("BCA E2E")`);
    const secondRow = page.locator(`tr:has-text("Mandiri E2E")`);
    // Exact text: after the switch the losing row renders a "Jadikan utama"
    // button, which a substring matcher would happily call "Utama".
    const badge = (row: typeof defaultRow) => row.getByText("Utama", { exact: true });
    await expect(badge(defaultRow)).toBeVisible();

    // The default row never offers the button; the other one does.
    await expect(defaultRow.getByRole("button", { name: /Jadikan utama/ })).toHaveCount(0);
    await secondRow.getByRole("button", { name: /Jadikan utama/ }).click();

    await expect(badge(secondRow)).toBeVisible({ timeout: 15_000 });
    await expect(badge(defaultRow)).toHaveCount(0);

    const defaults = await db.bankAccount.findMany({
      where: { organizationId, isDefault: true },
    });
    expect(defaults).toHaveLength(1);
    expect(defaults[0]!.id).toBe(bankSecondId);
  });

  test("signers page renders the org's signers", async ({ page }) => {
    await login(page);
    await page.goto("/signers");
    await expect(page.getByText("Penanda E2E")).toBeVisible();
    await expect(page.getByText("Direktur")).toBeVisible();
  });
});
