// src/lib/auth.ts — self-hosted better-auth (Change 14).
//
// The single place the app reads a session. better-auth owns identity:
// sign-in / sign-up / sign-out run on the catch-all route handler
// (src/app/api/auth/[...all]/route.ts → POST /api/auth/sign-in/email etc.)
// and persist `user` + `session` + `account` rows in THIS database through
// the Drizzle adapter — no third-party service, no webhook to mirror.
//
// This file replaces src/lib/clerk.ts. The exported AuthSession shape is
// deliberately identical to the Clerk one ({ userId, orgId, isAuthenticated,
// user }) so the 34 consumers (modules/*/actions.ts, app/(dashboard)/*,
// workspace/service.ts) keep compiling unchanged — the contract Change 14
// promised not to break. `orgId` now comes from the session row's
// activeOrganizationId (written after an ACTIVE membership is verified)
// instead of a Clerk session claim.
//
// Organization rows are created locally (modules/onboarding/actions.ts step 1
// INSERTs into organizations + memberships); there is nothing to mirror.

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import argon2 from "argon2";
import { randomBytes, scryptSync, timingSafeEqual as cryptoTimingSafeEqual } from "node:crypto";
import { db } from "@/server/db";
import { accounts, memberships, organizations, sessions, users, verifications } from "@/db/schema";
import { createId } from "@/db/id";
import { env } from "@/server/env";
import { AppError } from "@/lib/errors";
import { logAudit } from "@/modules/audit/service";
import { and, asc, eq } from "drizzle-orm";
import { headers } from "next/headers";

// ─── Password hashing (argon2, builder's choice per Change 14) ────────────

/**
 * Password hashing. Change 14's spec offers bcrypt/argon2 at the builder's
 * choice (argon2 recommended). better-auth's default is its own scrypt
 * format; we use argon2 instead — the hashes are tagged with the argon2
 * encoded-format prefix ("$argon2id$…"), which verifyPassword detects so a
 * legacy scrypt row ("<saltHex>:<keyHex>") still verifies through the
 * fallback. Both paths are constant-time on compare and covered by
 * tests/integration/auth.test.ts.
 */
let argon2Available = false;
try {
  void argon2.hash("probe").then(() => {
    argon2Available = true;
  });
} catch {
  argon2Available = false;
}

/** Node scrypt parameters better-auth's default hasher uses. */
const SCRYPT_KEYLEN = 64;
const SCRYPT_PARAMS = { N: 16384, r: 16, p: 1 } as const;
// Node's default 32MB scrypt budget is too small for N=16384 × r=16 — the
// same limit @better-auth/utils raises (128 × N × r × 2).
const SCRYPT_MAXMEM = 128 * SCRYPT_PARAMS.N * SCRYPT_PARAMS.r * 2;

interface ScryptRecord {
  salt: Buffer;
  hash: Buffer;
}

function scryptHash(password: string): ScryptRecord {
  const salt = randomBytes(16);
  return {
    salt,
    hash: scryptSync(password.normalize("NFKC"), salt, SCRYPT_KEYLEN, {
      ...SCRYPT_PARAMS,
      maxmem: SCRYPT_MAXMEM,
    }),
  };
}

