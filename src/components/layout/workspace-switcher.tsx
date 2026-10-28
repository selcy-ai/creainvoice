"use client";

// src/components/layout/workspace-switcher.tsx — local workspace switcher (Change 14).
//
// Replaces Clerk's <OrganizationSwitcher />. The memberships are resolved
// server-side (modules/workspace getWorkspaceOverview) and passed in; the
// active organization is stored on the better-auth session row via the
// /api/workspace/switch route. The org scope the app actually uses is
// re-validated against the database on every read (modules/workspace) —
// fail closed.

import * as React from "react";
import { useRouter } from "next/navigation";
import { Building2Icon, CheckIcon, ChevronsUpDownIcon, PlusIcon } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "cn";

export interface SwitcherMembership {
  organization: {
    id: string;
    name: string;
    slug: string;
    status: "ACTIVE" | "SUSPENDED";
  };
}

/**
 * The workspace switcher. `memberships` are the user's ACTIVE memberships;
 * `activeOrganizationId` is the verified active org for this session. Both
 * come from the server component that renders the shell.
 */
export function WorkspaceSwitcher({
  memberships,
  activeOrganizationId,
}: {
  memberships: SwitcherMembership[];
  activeOrganizationId: string | null;
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState<string | null>(null);

  const active = memberships.find((m) => m.organization.id === activeOrganizationId);
  const label = active?.organization.name ?? "Pilih organisasi";

  async function switchTo(organizationId: string) {
    if (organizationId === activeOrganizationId) return;
    setPending(organizationId);
    try {
      const response = await fetch("/api/workspace/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId }),
      });
      if (response.ok) {
        router.refresh();
      }
    } finally {
      setPending(null);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          buttonVariants({ variant: "outline", size: "sm" }),
          "gap-2 rounded-lg",
        )}
        aria-label="Ganti organisasi"
      >
        <Building2Icon aria-hidden="true" className="size-3.5 text-muted-foreground" />
        <span className="max-w-[140px] truncate text-sm font-medium">{label}</span>
        <ChevronsUpDownIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuLabel>Organisasi Anda</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {memberships.length === 0 ? (
          <div className="px-3 py-2 text-sm text-muted-foreground">
            Tidak ada organisasi aktif.
          </div>
        ) : (
          memberships.map((membership) => {
            const isActive = membership.organization.id === activeOrganizationId;
            const isPending = pending === membership.organization.id;
            return (
              <DropdownMenuItem
                key={membership.organization.id}
                onClick={() => switchTo(membership.organization.id)}
                disabled={isPending || membership.organization.status === "SUSPENDED"}
                className="gap-2"
              >
                <span className="min-w-0 flex-1 truncate text-sm">
                  {membership.organization.name}
                </span>
                {membership.organization.status === "SUSPENDED" ? (
                  <span className="text-xs text-muted-foreground">Ditangguhkan</span>
                ) : isActive ? (
                  <CheckIcon aria-hidden="true" className="size-3.5 text-primary" />
                ) : null}
              </DropdownMenuItem>
            );
          })
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => router.push("/onboarding?step=1")}
          className="gap-2"
        >
          <PlusIcon aria-hidden="true" className="size-3.5" />
          <span className="text-sm">Buat organisasi baru</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Keep the icon import used by the trigger styling consistent. */
export const WorkspaceIcon = Building2Icon;
