# Review — Change 14: Swap Clerk → self-hosted better-auth

**Mode:** review (fresh-model read of the diff; no code touched, nothing committed)
**Reviewed range:** `d937bdd..92daede` (feature commit) + uncommitted changes + 5 untracked files
**Date:** 2026-10-29
**Reviewers:** two independent fresh models — `omniroute/agentrouter/claude-opus-5-5` (errored), then `9router/ag/claude-sonnet-4-6` (R1) and `omniroute/hcnsec/DeepSeek-V4-Pro` (R2) in parallel. This document is the main-thread **adjudication** of both reports: every claim below was re-read in the working tree by the orchestrating agent, and the two disputed BLOCK claims from R2 were independently verified against `node_modules` before being dropped or kept.

## Verdict: FINDINGS — 1 should-fix before close

The auth core is sound. The migration contract (`AuthSession` shape preserved for all 34 consumers), the multi-tenant regression guard, and the IDOR guard all hold as built. One real defect ships in the diff and is already documented in the tree; everything else is nits and pre-existing conditions.

---

## SHOULD FIX BEFORE CLOSE

### S1 — Sign-out never ends the session server-side; "Keluar" leaves a valid session (Change 14 regression)

**`src/components/layout/app-shell.tsx:297`**

```ts
await fetch("/api/auth/sign-out", { method: "POST" });
```

**What the code does:** `UserMenu`'s sign-out POSTs to better-auth's `/sign-out` **with no `Content-Type` header and no body**. better-auth's router is constructed with `allowedMediaTypes: ["application/json"]` (`node_modules/better-auth/dist/api/index.mjs:164`), and better-call throws `APIError(415)` out of `getBody` when a body is present but the content type is missing (`node_modules/better-call/dist/utils.mjs:8–18`). The component ignores the response status, then unconditionally `router.push("/login")`.

**Verified, not just claimed:** beyond the dev-server log already on record (`POST /api/auth/sign-out 415 in 92ms`), I reproduced the transport behaviour directly against the installed `better-call@1.7.14` router with better-auth's exact route config — a POST with an empty body and no content type returns **415**, while a JSON POST succeeds. A truly bodyless `fetch(url, {method:"POST"})` is **not** rejected at the transport layer (see N1 for the honest version of this), but the recorded 415 shows the fetch as issued is rejected, so **`handleSignOut` never executes better-auth's sign-out handler** — the `session` row is not deleted and the session cookie survives. `router.push("/login")` still happens, so manual use *looks* signed out; reload `/dashboard` and you are back in.

**Why it matters:** this is a security-standards line, not a preference. `context/security-standards.md:14` — "Logout mengakhiri session server-side, tidak hanya menghapus cookie." The revoked-but-valid cookie is also the only remaining path by which a stolen session survives an honest user's logout.

**Status:** this is already filed as `context/debt-signout-session-not-ended.md` (found 2026-10-29 by `@selcy-test`) with a deliberately-red test in `tests/e2e/auth-change14.spec.ts` kept red on purpose. It is real, it is unshipped work, and it belongs to Change 14's own surface. **Fix in `@selcy-implement`:** send the JSON the endpoint requires —
`fetch("/api/auth/sign-out", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })` — assert on the response status before redirecting, and turn the intentionally-red e2e green.

---

## Verified correct — claims that did NOT survive adjudication

The two most serious findings from the fresh reviewers were investigated and **dropped as unfounded**. Recorded here so the next reader doesn't re-litigate them.

- **NOT a finding — "change-email token lets anyone verify a victim's email."** R2 read better-auth's `email-verification.mjs:197` handler and concluded that `POST /api/auth/verify-email` with a `requestType: "change-email-confirmation"` token sets `emailVerified: true` with no caller check. The premise is false: that code path only runs if a `change-email-confirmation` token was ever issued. I traced the token issuer (`update-user.mjs:487`) and it fires **only** when `canSendConfirmation = sendVerificationEmail && user.emailVerified && options.user.changeEmail.sendChangeEmailConfirmation` is configured. This app sets **none** of those — `changeEmail` is never enabled (default `enabled: false`), and the never-sent-verification path proves it (`lib/auth.ts:217` only logs). No token can be minted in this config, and better-auth's normal verify path *unverifies* the target by default. **Dropped.**
- **NOT a finding — "sign-up maps `emailVerified` to the wrong column."** R2 claimed `userFields` maps `emailVerified: "emailVerified"` onto the `image_url` column. Read of `src/db/schema.ts:138-152` + `lib/auth.ts:165-170`: `users.emailVerified` is `boolean("email_verified").notNull().default(false)` and the field map is standard better-auth `fieldName: columnName` mapping to that column. The claim is simply a misreading of the mapping object's direction. The `email_verified = false` on public sign-up is **the intended gate** — `requireEmailVerification: true` + no SMTP means public sign-up creates an account that cannot log in until an operator completes the logged verification URL. That is the security-standards bar ("verifikasi email sebelum bisa login") operating exactly as specified; the `sendVerificationEmail` log-only behaviour is already tracked in progress-tracker Open Questions as an SMTP feature, not a bug.

