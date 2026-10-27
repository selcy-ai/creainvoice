// src/app/api/clerk/webhook/route.ts — Clerk → database sync (Change 6).
//
// Clerk owns auth (sessions, credentials, organizations, invitations). This
// route mirrors the rows this app actually needs into its own database:
//
//   user.created / user.updated  → upsert local `user` row
//   user.deleted                 → delete the local user row
//   organization.created / .updated → upsert local `organization` row
//   organization.deleted         → delete the local organization row
//   organizationMembership.created / .updated / .deleted
//                                → upsert / delete the local `membership` row
//
// The request MUST be verified with verifyWebhook() (Svix signature) — an
// unverified payload is rejected with 400 and never touches the database.
// This route is public by definition (Clerk's servers have no session); the
// proxy matcher excludes /api, and the signing secret does the gatekeeping.

import { verifyWebhook } from "@clerk/nextjs/webhooks";
import { db } from "@/server/db";
import { logger } from "@/server/logger";
import { memberships, organizations, users } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { logAudit } from "@/modules/audit/service";
import { NextRequest, NextResponse } from "next/server";

/**
 * The user-scope audit trail (Change 6): Clerk owns credentials and sessions,
 * so login/logout/password events are Clerk's — but organization-scope events
 * still land in this app's own AuditLog so the timeline and the audit
 * guarantees keep working. Every write is best-effort (the sync itself must
 * never fail because the audit row could not be recorded).
 */
function writeAudit(input: {
  action: Parameters<typeof logAudit>[0]["action"];
  organizationId: string | null;
  actorUserId: string | null;
  entityType: string;
  entityId: string;
  metadata?: Record<string, unknown>;
}): void {
  logAudit({ ...input, request: null }).catch((error) => {
    logger.warn(
      { module: "clerk-webhook", action: input.action, err: String(error) },
      "audit webhook gagal ditulis (best-effort)",
    );
  });
}

type UserPayload = {
  id: string;
  email_addresses?: Array<{ email_address: string; verification?: { status: string } }>;
  primary_email_address_id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
  image_url?: string | null;
};

type OrganizationPayload = {
  id: string;
  name: string;
  slug: string;
  image_url?: string | null;
};

type MembershipPayload = {
  id: string;
  organization_id: string;
  public_user_data: { user_id: string };
};

function primaryEmail(payload: UserPayload): string {
  const primaryId = payload.primary_email_address_id;
  const list = payload.email_addresses ?? [];
  const match = primaryId
    ? list.find((entry) => entry.email_address && primaryId)
    : undefined;
  return (
    match?.email_address ??
    list.find((entry) => entry.verification?.status === "verified")
      ?.email_address ??
    list[0]?.email_address ??
    ""
  );
}

function displayName(payload: UserPayload): string | null {
  const joined = [payload.first_name, payload.last_name]
    .map((part) => (part ?? "").trim())
    .filter(Boolean)
    .join(" ");
  return joined || null;
}

