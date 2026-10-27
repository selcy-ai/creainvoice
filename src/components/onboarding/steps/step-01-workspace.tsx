"use client";

// src/components/onboarding/steps/step-01-workspace.tsx
// Step 1: create an organization or pick one the user is already a member of.
// Choosing writes session.activeOrganizationId server-side (membership
// re-validated there), then the wizard resumes at the furthest saved step.

import * as React from "react";
import { useActionState } from "react";
import { chooseWorkspaceAction } from "@/modules/onboarding/actions";
import type { ActionResult } from "@/lib/api-response";
import { bannerError, fieldError } from "@/components/forms/form-utils";
import { useWizard } from "@/components/onboarding/context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function Step1Workspace() {
  const { memberships, resumeStep, goTo } = useWizard();
  const canSelect = memberships.length > 0;
  const [mode, setMode] = React.useState<"select" | "create">(canSelect ? "select" : "create");
  const [organizationId, setOrganizationId] = React.useState(
    canSelect ? memberships[0].id : "",
  );

  const [state, formAction, pending] = useActionState<
    ActionResult<{ organizationId: string }> | null,
    FormData
  >(
    async (_prev, form) => {
      const result = await chooseWorkspaceAction(form);
      if (result.ok) {
        // The workspace is active now; jump to where the server resume
        // point sits (fresh users land on step 2).
        goTo(Math.max(2, resumeStep));
      }
      return result;
    },
    null,
  );

  const banner = bannerError(state);

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <input type="hidden" name="mode" value={mode} />
      {mode === "select" ? (
        <input type="hidden" name="organizationId" value={organizationId} />
      ) : null}

      <fieldset className="flex flex-col gap-3" disabled={pending}>
        <legend className="mb-2 text-sm font-medium">Mau mulai dari mana?</legend>

        {canSelect ? (
          <button
            type="button"
            onClick={() => setMode("select")}
            className={`flex flex-col gap-2 rounded-lg border p-4 text-left transition-colors ${
              mode === "select" ? "border-primary bg-primary/5" : "border-border bg-card hover:bg-muted/50"
            }`}
          >
            <span className="text-sm font-medium">Pilih organisasi yang sudah ada</span>
            <span className="flex flex-wrap gap-2">
              {memberships.map((membership) => (
                <span
                  key={membership.id}
                  className={`rounded-full border px-3 py-1 text-xs ${
                    mode === "select" && organizationId === membership.id
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background text-foreground"
                  }`}
                >
                  {membership.name}
                </span>
              ))}
            </span>
          </button>
        ) : null}

        <button
          type="button"
          onClick={() => setMode("create")}
          className={`flex flex-col gap-1 rounded-lg border p-4 text-left transition-colors ${
            mode === "create" ? "border-primary bg-primary/5" : "border-border bg-card hover:bg-muted/50"
          }`}
        >
          <span className="text-sm font-medium">Buat organisasi baru</span>
          <span className="text-xs text-muted-foreground">
            Untuk bisnis Anda sendiri — nama bisa diubah setelahnya.
          </span>
        </button>

        {mode === "select" && canSelect ? (
          <div className="flex flex-col gap-2">
            <Label>Pilih organisasi</Label>
            <div className="flex flex-col gap-2">
              {memberships.map((membership) => (
                <label
                  key={membership.id}
                  className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-sm ${
                    organizationId === membership.id
                      ? "border-primary bg-primary/5"
                      : "border-border bg-card"
                  }`}
                >
                  <input
                    type="radio"
                    name="organizationId"
                    value={membership.id}
                    checked={organizationId === membership.id}
                    onChange={() => setOrganizationId(membership.id)}
                    className="h-4 w-4 accent-primary"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{membership.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {membership.slug}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        ) : null}

        {mode === "create" ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor="org-name">Nama organisasi</Label>
            <Input
              id="org-name"
              name="name"
              placeholder="mis. CreaInvoice Studio"
              autoComplete="organization"
              disabled={pending}
              aria-invalid={Boolean(fieldError(state, "name")) || undefined}
            />
            {fieldError(state, "name") ? (
              <p className="text-sm text-destructive">{fieldError(state, "name")}</p>
            ) : null}
          </div>
        ) : null}
      </fieldset>

      {banner ? (
        <p role="alert" className="text-sm text-destructive">
          {banner}
        </p>
      ) : null}

      <Button type="submit" disabled={pending}>
        {pending ? "Menyimpan…" : "Lanjut"}
      </Button>
    </form>
  );
}
