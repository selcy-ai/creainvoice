// tests/e2e/auth-change14.spec.ts — Change 14: the local login + register pages.
//
// What only a browser can prove about the auth swap:
//   • /login renders the app's OWN form (no third-party component), accepts
//     email + password, and a real sign-in lands the user on /dashboard with
//     a local session cookie (the "Login sungguhan" Check When Done item).
//   • /register exists, creates an account through better-auth, and — because
//     the app requires email verification before a session — routes the user
//     to the login page instead of straight in (the public sign-up gate).
//   • The shell's sign-out (UserMenu, which replaced Clerk's <UserButton/>)
//     ends the session and returns to /login.
//
// Fixtures write REAL rows into the dev database (tests/factories createUser
// now stores a real argon2 credential) and are removed in afterAll, matching
// the contract the other specs in this directory use (setup-env forces
// DATABASE_URL from .env.local so the rows land where the dev server reads).

import "./setup-env";
import { expect, test, type Page } from "@playwright/test";
import { db } from "@/tests/helpers/test-db";
import { createOrganization, createUser, type TestUser } from "../factories";

const PASSWORD = "PasswordE2E123";

let user: TestUser;
let organizationId: string;

test.beforeAll(async () => {
  user = await createUser({
    password: PASSWORD,
    name: "Auth E2E",
    onboardingComplete: true,
  });
  const org = await createOrganization("Auth E2E Org");
  organizationId = org.id;
  // The membership that makes the dashboard resolve an active workspace.
  await db.membership.create({ data: { userId: user.id, organizationId: org.id, status: "ACTIVE" } });
});

test.afterAll(async () => {
  if (!user) return;
  // Scoped cleanup — other rows of the dev DB stay untouched (same contract
  // as the other specs). Sessions/accounts cascade on user delete.
  await db.auditLog.deleteMany({ where: { actorUserId: user.id } });
  await db.membership.deleteMany({ where: { userId: user.id } });
  await db.organization.deleteMany({ where: { id: organizationId } });
  await db.user.deleteMany({ where: { id: user.id } });
});

/** Signs the fixture user in through the real form. */
async function login(page: Page, who: TestUser = user): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(who.email);
  await page.locator("#password").fill(PASSWORD);
  await Promise.all([
    // better-auth's sign-in answers 200 on success; the form then routes.
    page.waitForResponse(
      (response) =>
        response.url().includes("/api/auth/sign-in/") &&
        response.request().method() === "POST",
    ),
    page.getByRole("button", { name: "Masuk", exact: true }).click(),
  ]);
}

test.describe("Change 14 — local login page", () => {
  test("renders the app's own form (no third-party component)", async ({ page }) => {
    await page.goto("/login");

    // The local card, not an iframe or a Clerk <SignIn />: the fields live in
    // the app's DOM and POST to the app's own auth route.
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Kata sandi")).toBeVisible();
    await expect(page.getByRole("button", { name: "Masuk", exact: true })).toBeVisible();
    // The register link is part of the swap (the page is new in Change 14).
    await expect(page.getByRole("link", { name: "Daftar" })).toBeVisible();
  });

  test("a real sign-in lands on /dashboard with a local session cookie", async ({ page }) => {
    await login(page);
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 60_000 });
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 60_000 });

    // The cookie the app reads: better-auth.session_token, set by the app's
    // own route (not a third-party domain).
    const cookies = await page.context().cookies();
    const session = cookies.find((cookie) => cookie.name === "better-auth.session_token");
    expect(session?.value).toBeTruthy();
  });

  test("refuses a wrong password and stays on /login", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(user.email);
    await page.locator("#password").fill("salah-sekali-123");
    await page.getByRole("button", { name: "Masuk", exact: true }).click();

    // The form surfaces the failure inline (error-handling.md: field/form
    // error with a clear Bahasa Indonesia message) and does not redirect.
    await expect(page.locator('p[role="alert"]')).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe("Change 14 — public register page", () => {
  test("renders the sign-up form", async ({ page }) => {
    await page.goto("/register");
    await expect(page.getByLabel("Nama")).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
    // Two password fields (password + confirm) — addressed by id, since both
    // carry the label "Kata sandi".
    await expect(page.locator("#password")).toBeVisible();
    await expect(page.locator("#confirm")).toBeVisible();
    await expect(page.getByRole("button", { name: "Daftar", exact: true })).toBeVisible();
  });

  test("creates the account then routes to /login (verification gate)", async ({ page }) => {
    const email = `daftar-e2e-${Date.now().toString(36)}@test.local`;
    await page.goto("/register");
    await page.getByLabel("Nama").fill("User Daftar E2E");
    await page.getByLabel("Email").fill(email);
    await page.locator("#password").fill(PASSWORD);
    await page.locator("#confirm").fill(PASSWORD);
    await page.getByRole("button", { name: "Daftar", exact: true }).click();

    // The account IS created…
    await expect.poll(async () => {
      const rows = await db.user.findMany({ where: { email } });
      return rows.length;
    }, { timeout: 30_000 }).toBe(1);

    // …but no session is issued before the email is verified, so the user is
    // sent to log in rather than into the app.
    await page.waitForURL(/\/login/, { timeout: 30_000 });
    const cookies = await page.context().cookies();
    expect(cookies.find((cookie) => cookie.name === "better-auth.session_token")).toBeUndefined();

    // Cleanup: the unverified row this test created.
    await db.user.deleteMany({ where: { email } });
  });

  test("blocks register when the passwords do not match", async ({ page }) => {
    await page.goto("/register");
    await page.getByLabel("Nama").fill("User Tidak Cocok");
    await page.getByLabel("Email").fill(`tidak-cocok-${Date.now().toString(36)}@test.local`);
    await page.locator("#password").fill(PASSWORD);
    await page.locator("#confirm").fill("berbeda-sama-sekali");
    await page.getByRole("button", { name: "Daftar", exact: true }).click();

    await expect(page.locator("p").filter({ hasText: /tidak cocok/i })).toBeVisible();
    await expect(page).toHaveURL(/\/register/);
  });
});

test.describe("Change 14 — sign-out from the shell", () => {
  // S1 (fixed): the shell's UserMenu used to POST /api/auth/sign-out with no
  // Content-Type. better-auth's /sign-out declares a JSON body, so that POST
  // answered 415 and the endpoint never ran — the session row survived and
  // the cookie stayed valid behind a client-side redirect. The menu now sends
  // a JSON body and asserts the response before leaving. This test stays the
  // security-standards bar: "logout mengakhiri session server-side".
  test("the user menu signs out, returns to /login and ends the session", async ({ page }) => {
    await login(page);
    await page.waitForURL(/\/dashboard/, { timeout: 60_000 });

    // The shell's local account menu (replaces Clerk's <UserButton />).
    await page.getByRole("button", { name: "Menu akun" }).click();
    await page.getByRole("menuitem", { name: "Keluar" }).click();

    // The sign-out must reach the endpoint and be accepted (not 415).
    await page.waitForURL(/\/login/, { timeout: 60_000 });

    // security-standards: logout mengakhiri session server-side — the cookie
    // the app reads must be gone, not merely navigated away from.
    const cookies = await page.context().cookies();
    expect(cookies.find((cookie) => cookie.name === "better-auth.session_token")).toBeUndefined();
  });
});
