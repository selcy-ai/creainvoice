// src/proxy.ts — route protection (Change 14: self-hosted better-auth).
//
// Next 16 renamed the middleware convention to proxy.ts — same contract, see
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md.
//
// The proxy reads the better-auth session cookie and redirects anonymous
// users to /login, exactly the decisions the Clerk middleware made. The
// render tree performs the same check again with getSession() (defense in
// depth — a compromised edge must not mean a bypass). The session token is
// only inspected to decide the redirect; every authorization decision that
// matters still runs server-side against the workspace scope re-validated
// from the database.
//
// /api is excluded: auth endpoints are public by definition and the rest of
// the API checks the session cookie themselves; /print authenticates with
// its own signed short-lived token (feature 06).

import { NextResponse, type NextRequest } from "next/server";
import { tokenFromCookieHeader } from "@/lib/auth";

// Pages reachable WITHOUT a session: the local login + register pages and
// the legal pages (security-standards: /privacy and /terms must be public).
const PUBLIC_PATHS = ["/login", "/register", "/privacy", "/terms"];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

export default async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // The internal print route carries its own signed token (feature 06).
  if (pathname.startsWith("/print")) return;
  if (isPublicPath(pathname)) return;

  const cookie = request.headers.get("cookie") ?? "";
  const token = tokenFromCookieHeader(cookie);
  if (!token) {
    const login = new URL("/login", request.url);
    login.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(login);
  }

  return NextResponse.next();
}

export const config = {
  // Excludes: API routes (their own auth: the better-auth session cookie or
  // the signed print token), static assets, health endpoint, and the
  // internal print route (feature 06).
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|health|robots.txt|print).*)"],
};
