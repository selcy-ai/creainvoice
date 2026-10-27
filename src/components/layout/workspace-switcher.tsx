"use client";

import { OrganizationSwitcher } from "@clerk/nextjs";
import { Building2Icon } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";

/**
 * Workspace switcher (Change 6): Clerk Organizations own the membership, so
 * the switcher is Clerk's <OrganizationSwitcher />. Switching happens in
 * Clerk (the session claims change) and Clerk re-renders the app below it;
 * the org scope used by the app is re-validated against the database on
 * every read (modules/workspace) — fail closed.
 *
 * multi-org per user remains possible in Clerk (spec: "Org switcher
 * di-keep").
 */
export function WorkspaceSwitcher() {
  return (
    <OrganizationSwitcher
      hidePersonal
      appearance={{
        elements: {
          rootBox: "flex",
          organizationSwitcherTrigger:
            buttonVariants({ variant: "outline", size: "sm" }) +
            " gap-2 rounded-lg",
          organizationSwitcherTriggerIcon: "text-muted-foreground",
        },
      }}
    />
  );
}

/** Keep the icon import used by the trigger styling consistent. */
export const WorkspaceIcon = Building2Icon;
