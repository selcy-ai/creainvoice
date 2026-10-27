// src/components/layout/nav-config.test.ts
// The sidebar is the navigation contract: every link points at a route that
// exists, and (Change 6) the platform admin panel is gone — the flat
// workspace has one nav group and every member is a full admin of it.

import { describe, expect, it } from "vitest";
import { NAV_GROUPS, visibleLinks, type NavVisibility } from "@/components/layout/nav-config";

// Static route manifest (kept in sync by hand — the dynamic [id] routes are
// reached from their list pages, not from the sidebar).
const ROUTES = new Set([
  "/dashboard",
  "/onboarding",
  "/invoices",
  "/invoices/new",
  "/payments",
  "/customers",
  "/customers/new",
  "/projects",
  "/projects/new",
  "/profiles",
  "/bank-accounts",
  "/bank-accounts/new",
  "/signers",
  "/signers/new",
  "/privacy",
  "/terms",
]);

describe("nav-config", () => {
  it("exposes exactly one workspace group (Change 6: no platform admin group)", () => {
    expect(NAV_GROUPS.length).toBe(1);
    expect(NAV_GROUPS[0]?.title).toBe("Ruang kerja");
  });

  it("guards the check itself: the manifest is not empty", () => {
    expect(ROUTES.has("/dashboard")).toBe(true);
  });

  it("every workspace link points at a real route", () => {
    for (const group of NAV_GROUPS) {
      for (const link of group.links) {
        expect({ href: link.href, exists: ROUTES.has(link.href) }).toEqual({
          href: link.href,
          exists: true,
        });
        expect(link.label.length).toBeGreaterThan(0);
        expect(link.icon).toBeDefined();
      }
    }
  });

  it("no link points at the removed /admin platform pages", () => {
    for (const group of NAV_GROUPS) {
      for (const link of group.links) {
        expect(link.href.startsWith("/admin")).toBe(false);
      }
    }
  });

  it("visibleLinks keeps gated entries only when the workspace has them", () => {
    const workspace: NavVisibility = {
      payments: true,
      customers: true,
      projects: true,
      bankAccounts: true,
      signers: true,
    };
    const open = visibleLinks(NAV_GROUPS[0]!.links, workspace);
    expect(open.length).toBe(NAV_GROUPS[0]!.links.length);

    const closed = visibleLinks(NAV_GROUPS[0]!.links, {
      payments: false,
      customers: false,
      projects: false,
      bankAccounts: false,
      signers: false,
    });
    // The never-gated entries: dashboard, invoices, and the org's own profile
    // (every workspace has exactly one — there is nothing to gate it on).
    expect(closed.length).toBe(3);
    expect(closed.map((link) => link.href)).toEqual([
      "/dashboard",
      "/invoices",
      "/profiles",
    ]);
  });
});
