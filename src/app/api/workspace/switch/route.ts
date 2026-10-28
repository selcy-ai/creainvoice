// src/app/api/workspace/switch/route.ts — switch the active workspace (Change 14).
//
// Replaces Clerk's OrganizationSwitcher session-claims mechanism. The active
// organization is stored on the better-auth session row; every scoped read
// re-validates the membership against the database (fail closed), so this
// endpoint only changes which workspace is *presented* — it never grants
// access to data the membership does not cover.

import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession, getSessionToken, setActiveOrganization } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { apiFailure, apiOk } from "@/lib/api-response";
import { logger } from "@/server/logger";

const bodySchema = z.object({
  organizationId: z.string().min(1, "Organisasi wajib dipilih."),
});

export async function POST(request: Request): Promise<Response> {
  try {
    const session = await getSession();
    if (!session?.userId) {
      throw new AppError("UNAUTHORIZED", "Sesi Anda sudah berakhir. Silakan masuk kembali.");
    }

    const json = (await request.json().catch(() => null)) as unknown;
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        apiFailure("VALIDATION_ERROR", "Organisasi wajib dipilih.", {
          issues: parsed.error.flatten().fieldErrors,
        }),
        { status: 400 },
      );
    }

    const token = await getSessionToken();
    if (!token) {
      throw new AppError("UNAUTHORIZED", "Sesi tidak ditemukan. Silakan masuk kembali.");
    }

    await setActiveOrganization(session.userId, token, parsed.data.organizationId);

    logger.info(
      { module: "workspace", action: "switch", userId: session.userId },
      "organisasi aktif diganti",
    );

    return NextResponse.json(apiOk({ organizationId: parsed.data.organizationId }));
  } catch (error) {
    if (error instanceof AppError) {
      return NextResponse.json(apiFailure(error.code, error.message, error.details), {
        status: error.code === "FORBIDDEN" ? 403 : 401,
      });
    }
    logger.error({ module: "workspace", err: String(error) }, "switch gagal");
    return NextResponse.json(
      apiFailure("INTERNAL_ERROR", "Terjadi kesalahan pada server. Coba lagi."),
      { status: 500 },
    );
  }
}