export async function POST(request: NextRequest): Promise<Response> {
  let event;
  try {
    event = await verifyWebhook(request);
  } catch (error) {
    logger.warn(
      {
        module: "clerk-webhook",
        err: error instanceof Error ? error.message : String(error),
      },
      "webhook gagal terverifikasi — payload ditolak",
    );
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  const type = event.type;
  const data = event.data as Record<string, unknown>;

  try {
    switch (type) {
      case "user.created":
      case "user.updated": {
        const payload = data as unknown as UserPayload;
        const email = primaryEmail(payload);
        if (!payload.id || !email) {
          logger.warn(
            { module: "clerk-webhook", type, userId: payload.id },
            "user webhook tanpa email — dilewati",
          );
          break;
        }
        await db
          .insert(users)
          .values({
            id: payload.id,
            email,
            name: displayName(payload),
            username: payload.username ?? null,
            imageUrl: payload.image_url ?? null,
          })
          .onConflictDoUpdate({
            target: users.id,
            set: {
              email,
              name: displayName(payload),
              username: payload.username ?? null,
              imageUrl: payload.image_url ?? null,
              updatedAt: new Date(),
            },
          });
        logger.info(
          { module: "clerk-webhook", type, userId: payload.id },
          "user disinkronkan",
        );
        if (type === "user.created") {
          writeAudit({
            action: "USER_CREATED",
            organizationId: null,
            actorUserId: payload.id,
            entityType: "user",
            entityId: payload.id,
            metadata: { username: payload.username ?? null },
          });
        }
        break;
      }

      case "user.deleted": {
        const payload = data as unknown as { id?: string };
        if (payload.id) {
          await db.delete(users).where(eq(users.id, payload.id));
          writeAudit({
            action: "USER_DELETED",
            organizationId: null,
            actorUserId: payload.id,
            entityType: "user",
            entityId: payload.id,
          });
          logger.info(
            { module: "clerk-webhook", type, userId: payload.id },
            "user dihapus",
          );
        }
        break;
      }

      case "organization.created":
      case "organization.updated": {
        const payload = data as unknown as OrganizationPayload;
        await db
          .insert(organizations)
          .values({
            id: payload.id,
            name: payload.name,
            slug: payload.slug || payload.id,
            imageUrl: payload.image_url ?? null,
          })
          .onConflictDoUpdate({
            target: organizations.id,
            set: {
              name: payload.name,
              slug: payload.slug || payload.id,
              imageUrl: payload.image_url ?? null,
              updatedAt: new Date(),
            },
          });
          logger.info(
            { module: "clerk-webhook", type, organizationId: payload.id },
            "organization disinkronkan",
          );
          if (type === "organization.created") {
            writeAudit({
              action: "ORGANIZATION_CREATED",
              organizationId: payload.id,
              actorUserId: null,
              entityType: "organization",
              entityId: payload.id,
              metadata: { name: payload.name, slug: payload.slug || payload.id },
            });
          }
          break;
        }

      case "organization.deleted": {
        const payload = data as unknown as { id?: string };
        if (payload.id) {
          await db.delete(organizations).where(eq(organizations.id, payload.id));
          writeAudit({
            action: "ORGANIZATION_DELETED",
            organizationId: payload.id,
            actorUserId: null,
            entityType: "organization",
            entityId: payload.id,
          });
          logger.info(
            { module: "clerk-webhook", type, organizationId: payload.id },
            "organization dihapus",
          );
        }
        break;
      }

      case "organizationMembership.created":
      case "organizationMembership.updated": {
        const payload = data as unknown as MembershipPayload;
        const userId = payload.public_user_data?.user_id;
        if (!payload.id || !payload.organization_id || !userId) break;
        await db
          .insert(memberships)
          .values({
            id: payload.id,
            userId,
            organizationId: payload.organization_id,
            status: "ACTIVE",
          })
          .onConflictDoUpdate({
            target: memberships.id,
            set: { status: "ACTIVE", updatedAt: new Date() },
          });
        logger.info(
          {
            module: "clerk-webhook",
            type,
            membershipId: payload.id,
            organizationId: payload.organization_id,
            userId,
          },
          "membership disinkronkan",
        );
        writeAudit({
          action: "MEMBERSHIP_CHANGED",
          organizationId: payload.organization_id,
          actorUserId: userId,
          entityType: "membership",
          entityId: payload.id,
          metadata: { change: type === "organizationMembership.created" ? "created" : "updated" },
        });
        break;
      }

      case "organizationMembership.deleted": {
        const payload = data as unknown as { id?: string };
        if (payload.id) {
          await db.delete(memberships).where(eq(memberships.id, payload.id));
          logger.info(
            { module: "clerk-webhook", type, membershipId: payload.id },
            "membership dihapus",
          );
          writeAudit({
            action: "MEMBERSHIP_CHANGED",
            organizationId: null,
            actorUserId: null,
            entityType: "membership",
            entityId: payload.id,
            metadata: { change: "deleted" },
          });
        }
        break;
      }

      default:
        // Events we do not mirror (session.*, invitation.*, …) are still
        // acknowledged so Clerk does not retry them.
        logger.debug({ module: "clerk-webhook", type }, "event tidak ditangani");
    }
  } catch (error) {
    logger.error(
      {
        module: "clerk-webhook",
        type,
        err: error instanceof Error ? error.message : String(error),
      },
      "gagal menyinkronkan event webhook",
    );
    return NextResponse.json({ error: "Sync failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