Also cleared by both reviewers and re-read in-tree: `setActiveOrganization` (`lib/auth.ts:464–492`) verifies ACTIVE membership + non-SUSPENDED org before writing `sessions.activeOrganizationId`, and scopes the write by both token *and* userId — the workspace switch is safe, cross-org switch to a non-member org throws FORBIDDEN. `resolveWorkspaceScope` re-validates from the DB on every read (fail-closed). Onboarding step 1 (`onboarding/actions.ts:109–130`) writes org + membership in one Drizzle transaction and cannot join an arbitrary org (server-generated ids; the select branch's session write still goes through the verifying `setActiveOrganization`). The 20→19 `AuditAction` enum drop has **zero dangling consumers** (`grep ORGANIZATION_DELETED` in `src/` returns nothing). Cookies are `HttpOnly` + `SameSite=lax` + `Secure` in production, asserted by `tests/integration/auth-http-change14.test.ts`. `$argon2` prefix routing + scrypt fallback are both exercised by tests.

---

## NIT

- **N1 — `src/proxy.ts:36–44`** — the proxy inspects **cookie presence, not signature**. A forged `better-auth.session_token=anything` passes the edge redirect gate. This is a documented design decision (the header comment says so; `src/proxy.test.ts` explicitly declines to assert forged-cookie rejection), and every authorization decision that matters re-runs server-side against the DB — so it cannot leak data. It does let a scanner with one crafted cookie render-protect every page and pay a DB round-trip per request. Cheapest hardening, optional: also require the token to contain better-auth's `.` signature separator. Not required for close.
- **N2 — `src/app/api/workspace/switch/route.ts:53–55`** — the catch maps every non-FORBIDDEN `AppError` to 401 (`error.code === "FORBIDDEN" ? 403 : 401`). Correct today (only UNAUTHORIZED/FORBIDDEN are thrown there), but per `context/error-handling.md` the contract maps codes to statuses per-category; if a NOT_FOUND/CONFLICT is ever thrown here it will surface as a wrong 401. Replace with the shared code→status helper when convenient.
- **N3 — `src/lib/auth.ts:44–51`** — the module-scope argon2 probe is fire-and-forget (`void argon2.hash("probe").then(...)`), so `argon2Available` starts `false` and the first `hashPassword` after a cold start can fall through to scrypt. `verifyPassword` already calls `ensureHasherReady()`; **`hashPassword` does not** (`:100–110`). The `verify` path is the security-relevant one and it is covered, and the scrypt fallback is still safe — but the spec's "argon2 direkomendasian" + the `$argon2` assertion in `auth-http-change14.test.ts` are satisfied *eventually*, not on the first hash. One-line fix: `await ensureHasherReady()` at the top of `hashPassword`. Note this is also defensively covered for the seed admin, whose hash is minted via `argon2.hash` directly in `scripts/seed.mjs:324`.
- **N4 — `scripts/seed.mjs:309–337`** — the admin `user` row is upserted **before** `seedAdminPassword()` is called (line 323). If `SEED_ADMIN_PASSWORD` is missing/short, the seed exits *after* writing a pre-verified user with no credential account — a half-seeded DB. Cheap fix: hoist `const password = seedAdminPassword()` above the user upsert. There is no evidence log containing `SEED_ADMIN_PASSWORD` anywhere (only the email is printed), so the secret-handling itself is clean.
- **N5 — R2's app-shell "duplicate `import { LogoIcon, LogoIcon }`" claim is false** — no such duplicate exists (verified at `app-shell.tsx:3–35`). Dropped as a misread.

---

## Pre-existing (out of scope — for @selcy-debt, not Change 14)

- **Suspended users keep their session.** `resolveWorkspaceScope` (`workspace/service.ts:39–75`) checks `memberships.status` but never re-reads `users.status`; a SUSPENDED user holding a valid session keeps full org access until the session expires. `security-standards.md` has a `USER_SUSPENDED` action with no read-path enforcement. Present since Change 6's flat workspace; Change 14 did not widen it.
- **Suspended org blocks the write path but not the read path.** `setActiveOrganization` refuses a SUSPENDED org; `resolveWorkspaceScope` returns a scope for an ACTIVE membership inside a SUSPENDED org. Asymmetric on purpose-but-undocumented.
- **`context/data-model.md` is stale.** It still lists 30 canonical `AuditAction` values; the enum has 19 after Change 6's reductions and Change 14's `ORGANIZATION_DELETED` drop. The emit-points test only iterates the 19 that exist, so it can no longer prove the documented contract. Spec-side drift, worth a sync under `@selcy-sync`.
- **`drizzle-kit push --force` runs unconditionally on every container start** (`docker-entrypoint.sh`, `Dockerfile`). Fine for the single-replica Dokploy target and verified idempotent by 11C; multi-replica starts would race on schema. Pre-existing pattern from 11C's entrypoint, carried into Change 14's drizzle variant.
- **R2 also asserted `getWorkspaceOverview` includes SUSPENDED orgs in the switcher** — marked pre-existing, but I did not independently confirm this one and flag it as *unverified* rather than confirmed.

---

## Notes

**On the reviewers.** The two fresh models did not agree, and their disagreements were the valuable part. R1 produced a calibrated list but overclaimed one finding (the onboarding "select" branch as a BLOCK — the silent catch is bounded by `setActiveOrganization`'s own verification and the next read's `resolveWorkspaceScope`, so the real impact is a no-op plus an org-id echo: NIT material, downgraded). R2's two highest-severity findings were both **fabricated premises** — a change-email token path gated behind config the app never sets, and a field-mapping direction read backwards — which is exactly what the skill's "a grep is not a finding" rule exists to catch. Both BLOCK claims were reproduced-against-source and dropped. The signout defect, by contrast, was flagged by R2, matched an existing debt file, and **survived** empirical verification.

**Evidence I could not run here.** No Postgres or dev server is available in this environment, so the integration suite was not re-executed; findings rest on code reads plus the transport repro described in S1. The progress tracker records 611/613 with 2 pre-existing PDF-render flakes at clean HEAD, and Change 14's own verification log is consistent with that baseline.

**Owed decisions (already in progress-tracker Open Questions — no action needed here):** `BETTER_AUTH_TRUSTED_ORIGINS` Dokploy origin unknown; `SEED_ADMIN_PASSWORD` rotation (see S1's neighbour N4); SMTP transport for email verification.