/** better-auth's default format: `<saltHex>:<keyHex>` — the legacy fallback. */
function scryptVerify(password: string, stored: string): boolean {
  const parts = stored.split(":");
  if (parts.length !== 2) return false;
  const salt = parts[0] ?? "";
  const expected = parts[1] ?? "";
  if (!salt || !expected) return false;
  try {
    const derived = scryptSync(password.normalize("NFKC"), Buffer.from(salt, "hex"), SCRYPT_KEYLEN, {
      ...SCRYPT_PARAMS,
      maxmem: SCRYPT_MAXMEM,
    });
    return timingSafeEqual(derived, Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

/** Constant-time comparison for equal-length buffers. */
function timingSafeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return cryptoTimingSafeEqual(a, b);
}

async function hashPassword(password: string): Promise<string> {
  // Same guard as verifyPassword: the module-scope argon2 probe is
  // fire-and-forget, so the first hash after a cold start must re-probe
  // rather than silently fall through to the scrypt fallback.
  await ensureHasherReady();
  if (argon2Available) {
    try {
      return await argon2.hash(password);
    } catch {
      // fall through to scrypt
    }
  }
  const record = scryptHash(password);
  return `${record.salt.toString("hex")}:${record.hash.toString("hex")}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  await ensureHasherReady();
  // Tagged argon2 encoded hash ("$argon2id$…") → argon2; otherwise the
  // better-auth scrypt format ("saltHex:keyHex").
  if (stored.startsWith("$argon2")) {
    if (!argon2Available) return false;
    try {
      return await argon2.verify(stored, password);
    } catch {
      return false;
    }
  }
  return scryptVerify(password, stored);
}

/**
 * Probes argon2 synchronously the first time a hash is needed — the probe in
 * module scope is async and may not have settled yet.
 */
async function ensureHasherReady(): Promise<void> {
  if (argon2Available) return;
  try {
    await argon2.hash("probe");
    argon2Available = true;
  } catch {
    argon2Available = false;
  }
}

// ─── Trusted origins ──────────────────────────────────────────────────────

/**
 * BETTER_AUTH_TRUSTED_ORIGINS is a comma-separated list (spec: identical
 * pattern to invoice-me — LAN hosts like http://192.168.1.100:3000 must be
 * trusted so login from a phone on the LAN is not rejected as a bad origin).
 * baseURL is always trusted implicitly by better-auth.
 */
function trustedOriginsList(): string[] {
  const raw = env.BETTER_AUTH_TRUSTED_ORIGINS;
  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

// ─── The better-auth instance ─────────────────────────────────────────────

/**
 * Field mapping: the database shipped by Change 6 uses our own column names
 * (`image_url`, `onboarding_*`, snake_case timestamps). These tell better-auth
 * where its core fields live so not a single table is renamed and existing
 * rows keep working.
 */
const userFields = {
  emailVerified: "emailVerified",
  image: "imageUrl",
  createdAt: "createdAt",
  updatedAt: "updatedAt",
} as const;

export const auth = betterAuth({
  appName: "CreaInvoice",
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: trustedOriginsList(),

  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: users,
      account: accounts,
      session: sessions,
      verification: verifications,
    },
    // The tables above are singular (user/session/account/verification).
    usePlural: false,
    // Column names are already snake_case in the schema; do not let the
    // adapter re-derive them.
    camelCase: false,
  }),

  emailAndPassword: {
    enabled: true,
    // Spec: public registration is ON (security-standards.md baris 7), but a
    // login requires a verified email. The app has no SMTP yet, so the
    // verification link is logged instead of sent (see emailVerification).
    requireEmailVerification: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    // Do not hand out a session before the email is verified.
    autoSignIn: false,
    // Argon2 (builder's choice, spec: "argon2 direkomendasikan") instead of
    // better-auth's default scrypt. The verify function accepts BOTH the
    // argon2 encoded format and better-auth's default "salt:key" scrypt
    // format, so rows from either path keep working.
    password: {
      hash: hashPassword,
      verify: ({ hash, password }) => verifyPassword(password, hash),
    },
  },

  emailVerification: {
    // MVP: no SMTP (project-overview: "Email notification — defer"). The
    // verification URL is logged so a dev/operator can complete the step; a
    // later feature swaps this for a real transport.
    sendVerificationEmail: async ({ user, url }) => {
      const { logger } = await import("@/server/logger");
      logger.info(
        { module: "auth", userId: user.id, verifyUrl: url },
        "email verifikasi tidak dikirim (SMTP belum dikonfigurasi) — lihat log",
      );
    },
    sendOnSignUp: true,
    sendOnSignIn: false,
    autoSignInAfterVerification: true,
  },

  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 hari (data-model.md: Session)
    updateAge: 60 * 60 * 24, // perpanjangan 1 hari
    additionalFields: {
      activeOrganizationId: {
        type: "string",
        required: false,
        // Server-side only — the client never writes the workspace scope.
        input: false,
      },
    },
  },

  user: {
    fields: userFields,
    additionalFields: {
      username: { type: "string", required: false, input: true },
      status: { type: "string", required: false, input: false },
      onboardingComplete: { type: "boolean", required: false, input: false },
      onboardingStep: { type: "number", required: false, input: false },
    },
  },

  rateLimit: {
    // security-standards: rate limit auth endpoints. better-auth's built-in
    // special rules already throttle sign-in/sign-up to 3 per 10s.
    enabled: true,
  },

  databaseHooks: {
    user: {
      create: {
        // Audit trail (feature 01 invariant, kept alive after the Clerk
        // webhook removal): every user created through the auth layer emits
        // USER_CREATED. The webhook used to do this; the emit point now lives
        // where the row is actually created.
        after: async (user) => {
          await logAudit({
            action: "USER_CREATED",
            organizationId: null,
            actorUserId: user.id,
            entityType: "user",
            entityId: user.id,
            metadata: {
              username: (user as UserExtrasHint).username ?? null,
            },
            request: null,
          }).catch((error) => {
            void import("@/server/logger").then(({ logger }) => {
              logger.warn(
                { module: "auth", err: String(error) },
                "audit USER_CREATED gagal ditulis (best-effort)",
              );
            });
          });
        },
      },
      delete: {
        after: async (user) => {
          await logAudit({
            action: "USER_DELETED",
            organizationId: null,
            actorUserId: user.id,
            entityType: "user",
            entityId: user.id,
            request: null,
          }).catch((error) => {
            void import("@/server/logger").then(({ logger }) => {
              logger.warn(
                { module: "auth", err: String(error) },
                "audit USER_DELETED gagal ditulis (best-effort)",
              );
            });
          });
        },
      },
    },
  },

  advanced: {
    useSecureCookies: env.NODE_ENV === "production",
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: "lax",
      // secure in production (HttpOnly+Secure+SameSite — security-standards)
      secure: env.NODE_ENV === "production",
    },
    database: {
      // Keep the cuid-shaped ids the rest of the schema uses.
      generateId: () => createId(),
    },
  },
});

// ─── AuthSession (contract unchanged since Change 6) ──────────────────────

/** The part of the better-auth user the app consumes. */
export interface AuthUser {
  id: string;
  email: string;
  name?: string | null;
  username?: string | null;
  imageUrl?: string | null;
  emailVerified?: boolean;
}

/**
 * Session shape this app consumes — identical to the Clerk version
 * (Change 14: the 34 consumers must not change). `user` exposes the fields
 * the dashboard layout reads (name/email).
 */
export interface AuthSession {
  userId: string | null;
  orgId: string | null;
  isAuthenticated: boolean;
  user: AuthUser | null;
}

/** Session row fields the app writes (activeOrganizationId) or reads. */
interface SessionRowHint {
  activeOrganizationId?: string | null;
}

/** Extra user fields declared as additionalFields on the auth instance. */
interface UserExtrasHint {
  username?: string | null;
  imageUrl?: string | null;
  emailVerified?: boolean;
}

/** Reads the incoming request headers (next/headers) or an empty set. */
async function readHeaders(): Promise<Headers> {
  try {
    return await headers();
  } catch {
    // Outside a request scope (tests drive resolveSession directly).
    return new Headers();
  }
}

/**
 * Current better-auth session for the request, or null when absent/expired.
 * `orgId` is resolved against the membership table — the session row stores
 * the active workspace, and every read re-validates it (fail closed).
 */
export async function getSession(): Promise<AuthSession | null> {
  return resolveSession(await readHeaders());
}

/** Same as getSession but accepts explicit headers (proxy, tests). */
export async function resolveSession(requestHeaders: Headers): Promise<AuthSession | null> {
  try {
    const session = await auth.api.getSession({ headers: requestHeaders });
    if (!session?.user) return null;

    const sessionRow = (session as { session?: SessionRowHint }).session;
    const extras = session.user as UserExtrasHint;
    const orgId = await resolveActiveOrgId(session.user.id, sessionRow ?? null);

    return {
      userId: session.user.id,
      orgId,
      isAuthenticated: true,
      user: {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name ?? null,
        username: extras.username ?? null,
        imageUrl: extras.imageUrl ?? null,
        emailVerified: extras.emailVerified ?? false,
      },
    };
  } catch {
    return null;
  }
}

/**
 * The active organization for this session: the value stored on the session
 * row when it is still an ACTIVE membership, else the first ACTIVE membership
 * (spec Change 14: "default ke membership pertama saat login"). A claim is
 * never trusted without the database check.
 */
export async function resolveActiveOrgId(
  userId: string,
  sessionRow?: SessionRowHint | null,
): Promise<string | null> {
  const rows = await db
    .select({
      organizationId: memberships.organizationId,
      status: memberships.status,
    })
    .from(memberships)
    .where(eq(memberships.userId, userId))
    .orderBy(asc(memberships.joinedAt));
  if (rows.length === 0) return null;

  const requested = sessionRow?.activeOrganizationId ?? null;
  const match = requested
    ? rows.find((row) => row.organizationId === requested && row.status === "ACTIVE")
    : undefined;
  if (match) return match.organizationId;

  const first = rows.find((row) => row.status === "ACTIVE");
  return first ? first.organizationId : null;
}

/** Throws UNAUTHORIZED when there is no valid better-auth session. */
export async function requireSession(): Promise<NonNullable<AuthSession>> {
  const session = await getSession();
  if (!session || !session.userId || !session.user) {
    throw new AppError(
      "UNAUTHORIZED",
      "Sesi Anda sudah berakhir. Silakan masuk kembali.",
    );
  }
  return session;
}

/**
 * The active organization id, or null when the user has none selected.
 * The workspace is the organization container (flat — every member is a
 * full admin, Change 6 removed role tiers).
 */
export function activeOrganizationId(session: AuthSession | null): string | null {
  return session?.orgId ?? null;
}

// ─── Workspace switching (replaces Clerk's OrganizationSwitcher) ──────────

/**
 * Stores the active organization on the session row. Refuses anything that
 * is not an ACTIVE membership of this user in an ACTIVE organization — the
 * same fail-closed rule the read path applies.
 */
export async function setActiveOrganization(
  userId: string,
  sessionToken: string,
  organizationId: string,
): Promise<void> {
  const memRows = await db
    .select({ membershipStatus: memberships.status, orgStatus: organizations.status })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .where(
      and(
        eq(memberships.userId, userId),
        eq(memberships.organizationId, organizationId),
      ),
    )
    .limit(1);
  const row = memRows[0];
  if (!row || row.membershipStatus !== "ACTIVE") {
    throw new AppError("FORBIDDEN", "Anda bukan anggota aktif organisasi ini.");
  }
  if (row.orgStatus === "SUSPENDED") {
    throw new AppError("FORBIDDEN", "Organisasi sedang ditangguhkan.");
  }

  await db
    .update(sessions)
    .set({ activeOrganizationId: organizationId, updatedAt: new Date() })
    .where(and(eq(sessions.token, sessionToken), eq(sessions.userId, userId)));
}

/**
 * The session token from the request cookie — needed by the workspace
 * switcher to write `activeOrganizationId` on the right session row.
 */
export async function getSessionToken(): Promise<string | null> {
  const h = await readHeaders();
  return tokenFromCookieHeader(h.get("cookie") ?? "");
}

/** Extracts the better-auth session token from a raw Cookie header. */
export function tokenFromCookieHeader(cookieHeader: string): string | null {
  const match = /better-auth\.session_token=([^;]+)/.exec(cookieHeader);
  if (!match) return null;
  const value = match[1];
  return value ? decodeURIComponent(value) : null;
}

// ─── Credential helpers (tests + seed) ─────────────────────────────────────

/**
 * Verifies a credential login without going through the HTTP layer — tests
 * and the seed-admin verification use this. Returns the user row or null
 * when the password is wrong, the account is not a credential account, the
 * email is not verified, or the user is suspended.
 */
export async function verifyCredentials(input: {
  email: string;
  password: string;
}): Promise<AuthUser | null> {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      username: users.username,
      imageUrl: users.imageUrl,
      emailVerified: users.emailVerified,
      status: users.status,
      password: accounts.password,
    })
    .from(accounts)
    .innerJoin(users, eq(users.id, accounts.userId))
    .where(and(eq(accounts.providerId, "credential"), eq(users.email, input.email)))
    .limit(1);
  const row = rows[0];
  if (!row || !row.password) return null;
  if (row.status !== "ACTIVE") return null;
  if (row.emailVerified !== true) return null;
  await ensureHasherReady();
  if (!(await verifyPassword(input.password, row.password))) return null;

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    username: row.username,
    imageUrl: row.imageUrl,
    emailVerified: row.emailVerified,
  };
}

/**
 * Hashes a password the same way sign-up does — used by the seed script and
 * the admin CLI path to create a login without the HTTP layer.
 */
export async function hashUserPassword(password: string): Promise<string> {
  await ensureHasherReady();
  return hashPassword(password);
}

/** Verifies a password against a stored hash (argon2 or the scrypt fallback). */
export async function verifyUserPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  await ensureHasherReady();
  return verifyPassword(password, stored);
}
