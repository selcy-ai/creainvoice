// tests/integration/onboarding-profile.test.ts
// Feature 02 "Check When Done" at the service layer: InvoiceProfile CRUD +
// PROFILE_CHANGED audit, VIEWER forbidden, cross-org 404, number-pattern
// validation (INV/SB/VII/2026/001 + invalid rejected with a clear message),
// bank number encrypted in the raw DB column and masked in views, logo upload
// (random filename, hostile name, oversize, fake MIME, replace/remove),
// signer default lifecycle, and the onboarding resume/complete state machine.

import { beforeAll, describe, expect, it } from "vitest";
import { isAppError, type AppError } from "@/lib/errors";
import { getStorageService } from "@/modules/storage";
import {
  createProfile,
  getProfileByOrg,
  getProfileForScope,
  numberingSchema,
  profileUpdateSchema,
  removeLogo,
  replaceLogo,
  stampModeSchema,
  updateProfile,
} from "@/modules/profiles/service";
import { previewNumber } from "@/modules/profiles/number-pattern";
import {
  getDefaultBankAccount,
  saveBankAccount,
  toBankAccountView,
} from "@/modules/bank-accounts/service";
import {
  advanceOnboardingStep,
  clampStep,
  completeOnboarding,
  getOnboardingState,
  ONBOARDING_TOTAL_STEPS,
} from "@/modules/onboarding/service";
import { listSigners, saveSigner, toSignerView } from "@/modules/signers/service";
import { db } from "@/tests/helpers/test-db";
import {
  addMembership,
  createOrganization,
  createUser,
  resetDatabase,
  type TestUser,
} from "../factories";
import { ctxFor } from "@/tests/helpers/context";

// 1×1 PNG as a plain ArrayBuffer-backed view (File parts dislike Buffer).
const PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  ),
);

const PLAIN_NUMBER = "1234 5678 3449";
const PLAIN_DIGITS = "123456783449";

let owner: TestUser;
let viewerId: string;
let org: { id: string };
let otherOrg: { id: string };


function ownerCtx(organizationId?: string) {
  return ctxFor(organizationId ?? org.id, owner.id);
}

async function expectAppFailure(promise: Promise<unknown>, code: AppError["code"]): Promise<AppError> {
  let caught: unknown = null;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(isAppError(caught)).toBe(true);
  const appError = caught as AppError;
  expect(appError.code).toBe(code);
  return appError;
}

beforeAll(async () => {
  await resetDatabase();
  owner = await createUser({ username: "profile.owner" });
  const viewer = await createUser({ username: "profile.viewer" });
  org = await createOrganization("CreaInvoice Studio");
  otherOrg = await createOrganization("Organisasi Lain");
  await addMembership(owner.id, org.id, "OWNER");
  await addMembership(viewer.id, org.id, "VIEWER");
  await addMembership(owner.id, otherOrg.id, "OWNER");
  viewerId = viewer.id;
});

function viewerCtx() {
  return ctxFor(org.id, viewerId);
}

