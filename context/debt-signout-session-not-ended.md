# Sign-out does not end the session server-side (Change 14 regression)

Discovered 2026-10-29 by `@selcy-test` while testing Change 14 (`tests/e2e/auth-change14.spec.ts`).

## Symptom

The shell's "Keluar" menu item redirects to `/login` but the session survives:
the `better-auth.session_token` cookie is still present and the `session` row
is never deleted. Reloading `/dashboard` right after "signing out" renders the
dashboard, not the login page.

## Evidence

Dev-server log while clicking the menu item:

```
POST /api/auth/sign-out 415 in 92ms
POST /api/auth/sign-out 415 in 46ms
```

The failing test (`tests/e2e/auth-change14.spec.ts`, kept red on purpose):

```
Error: expect(received).toBeUndefined()
Received: {"name": "better-auth.session_token", "httpOnly": true, ...}
```

## Root cause

`src/components/layout/app-shell.tsx` (`UserMenu`) sends the request with no
content type and no body:

```ts
await fetch("/api/auth/sign-out", { method: "POST" });
```

better-auth's `/sign-out` endpoint declares a JSON `body` schema
(`signOutBodySchema`), so a bodyless POST never parses and the endpoint
answers **415 Unsupported Media Type** before it runs. The session row is
never deleted and `deleteSessionCookie` never executes.

The endpoint itself is correct — verified against the running app:

```
curl -X POST               http://localhost:3010/api/auth/sign-out  → 415
curl -X POST -H "Content-Type: application/json" -d '{}' <same>    → 200
```

## Why it matters

`context/security-standards.md` requires "logout mengakhiri session
server-side". A logout that only redirects is a security finding, not a UX
nit: the session stays valid and anyone re-using the cookie is still signed in.

## Status

**FIXED 2026-10-29** (`@selcy-implement` review-fix round). The fix is slightly
stronger than the one line proposed below: `handleSignOut` now asserts the
response before navigating, so a failed server-side logout surfaces a toast and
keeps the user on the page instead of producing a client that looks signed out
while the session survives. Verification, all in-process against the running app:

```
POST /api/auth/sign-out (no Content-Type)  → 415   (reproduction, session survives)
POST /api/auth/sign-out (JSON + "{}")      → 200   (session rows 5→4)
```

- `tests/e2e/auth-change14.spec.ts` — the deliberately-red test is now **green**:
  login → UserMenu → "Keluar" → HTTP 200, session row deleted, cookie gone,
  `/dashboard` redirects back to `/login` (6/6 browser checks).
- `tests/integration/auth-http-change14.test.ts` — two new contract tests pin
  the behaviour at the HTTP layer: the correct call deletes the row and expires
  the cookie, and a bodyless POST is still answered 415 (the guard so the
  component cannot silently regress to the broken call).

## Fix (applied)

```ts
const response = await fetch("/api/auth/sign-out", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
});
if (!response.ok) { toast.add({ ... }); return; }   // never navigate on failure
router.push("/login");
```

## Scope

Introduced by Change 14 (the `UserMenu` is new — it replaced Clerk's
`<UserButton />`, which handled this internally). Nothing else in the app
calls `/sign-out`.
