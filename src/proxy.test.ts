// src/proxy.test.ts — Change 14 unit: route protection without a third party.
//
// The proxy is the app's front gate: every non-public page redirects to
// /login unless the request carries a better-auth session cookie. Change 14
// rewrote this decision from Clerk's middleware to a local cookie read, so
// the behavior worth pinning is exactly what the swap promised (spec,
// "Middleware / proxy"): "melakukan proteksi route yang sama dengan keputusan
// redirect identik" — the same protection, the same redirect.
//
// Unit tier because the decision is pure: cookie present → pass, cookie
// absent → /login?callbackUrl=<path>. Which token is valid is better-auth's
// business (covered by the HTTP integration suite); the proxy only inspects
// the cookie's presence, by design (the render tree re-checks the session
// server-side — defense in depth, see src/proxy.ts).
//
// What is deliberately NOT asserted: that a *forged* cookie is rejected.
// The proxy never validates the signature — that is getSession()'s job, and
// the dashboard layout re-runs it before rendering anything. A test claiming
// the proxy rejects a bad token would be locking in behavior the code does
// not have and should not have.

import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import proxy from "@/proxy";

function request(path: string, cookie?: string): NextRequest {
  const url = `http://localhost:3000${path}`;
  return new NextRequest(new Request(url, cookie ? { headers: { cookie } } : undefined));
}

/** What a passing-through proxy yields: either a NextResponse.next() (200)
 *  or `undefined`, which Next's adapter turns into NextResponse.next()
 *  itself (`response ? response : NextResponse.next()` in the web adapter).
 *  Both mean "no redirect, let the route render" — that is the contract. */
function passthrough(response: Response | undefined): boolean {
  const status = response?.status;
  return status === undefined || status === 200;
}

function redirectLocation(response: Response | undefined): URL | null {
  const location = response?.headers.get("location");
  return location ? new URL(location) : null;
}

describe("proxy — anonymous requests are redirected to /login", () => {
  it("redirects /dashboard to /login with the original path as callbackUrl", async () => {
    const response = await proxy(request("/dashboard"));
    expect(response?.status).toBe(307);
    const location = redirectLocation(response);
    expect(location?.pathname).toBe("/login");
    expect(location?.searchParams.get("callbackUrl")).toBe("/dashboard");
  });

  it("redirects a deep dashboard route, preserving the path", async () => {
    const path = "/invoices/clx123abc/edit";
    const response = await proxy(request(path));
    expect(response?.status).toBe(307);
    const location = redirectLocation(response);
    expect(location?.searchParams.get("callbackUrl")).toBe(path);
  });
});

describe("proxy — public pages render without a session", () => {
  // The local login + register pages and the legal pages
  // (security-standards: /privacy and /terms must be public).
  const PUBLIC = ["/login", "/register", "/privacy", "/terms"];

  for (const path of PUBLIC) {
    it(`lets ${path} through anonymously`, async () => {
      const response = await proxy(request(path));
      expect(passthrough(response)).toBe(true);
      expect(redirectLocation(response)).toBeNull();
    });
  }

  it("lets sub-routes of a public page through (/login/callback)", async () => {
    const response = await proxy(request("/login/some-third-party-callback"));
    expect(passthrough(response)).toBe(true);
  });
});

describe("proxy — a request carrying the session cookie passes", () => {
  it("lets /dashboard through with a better-auth session cookie", async () => {
    const response = await proxy(request("/dashboard", "better-auth.session_token=abc.123"));
    expect(passthrough(response)).toBe(true);
    expect(redirectLocation(response)).toBeNull();
  });

  it("does not care about other cookies — only the session cookie counts", async () => {
    const response = await proxy(request("/dashboard", "theme=dark; _ga=GA1.2.x"));
    expect(response?.status).toBe(307);
    expect(redirectLocation(response)?.pathname).toBe("/login");
  });
});

describe("proxy — routes the handler itself short-circuits", () => {
  // The matcher in config excludes /api, static assets, /health and /robots
  // at the framework level, so Next never calls the handler for them. What
  // the handler OWNS and must short-circuit is /print (its own signed
  // token, feature 06) — asserted here; the rest is documentational.
  it("does not touch /print (its own signed token gate, feature 06)", async () => {
    const print = await proxy(request("/print/invoices/clx1"));
    expect(passthrough(print)).toBe(true);
    expect(redirectLocation(print)).toBeNull();
  });

  it("still protects a dashboard route (the gate is not open)", async () => {
    const response = await proxy(request("/dashboard"));
    expect(response?.status).toBe(307);
  });
});