describe("invoice profile CRUD", () => {
  it("creates with data-model defaults and writes a PROFILE_CHANGED audit", async () => {
    const profile = await createProfile(ownerCtx(), { name: "CreaInvoice Studio", code: "SB" });
    expect(profile.id).toBeTruthy();
    expect(profile.code).toBe("SB");
    expect(profile.numberPattern).toBe("INV/{CODE}/{ROMAN_MONTH}/{YYYY}/{SEQ:3}");
    expect(profile.primaryColor).toMatch(/^#[0-9a-f]{6}$/i);
    expect(profile.sequenceResetPolicy).toBe("YEARLY");
    expect(profile.isActive).toBe(true);

    const audit = await db.auditLog.findFirst({
      where: { action: "PROFILE_CHANGED", entityId: profile.id },
    });
    expect(audit).not.toBeNull();
    expect(JSON.stringify(audit?.metadata ?? {})).toContain("created");

    const duplicate = await expectAppFailure(
      createProfile(ownerCtx(), { name: "Lain", code: "XX" }),
      "CONFLICT",
    );
    expect(duplicate.message).toMatch(/sudah ada/i);
  });

  it("updates fields and audits the exact field list (PROFILE_CHANGED)", async () => {
    const profile = await getProfileByOrg(org.id);
    expect(profile).not.toBeNull();

    const updated = await updateProfile(
      profile!.id,
      { legalName: "PT CreaInvoice Studio", address: "Jl. Merdeka No. 1, Jakarta", primaryColor: "#ff5500" },
      ownerCtx(),
    );
    expect(updated.legalName).toBe("PT CreaInvoice Studio");
    expect(updated.primaryColor).toBe("#ff5500");

    const audits = await db.auditLog.findMany({
      where: { action: "PROFILE_CHANGED", entityId: profile!.id },
    });
    expect(audits.length).toBeGreaterThanOrEqual(2);
    const metadataList = audits.map((row) => JSON.stringify(row.metadata ?? {}));
    expect(
      metadataList.some((entry) => entry.includes("updated") && entry.includes("primaryColor")),
    ).toBe(true);
  });
});

describe("authorization", () => {
  it("denies VIEWER profile writes (org.settings.update is OWNER/ADMIN)", async () => {
    const profile = await getProfileByOrg(org.id);
    const failure = await expectAppFailure(
      updateProfile(profile!.id, { name: "Diedit Viewer" }, viewerCtx()),
      "FORBIDDEN",
    );
    expect(failure.message).toMatch(/izin/i);

    await expectAppFailure(
      createProfile(viewerCtx(), { name: "Palsu", code: "XX" }),
      "FORBIDDEN",
    );

    // Nothing changed on disk-of-truth.
    const after = await getProfileForScope(profile!.id, ownerCtx());
    expect(after.name).toBe("CreaInvoice Studio");
  });

  it("answers 404 for a profile from another organization and for a missing id", async () => {
    const profile = await getProfileByOrg(org.id);
    const wrongOrg = await expectAppFailure(
      getProfileForScope(profile!.id, ownerCtx(otherOrg.id)),
      "NOT_FOUND",
    );
    expect(wrongOrg.message).toMatch(/tidak ditemukan/i);

    await expectAppFailure(getProfileForScope("prof_tidak_pernah_ada", ownerCtx()), "NOT_FOUND");
  });
});

describe("number pattern validation (action-layer schemas)", () => {
  it("accepts the default pattern and previews INV/SB/VII/2026/001", () => {
    const parsed = numberingSchema.safeParse({
      numberPattern: "INV/{CODE}/{ROMAN_MONTH}/{YYYY}/{SEQ:3}",
      sequenceResetPolicy: "MONTHLY",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(
        previewNumber(parsed.data.numberPattern, {
          code: "SB",
          date: new Date(2026, 6, 1), // Juli 2026
          nextSequence: 1,
        }),
      ).toBe("INV/SB/VII/2026/001");
    }
  });

  it("rejects an unknown token with a clear Indonesian message", () => {
    const parsed = numberingSchema.safeParse({
      numberPattern: "INV/{FOO}/{SEQ:3}",
      sequenceResetPolicy: "YEARLY",
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toMatch(/Token tidak dikenal/);
      expect(parsed.error.issues[0]?.message).toContain("{SEQ:n}");
    }
  });

  it("profileUpdateSchema (the /profiles/[id] edit) validates the pattern the same way", () => {
    const base = {
      name: "CreaInvoice Studio",
      code: "SB",
      legalName: null,
      address: null,
      taxId: null,
      phone: null,
      whatsapp: null,
      fax: null,
      email: null,
      website: null,
      primaryColor: "#2563eb",
      numberPattern: "INV/{CODE}/{ROMAN_MONTH}/{YYYY}/{SEQ:3}",
      sequenceResetPolicy: "YEARLY",
      defaultTaxMode: "EXCLUSIVE",
      defaultTaxPercent: "11",
      defaultStampMode: "E_METERAI",
      defaultNotes: null,
    };
    expect(profileUpdateSchema.safeParse(base).success).toBe(true);

    const invalid = profileUpdateSchema.safeParse({ ...base, numberPattern: "tanpa-token-seq" });
    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      expect(invalid.error.issues[0]?.message).toMatch(/\{SEQ:n\}/);
    }

    const badColor = profileUpdateSchema.safeParse({ ...base, primaryColor: "biru" });
    expect(badColor.success).toBe(false);
  });

  it("stampModeSchema only accepts the four spec values", () => {
    for (const value of ["NONE", "E_METERAI", "PHYSICAL", "BLANK_SPACE"]) {
      expect(stampModeSchema.safeParse(value).success).toBe(true);
    }
    expect(stampModeSchema.safeParse("QRIS").success).toBe(false);
  });
});

describe("bank account encryption at rest", () => {
  it("stores ciphertext in the raw DB column and only surfaces a mask", async () => {
    const account = await saveBankAccount(
      {
        bankName: "Bank Central Asia",
        bankCode: "BCA",
        accountNumber: PLAIN_NUMBER,
        accountHolder: "CreaInvoice Studio",
        branch: "Jakarta",
      },
      ownerCtx(),
    );

    // Raw column value as Postgres holds it (Prisma performs no decryption).
    const raw = await db.$queryRaw<{ value: string }>`
      SELECT "accountNumberEncrypted" AS value FROM "BankAccount" WHERE id = ${account.id}`;
    expect(raw).toHaveLength(1);
    const storedValue = raw[0]!.value;
    expect(storedValue).not.toContain(PLAIN_DIGITS);
    expect(storedValue).not.toContain("1234");
    expect(storedValue).not.toContain("5678");
    expect(storedValue).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
    // Prisma's own read is byte-identical to the raw column (no transform).
    expect(account.accountNumberEncrypted).toBe(storedValue);
    expect(account.accountNumberLast4).toBe("3449");

    const view = toBankAccountView(account);
    expect(view.maskedNumber).toBe("**** **** 3449");
    expect(JSON.stringify(view)).not.toContain(PLAIN_DIGITS);

    // Linked as the profile's default payment account.
    const profile = await getProfileByOrg(org.id);
    expect(profile?.defaultBankAccountId).toBe(account.id);

    // Audit carries no account number.
    const audit = await db.auditLog.findFirst({
      where: { action: "PROFILE_CHANGED", entityType: "bankAccount", entityId: account.id },
    });
    expect(audit).not.toBeNull();
    const metadata = JSON.stringify(audit?.metadata ?? {});
    expect(metadata).not.toContain(PLAIN_DIGITS);
    expect(metadata).toContain("created");
  });

  it("keeps the stored ciphertext when the number is left empty", async () => {
    const before = await getDefaultBankAccount(org.id);
    expect(before).not.toBeNull();

    const updated = await saveBankAccount(
      {
        bankName: "Bank Mandiri",
        bankCode: null,
        accountNumber: "",
        accountHolder: "CreaInvoice Studio",
        branch: null,
      },
      ownerCtx(),
    );
    expect(updated.id).toBe(before!.id);
    expect(updated.accountNumberEncrypted).toBe(before!.accountNumberEncrypted);
    expect(updated.bankName).toBe("Bank Mandiri");
    expect(toBankAccountView(updated).maskedNumber).toBe("**** **** 3449");
  });

  it("requires a number when no account exists and rejects non-numeric digits", async () => {
    const empty = await expectAppFailure(
      saveBankAccount(
        { bankName: "BCA", bankCode: null, accountNumber: "", accountHolder: "X Y", branch: null },
        ownerCtx(otherOrg.id),
      ),
      "VALIDATION_ERROR",
    );
    expect(empty.message).toMatch(/wajib diisi/i);

    const nonNumeric = await expectAppFailure(
      saveBankAccount(
        { bankName: "BCA", bankCode: null, accountNumber: "abcabc", accountHolder: "X Y", branch: null },
        ownerCtx(),
      ),
      "VALIDATION_ERROR",
    );
    expect(nonNumeric.message).toMatch(/digit/i);
  });
});

describe("signer default lifecycle", () => {
  it("creates one default signer, updates it in place, and audits", async () => {
    const first = await saveSigner(
      { name: "Andi Wijaya", title: "Direktur", location: "Jakarta" },
      ownerCtx(),
    );
    expect(first.isDefault).toBe(true);
    expect(first.isActive).toBe(true);

    const second = await saveSigner(
      { name: "Andi Wijaya, S.E.", title: "Direktur Utama", location: "Jakarta" },
      ownerCtx(),
    );
    expect(second.id).toBe(first.id);
    expect(await listSigners(org.id)).toHaveLength(1);

    const view = toSignerView(second);
    expect(view.name).toBe("Andi Wijaya, S.E.");
    expect(view.hasSignature).toBe(false);

    const profile = await getProfileByOrg(org.id);
    expect(profile?.defaultSignerId).toBe(second.id);

    const audit = await db.auditLog.findFirst({
      where: { action: "PROFILE_CHANGED", entityType: "signer", entityId: second.id },
    });
    expect(audit).not.toBeNull();
  });

  it("stores a signature image via the sniffed pipeline and replaces the old file", async () => {
    const withSig = await saveSigner(
      { name: "Andi Wijaya, S.E.", title: null, location: null },
      ownerCtx(),
      { signatureFile: new File([PNG], "tanda-tangan.png", { type: "image/png" }) },
    );
    expect(withSig.signatureImagePath).toMatch(
      /^uploads\/organizations\/[^/]+\/signature\/[0-9a-f-]{36}\.png$/,
    );
    const firstPath = withSig.signatureImagePath!;
    expect((await getStorageService().read(firstPath)).mimeType).toBe("image/png");

    const replaced = await saveSigner(
      { name: "Andi Wijaya, S.E.", title: null, location: null },
      ownerCtx(),
      { signatureFile: new File([PNG], "ganti.png", { type: "image/png" }) },
    );
    expect(replaced.signatureImagePath).not.toBe(firstPath);
    // Previous file cleaned up.
    await expectAppFailure(getStorageService().read(firstPath), "NOT_FOUND");

    // Cleanup so no orphan bytes stay behind.
    await getStorageService().delete(replaced.signatureImagePath!);
    await db.signer.updateMany({
      where: { organizationId: org.id },
      data: { signatureImagePath: null },
    });
  });
});

describe("logo upload lifecycle", () => {
  it("stores a random filename, ignoring a hostile client name (../../etc/passwd)", async () => {
    const profile = await getProfileByOrg(org.id);
    const hostile = new File([PNG], "../../etc/passwd", { type: "image/png" });
    const updated = await replaceLogo(profile!.id, hostile, ownerCtx());

    expect(updated.logoPath).toMatch(
      /^uploads\/organizations\/[^/]+\/logo\/[0-9a-f-]{36}\.png$/,
    );
    expect(updated.logoPath).not.toContain("..");
    expect(updated.logoPath).not.toContain("passwd");

    const content = await getStorageService().read(updated.logoPath!);
    expect(content.mimeType).toBe("image/png");

    const audit = await db.auditLog.findFirst({
      where: { action: "PROFILE_CHANGED", entityId: profile!.id },
    });
    expect(audit).not.toBeNull();
    const auditEntries = await db.auditLog.findMany({
      where: { action: "PROFILE_CHANGED", entityId: profile!.id },
    });
    expect(
      auditEntries.some((row) => JSON.stringify(row.metadata ?? {}).includes(updated.logoPath!)),
    ).toBe(true);
  });

  it("replaces the previous logo and deletes the old file", async () => {
    const profile = await getProfileByOrg(org.id);
    const firstPath = profile!.logoPath!;
    const second = await replaceLogo(
      profile!.id,
      new File([PNG], "logo-baru.png", { type: "image/png" }),
      ownerCtx(),
    );
    expect(second.logoPath).not.toBe(firstPath);
    await expectAppFailure(getStorageService().read(firstPath), "NOT_FOUND");
  });

  it("rejects files over 2 MB with a clear Indonesian message", async () => {
    const profile = await getProfileByOrg(org.id);
    const oversize = new File(
      [new Uint8Array(2 * 1024 * 1024 + 1)],
      "besar.png",
      { type: "image/png" },
    );
    const failure = await expectAppFailure(
      replaceLogo(profile!.id, oversize, ownerCtx()),
      "VALIDATION_ERROR",
    );
    expect(failure.message).toMatch(/melebihi batas 2 MB/);
  });

  it("rejects a fake MIME: PDF bytes named .png are decided by content", async () => {
    const profile = await getProfileByOrg(org.id);
    const fake = new File(
      [new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n")],
      "palsu.png",
      { type: "image/png" },
    );
    const failure = await expectAppFailure(
      replaceLogo(profile!.id, fake, ownerCtx()),
      "VALIDATION_ERROR",
    );
    expect(failure.message).toMatch(/terdeteksi sebagai PDF/);
    expect(failure.message).toContain("PNG");
  });

  it("removes the logo, its file, and audits logo_removed", async () => {
    const profile = await getProfileByOrg(org.id);
    const path = profile!.logoPath!;
    const cleared = await removeLogo(profile!.id, ownerCtx());
    expect(cleared.logoPath).toBeNull();
    await expectAppFailure(getStorageService().read(path), "NOT_FOUND");

    const auditEntries = await db.auditLog.findMany({
      where: { action: "PROFILE_CHANGED", entityId: profile!.id },
    });
    expect(
      auditEntries.some((row) =>
        JSON.stringify(row.metadata ?? {}).includes('"logo_removed"'),
      ),
    ).toBe(true);
  });
});

describe("onboarding state machine (resume + complete)", () => {
  it("resumes from the furthest step and never rewinds", async () => {
    const user = await createUser({ username: "ob.resume", onboardingComplete: false });
    expect(await getOnboardingState(user.id)).toEqual({ complete: false, step: 1 });

    await advanceOnboardingStep(user.id, 5);
    expect((await getOnboardingState(user.id)).step).toBe(5);

    // Navigating Back in the wizard does not move the server resume point.
    await advanceOnboardingStep(user.id, 3);
    expect((await getOnboardingState(user.id)).step).toBe(5);

    await advanceOnboardingStep(user.id, 99);
    expect((await getOnboardingState(user.id)).step).toBe(ONBOARDING_TOTAL_STEPS);

    expect(clampStep(0)).toBe(1);
    expect(clampStep(4.7)).toBe(4);
    expect(clampStep(Number.NaN)).toBe(1);
  });

  it("flips complete on finish and no-ops later advances", async () => {
    const user = await createUser({ username: "ob.finish", onboardingComplete: false });
    await advanceOnboardingStep(user.id, 7);
    expect((await getOnboardingState(user.id)).step).toBe(7);

    const done = await completeOnboarding(user.id);
    expect(done).toEqual({ complete: true, step: ONBOARDING_TOTAL_STEPS });

    const row = await db.user.findUnique({
      where: { id: user.id },
      select: { onboardingComplete: true, onboardingStep: true },
    });
    expect(row?.onboardingComplete).toBe(true);

    const after = await advanceOnboardingStep(user.id, 3);
    expect(after).toEqual({ complete: true, step: ONBOARDING_TOTAL_STEPS });
    expect((await getOnboardingState(user.id)).complete).toBe(true);
  });
});
