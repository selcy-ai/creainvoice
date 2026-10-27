// src/components/invoice/print-render.ts
// Server-only (imported EXCLUSIVELY by the print route): turns the shared
// InvoiceRenderer into a standalone HTML document with no app chrome — the
// exact page pdf-service loads into Chromium (feature 06: preview browser ==
// PDF; the only difference is the medium).
//
// Styling comes from the app's own compiled CSS (globals.css tokens + Tailwind
// utilities + next/font @font-face), inlined at request time so fonts,
// `.invoice-preview` light tokens and every utility class resolve identically
// in headless Chromium. Production ships it in `.next/static/css`; `next dev`
// has no build output, so dev falls back to the stylesheet links of a public
// page of the running app. A Playwright footer (page number + reference line)
// is added by pdf-service via displayHeaderFooter — it cannot inherit page CSS,
// hence its own inline template there.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { InvoiceRenderer } from "@/components/invoice/InvoiceRenderer";
import type { InvoiceRendererData } from "@/components/invoice/renderer-data";
import { env } from "@/server/env";
import { logger } from "@/server/logger";
import { getStorageService } from "@/modules/storage";

/** 1×1 transparent GIF — stands in for an unreadable image so the layout
 *  keeps its box without firing a network request from headless Chromium. */
const BLANK_PIXEL =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

// Turbopack bans STATIC `react-dom/server` imports inside the React Server
// Components layer (every App Router module, route handlers included) — but a
// route handler returning a text/html Response legitimately needs
// renderToStaticMarkup to turn the shared InvoiceRenderer into a string.
// The specifier is therefore resolved at RUNTIME by plain Node, where
// react-dom/server is exactly the right tool. Kept lazy so module load never
// touches it.
const REACT_DOM_SERVER = "react-dom/server";
let serverModule: typeof import("react-dom/server") | null = null;

async function markupRenderer(): Promise<typeof import("react-dom/server")> {
  if (!serverModule) {
    serverModule = (await import(REACT_DOM_SERVER)) as typeof import("react-dom/server");
  }
  return serverModule;
}

/**
 * Print rules (code-standards "Print CSS"): A4 portrait with safe margins,
 * repeated table header on new pages, rows never split, summary/signature
 * blocks kept together, exact background colors (the Corporate Blue accent
 * and the badge must print as solid color, not white).
 */
export const PRINT_CSS = `
@page { size: A4; margin: 14mm 10mm 18mm 10mm; }
html, body { margin: 0; padding: 0; background: #fff; }
body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.invoice-preview { width: 100% !important; max-width: none !important; box-shadow: none !important; border-radius: 0 !important; }
thead { display: table-header-group; }
tfoot { display: table-footer-group; }
tr, img, .avoid-break { break-inside: avoid; page-break-inside: avoid; }
p, li { orphans: 3; widows: 3; }
`.trim();

/** Production: inline the built CSS. Cached — build output never changes.
 *  Next 16 (Turbopack) emits stylesheets under `.next/static/chunks/`, older
 *  builds under `.next/static/css/` — collect *.css recursively either way. */
let builtCssCache: string | null = null;
let builtCssAttempted = false;

async function builtCss(): Promise<string | null> {
  if (builtCssAttempted) return builtCssCache;
  builtCssAttempted = true;
  try {
    const staticDir = path.join(process.cwd(), ".next", "static");
    const files = (await readdir(staticDir, { recursive: true, encoding: "utf8" })).filter(
      (name) => name.endsWith(".css"),
    );
    if (files.length === 0) return null;
    const chunks = await Promise.all(files.map((name) => readFile(path.join(staticDir, name), "utf8")));
    builtCssCache = chunks.join("\n");
    return builtCssCache;
  } catch {
    // `next dev` has no .next/static — handled by the dev fallback below.
    return null;
  }
}

/** Dev fallback: read the stylesheet links off a public page of the app. */
async function devCss(): Promise<string> {
  try {
    const response = await fetch(`${env.APP_URL}/login`, { cache: "no-store" });
    if (!response.ok) return "";
    const html = await response.text();
    const hrefs = [...html.matchAll(/href="(\/_next\/static\/[^"?]+\.css[^"]*)"/g)].map(
      (match) => match[1],
    );
    const unique = [...new Set(hrefs)];
    const chunks = await Promise.all(
      unique.map(async (href) => {
        const css = await fetch(new URL(href, env.APP_URL), { cache: "no-store" });
        return css.ok ? css.text() : "";
      }),
    );
    return chunks.join("\n");
  } catch (error) {
    logger.warn(
      { module: "print", err: error instanceof Error ? error.message : String(error) },
      "gagal memuat stylesheet untuk print route",
    );
    return "";
  }
}

async function appCss(): Promise<string> {
  const built = await builtCss();
  if (built) return built;
  return devCss();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const STORAGE_SRC_RE = /src="(\/api\/storage\/[^"]+)"/g;

/**
 * Logo + tanda tangan are served by an AUTH-GATED route (session cookie) —
 * pdf-service's browser has no session, so the printed document embeds them
 * as data URIs instead of URLs. Missing files degrade to a blank pixel (same
 * box, no request). Also guarantees "logo compact" renders offline-stable.
 */
async function inlineStorageImages(html: string): Promise<string> {
  const sources = [...html.matchAll(STORAGE_SRC_RE)].map((match) => match[1]);
  const replacements = new Map<string, string>();
  await Promise.all(
    sources.map(async (source) => {
      const storagePath = source.replace(/^\/api\/storage\//, "");
      try {
        const { data, mimeType } = await getStorageService().read(storagePath);
        replacements.set(
          source,
          `data:${mimeType};base64,${data.toString("base64")}`,
        );
      } catch {
        replacements.set(source, BLANK_PIXEL);
      }
    }),
  );
  return html.replace(STORAGE_SRC_RE, (match) => {
    const replacement = replacements.get(match.slice(5, -1));
    return replacement ? `src="${replacement}"` : match;
  });
}

/**
 * Full standalone document for the print route. `renderToStaticMarkup` (not
 * Next's RSC pipeline) because the route must return a plain HTML string and
 * InvoiceRenderer is a pure presentational component.
 *
 * `baseUrl` is the ORIGIN THE PARENT REQUEST CAME FROM (inside Docker:
 * http://app:3000) — it becomes `<base href>` so font files referenced by the
 * inlined CSS as `/_next/static/media/...` resolve for headless Chromium
 * without any cookie.
 */
export async function renderPrintHtml(data: InvoiceRendererData, baseUrl: string): Promise<string> {
  const title = data.number ?? data.numberPreview ?? "Invoice";
  const author = data.issuer.legalName || data.issuer.name || "creainvoice";
  const { renderToStaticMarkup } = await markupRenderer();
  const markup = await inlineStorageImages(renderToStaticMarkup(<InvoiceRenderer data={data} />));
  // Never let a stray "</style>" inside a stylesheet or content string end
  // the block early (defense in depth for inlined CSS).
  const css = (await appCss()).replace(/<\/style/gi, "<\\/style");

  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8" />
<base href="${escapeHtml(baseUrl)}/" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<meta name="author" content="${escapeHtml(author)}" />
<title>${escapeHtml(title)}</title>
<style>
${css}
</style>
<style>
${PRINT_CSS}
</style>
</head>
<body>
${markup}
</body>
</html>`;
}
