# updateProfile throws "No values to set" when a save changes nothing

Discovered 2026-10-29 by `@selcy-test` while running the Change 14 E2E suite
(`tests/e2e/onboarding.spec.ts`, "wizard 12 langkah").

## Symptom

The 12-step onboarding wizard dies at the transition from step 9 (Pola nomor
invoice) to step 10. The step counter stays at 9 and the Next button appears
to do nothing. In the dev log:

```
{"level":"error","module":"onboarding.actions","err":"No values to set","msg":"server action gagal"}
```

## Root cause

`src/modules/profiles/service.ts` (`updateProfile`) short-circuits to an empty
update when every submitted field equals the value already stored:

```ts
for (const key of Object.keys(input)) {
  const next = input[key];
  if (next === undefined) continue;
  const current = (profile as ...)[key];
  if (String(currentComparable ?? "") !== String(next ?? "")) {
    changed.push(key);   // ← empty when the values match
  }
}
// ...
await db.update(invoiceProfiles).set(data).where(...)  // ← .set({}) throws
```

Drizzle rejects an empty `.set()` with `Error: "No values to set"`
(`node_modules/drizzle-orm/utils.js:92`). The exception propagates out of
`saveNumberingAction` as `INTERNAL_ERROR`, so the wizard never advances.

The wizard's step 9 submits `numberPattern = "INV/{CODE}/{ROMAN_MONTH}/{YYYY}/{SEQ:3}"`
and `sequenceResetPolicy = "YEARLY"` — **exactly the column defaults**
(`src/db/schema.ts`, `number_pattern` / `sequence_reset_policy`). A user who
accepts the defaults on a fresh profile therefore always hits this path.

## Not introduced by Change 14

`git diff feat-13..feat-14 -- src/modules/profiles/service.ts` is empty — the
file is byte-identical across the auth swap, and the failing interaction
(numbering step) is unchanged. The bug is pre-existing; Change 14 merely
brought the suite far enough to reach it.

## Why only the E2E suite sees it

The integration tests drive `updateProfile` with values that differ from the
stored row, so `changed` is never empty. Only the full browser walkthrough
re-saves the defaults.

## Fix (for @selcy-implement)

Treat "nothing changed" as a success, not an error — the caller asked for a
state that already exists:

```ts
if (Object.keys(data).length === 0) {
  return profile;   // (or re-fetch) — nothing to write is not an error
}
```

Reproduces deterministically: onboarding wizard, step 9, press Lanjut without
changing the pattern.
