// src/modules/profiles/settings.ts
// InvoiceProfile.settings parsing — a PURE leaf module (no db, no server
// deps) so the CLIENT-side invoice preview (renderer-data) and every server
// view can share one definition. Keeping it out of profiles/service matters:
// the service module pulls Prisma/sharp into its graph, and renderer-data is
// reachable from 'use client' components — importing the service there puts
// node builtins into the browser bundle (Next build fails).

// Change 6: dropped Prisma (role tiers removed)

/**
 * Document-affecting profile settings (data-model: "logo size/posisi,
 * hide-zero rows"). Parsed in ONE place so the live editor preview, the draft
 * view and the print route agree:
 *   • hideZeroRows   — summary rows with a zero value are hidden. Default TRUE
 *     (the behavior every preview has shipped with); `false` opts into
 *     showing "Diskon − Rp 0"-style rows.
 *   • hideStampLabel — hides the "Slot E-Meterai" / meterai guide caption
 *     (the slot itself always stays — spec: label bisa dimatikan).
 */
export interface InvoiceProfileSettings {
  hideZeroRows: boolean;
  hideStampLabel: boolean;
}

export function parseProfileSettings(
  value: unknown,
): InvoiceProfileSettings {
  const defaults: InvoiceProfileSettings = { hideZeroRows: true, hideStampLabel: false };
  if (value === null || value === undefined) return defaults;
  if (typeof value !== "object" || Array.isArray(value)) return defaults;
  const raw = value as Record<string, unknown>;
  return {
    hideZeroRows: typeof raw.hideZeroRows === "boolean" ? raw.hideZeroRows : defaults.hideZeroRows,
    hideStampLabel:
      typeof raw.hideStampLabel === "boolean" ? raw.hideStampLabel : defaults.hideStampLabel,
  };
}
