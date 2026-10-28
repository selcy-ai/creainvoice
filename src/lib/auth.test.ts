// src/lib/auth.test.ts — Change 14 unit: the session-cookie token parser the
// proxy (src/proxy.ts) uses to decide every redirect.
//
// tokenFromCookieHeader is the one piece of the auth swap that is pure logic,
// so it earns the pyramid's unit tier: every failure mode must collapse to
// `null` (fail closed → redirect to /login), never throw and never return a
// garbage string that looks like a session. The proxy's whole protection
// decision rests on this single function.
//
// What is deliberately NOT here: getSession/requireSession, the better-auth
// instance and the database path. Those are integration concerns and live in
// tests/integration/auth-change14.test.ts + auth-http-change14.test.ts.

import { describe, expect, it } from "vitest";
import { tokenFromCookieHeader } from "@/lib/auth";

describe("tokenFromCookieHeader", () => {
  it("extracts the better-auth session token", () => {
    const cookie = "better-auth.session_token=abc123";
    expect(tokenFromCookieHeader(cookie)).toBe("abc123");
  });

  it("finds the session token among other cookies", () => {
    const cookie =
      "theme=dark; better-auth.session_token=token-from-the-middle; _ga=GA1.2.x";
    expect(tokenFromCookieHeader(cookie)).toBe("token-from-the-middle");
  });

  it("stops at the first semicolon (trailing cookies do not bleed in)", () => {
    const cookie = "better-auth.session_token=abc123; other=1";
    expect(tokenFromCookieHeader(cookie)).toBe("abc123");
  });

  it("returns null when the cookie is absent", () => {
    expect(tokenFromCookieHeader("theme=dark; _ga=GA1.2.x")).toBeNull();
  });

  it("returns null for an empty header", () => {
    expect(tokenFromCookieHeader("")).toBeNull();
  });

  it("returns null when the token value is empty", () => {
    // `value ? … : null` in the source — an empty value must not become "".
    expect(tokenFromCookieHeader("better-auth.session_token=")).toBeNull();
  });

  it("decodes the URL-encoded token better-auth sets", () => {
    // Signed cookie values are URI-encoded (tests/helpers/auth.ts signs the
    // same way). The parser must hand back the raw token, not the encoded one.
    const token = "abc 123/def";
    const encoded = encodeURIComponent(token);
    expect(tokenFromCookieHeader(`better-auth.session_token=${encoded}`)).toBe(token);
  });

  it("does not match a similarly-named cookie", () => {
    // A lookalike must never be accepted as a session.
    expect(tokenFromCookieHeader("better-auth.session_token_legacy=abc")).toBeNull();
  });

  it("picks the better-auth token over a similarly-prefixed cookie", () => {
    const cookie =
      "better-auth.session_token_legacy=legacy; better-auth.session_token=real";
    expect(tokenFromCookieHeader(cookie)).toBe("real");
  });
});
