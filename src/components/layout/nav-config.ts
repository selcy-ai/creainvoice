// src/components/layout/nav-config.ts
// Sidebar navigation source of truth. Every entry points at a real route —
// features that do not exist yet are deliberately absent here (no placeholder
// links, per non-negotiables). Change 6 removed the platform admin panel
// (every user is a full admin of their own workspace), so there is no
// admin-only group anymore; `requires` marks entries the shell hides when
// there is no active workspace.

import {
  CreditCardIcon,
  FileTextIcon,
  FolderKanbanIcon,
  LandmarkIcon,
  LayoutDashboardIcon,
  ReceiptTextIcon,
  SignatureIcon,
  UsersRoundIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export interface NavVisibility {
  payments: boolean;
  customers: boolean;
  projects: boolean;
  bankAccounts: boolean;
  signers: boolean;
}

export interface NavLink {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Hidden when this flag is false (no active workspace → all gated). */
  requires?: keyof NavVisibility;
}

export interface NavGroup {
  title: string;
  links: NavLink[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    title: "Ruang kerja",
    links: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboardIcon },
      { href: "/invoices", label: "Invoice", icon: ReceiptTextIcon },
      { href: "/payments", label: "Pembayaran", icon: CreditCardIcon, requires: "payments" },
      { href: "/customers", label: "Customer", icon: UsersRoundIcon, requires: "customers" },
      { href: "/projects", label: "Project / PO", icon: FolderKanbanIcon, requires: "projects" },
      { href: "/profiles", label: "Profil Invoice", icon: FileTextIcon },
      { href: "/bank-accounts", label: "Rekening Bank", icon: LandmarkIcon, requires: "bankAccounts" },
      { href: "/signers", label: "Penanda Tangan", icon: SignatureIcon, requires: "signers" },
    ],
  },
];

/** Links of a group the current session may see. */
export function visibleLinks(
  links: NavLink[],
  visibility: NavVisibility,
): NavLink[] {
  return links.filter((link) => !link.requires || visibility[link.requires]);
}
