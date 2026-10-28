// src/app/api/storage/[...path]/route.ts
// Serves uploaded assets (logo, signature) to authenticated members of the
// owning organization. Authorization happens BEFORE any read: the path shape
// carries the org id, membership is re-validated, StorageService re-checks
// containment (path traversal has no bypass here). GET only.

import { withErrorHandler } from "@/lib/api-response";
import { AppError } from "@/lib/errors";
import { getStorageService } from "@/modules/storage";
import { db } from "@/server/db";
import { getSession } from "@/lib/auth";
import { memberships } from "@/db/schema";
import { and, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

const PATH_SHAPE = /^uploads\/organizations\/([A-Za-z0-9_-]{1,64})\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/;

async function authorizeOrganizationPath(path: string): Promise<void> {
  const match = PATH_SHAPE.exec(path);
  if (!match || !match[1]) {
    // Same answer as unauthorized — never reveal why.
    throw new AppError("NOT_FOUND", "File tidak ditemukan.");
  }
  const session = await getSession();
  if (!session) {
    throw new AppError("UNAUTHORIZED", "Sesi Anda sudah berakhir. Silakan masuk kembali.");
  }
  const organizationId = match[1];
  const membershipRows = await db
    .select({ status: memberships.status })
    .from(memberships)
    .where(
      and(
        eq(memberships.userId, session.userId ?? ""),
        eq(memberships.organizationId, organizationId),
      ),
    )
    .limit(1);
  const membership = membershipRows[0];
  if (!membership || membership.status !== "ACTIVE") {
    throw new AppError("NOT_FOUND", "File tidak ditemukan.");
  }
}

export const GET = withErrorHandler(
  async (_request: Request, ctx: { params: Promise<{ path: string[] }> }) => {
    const { path } = await ctx.params;
    const relativePath = decodeURIComponent(path.join("/")).replace(/^\/+/, "");
    await authorizeOrganizationPath(relativePath);

    const { data, mimeType } = await getStorageService().read(relativePath);
    return new Response(new Uint8Array(data), {
      headers: {
        "content-type": mimeType,
        "content-length": String(data.length),
        // Private assets: never cache at shared layers.
        "cache-control": "private, max-age=3600",
        "x-content-type-options": "nosniff",
      },
    });
  },
);
// Non-GET methods: Next answers 405 automatically (only GET is exported).
