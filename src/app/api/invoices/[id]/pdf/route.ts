// src/app/api/invoices/[id]/pdf/route.ts
// Secure PDF download (feature 06 spec):
//   • session required (401 without),
//   • active org scope re-validated from the membership (no scope → 404,
//     same answer as "not yours" so existence never leaks),
//   • `invoice.download` permission decided centrally in modules/permissions
//     (STAFF+ and VIEWER all hold it today — matrix lives in ONE place),
//   • the file must exist (404 otherwise — an honest "not ready" beats a
//     stub response),
//   • Content-Disposition: attachment with the safe filename from the
//     invoice number, plus audit PDF_DOWNLOADED (written in the service).

import { withErrorHandler } from "@/lib/api-response";
import { downloadOfficialPdf } from "@/modules/pdf/service";
import { resolveWorkspaceScope } from "@/modules/workspace/service";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;

  const session = await getSession();
  if (!session?.userId) {
    return Response.json(
      { ok: false, error: { code: "UNAUTHORIZED", message: "Sesi Anda sudah berakhir. Silakan masuk kembali." } },
      { status: 401 },
    );
  }

  const scope = await resolveWorkspaceScope(session);
  if (!scope) {
    // Authenticated but no active membership: same shape as an id that is
    // not ours — never confirm the resource exists.
    return Response.json(
      { ok: false, error: { code: "NOT_FOUND", message: "Invoice tidak ditemukan." } },
      { status: 404 },
    );
  }

  // AppError NOT_FOUND (foreign id / PDF not ready) and FORBIDDEN (missing
  // permission) are mapped by the shared handler — IDOR answers 404.
  const download = await downloadOfficialPdf(id, { scope, request });
  return new Response(new Uint8Array(download.bytes), {
    headers: {
      "content-type": "application/pdf",
      "content-length": String(download.sizeBytes),
      // ASCII-safe name (safePdfFilename output): a plain filename=
      // parameter is exactly what the acceptance criteria asks for.
      "content-disposition": `attachment; filename="${download.filename}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
});
