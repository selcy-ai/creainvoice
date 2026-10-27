// src/components/invoice/invoice-status-badge.tsx
// The one invoice status badge (ui-context): ALWAYS text + colour + icon —
// never colour alone. Overdue is a READ-TIME status (feature 05: the stored
// column stays ISSUED/SENT/PARTIALLY_PAID until the feature-11 sweep), so
// pass `status` = the view's displayStatus.
//
// v4 palette (frame 02-daftar-invoice): every status carries a single soft
// pill — solid tinted background + its darker text colour. The pair lives in
// the STATUS_PILL_CLASS map below; this file is THE single centralized
// status-to-colour constant the change spec names.

import type { InvoiceStatus } from "@/db/enums";
import {
  CircleCheckIcon,
  ClockIcon,
  CopyIcon,
  PencilIcon,
  SendIcon,
  StampIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { cn } from "cn";

export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  DRAFT: "Draft",
  ISSUED: "Terbit",
  SENT: "Terkirim",
  PARTIALLY_PAID: "Dibayar sebagian",
  PAID: "Lunas",
  OVERDUE: "Jatuh tempo",
  CANCELLED: "Dibatalkan",
  REVISED: "Direvisi",
};

/**
 * The v4 status pill palette, exactly as the frame names it:
 * ISSUED #EFF6FF/#1D4ED8, PAID #ECFDF5/#059669, OVERDUE #FEF2F2/#DC2626,
 * DRAFT #F1F5F9/#64748B, SENT #ECFEFF/#0E7490, PARTIALLY_PAID #FFFBEB/#B45309.
 * CANCELLED/REVISED keep the neutral slate pill. Dark mode: same structure on
 * the navy-tint surface (BR-2 — tokens stay, values adjust).
 */
export const STATUS_PILL_CLASS: Record<InvoiceStatus, string> = {
  ISSUED: "bg-[#EFF6FF] text-[#1D4ED8] dark:bg-[#1E2F4A] dark:text-[#93B4E8]",
  PAID: "bg-[#ECFDF5] text-[#059669] dark:bg-[#12332B] dark:text-[#6EE7B7]",
  OVERDUE: "bg-[#FEF2F2] text-[#DC2626] dark:bg-[#3A1D1D] dark:text-[#F87171]",
  DRAFT: "bg-[#F1F5F9] text-[#64748B] dark:bg-[#1C2836] dark:text-[#94A3B8]",
  SENT: "bg-[#ECFEFF] text-[#0E7490] dark:bg-[#123037] dark:text-[#5ED3E0]",
  PARTIALLY_PAID:
    "bg-[#FFFBEB] text-[#B45309] dark:bg-[#332914] dark:text-[#D6A24C]",
  CANCELLED: "bg-[#F1F5F9] text-[#64748B] dark:bg-[#1C2733] dark:text-[#94A3B8]",
  REVISED:
    "bg-[#F1F5F9] text-[#64748B] line-through decoration-1 dark:bg-[#1C2733] dark:text-[#94A3B8]",
};

const STATUS_ICON: Record<InvoiceStatus, typeof StampIcon> = {
  DRAFT: PencilIcon,
  ISSUED: StampIcon,
  SENT: SendIcon,
  PARTIALLY_PAID: TriangleAlertIcon,
  PAID: CircleCheckIcon,
  OVERDUE: ClockIcon,
  CANCELLED: XIcon,
  REVISED: CopyIcon,
};

/** Monochrome pill shape (h-5, text-[11px], font-semibold, rounded-full). */
export const STATUS_PILL_BASE =
  "inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-full px-2.5 text-[11px] font-semibold tracking-[0.4px] [&>svg]:size-3 [&>svg]:pointer-events-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none";

export interface InvoiceStatusBadgeProps {
  status: InvoiceStatus;
  className?: string;
}

export function InvoiceStatusBadge({ status, className }: InvoiceStatusBadgeProps) {
  const Icon = STATUS_ICON[status];
  return (
    <span
      data-status={status}
      className={cn(STATUS_PILL_BASE, STATUS_PILL_CLASS[status], className)}
    >
      <Icon data-icon="inline-start" aria-hidden="true" />
      {INVOICE_STATUS_LABELS[status]}
    </span>
  );
}
