import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { getSession } from "@/lib/auth";
import {
  getWorkspaceOverview,
  resolveWorkspaceScope,
} from "@/modules/workspace/service";
import { getOnboardingState } from "@/modules/onboarding/service";

export const metadata: Metadata = {
  title: "Dashboard — CreaInvoice",
};

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session?.userId) redirect("/login");

  // Onboarding gate (feature 02): users who never finished the 12-step
  // workspace wizard can only be on /onboarding. Defense in depth — the
  // proxy passes everything through; this layout enforces the route.
  const onboarding = await getOnboardingState(session.userId);
  if (!onboarding.complete) redirect("/onboarding");

  const overview = await getWorkspaceOverview(session);
  const scope = await resolveWorkspaceScope(session);

  return (
    <AppShell
      user={{
        name: session.user?.name ?? session.user?.username ?? null,
        email: session.user?.email ?? null,
      }}
      memberships={overview.memberships}
      activeOrganizationId={overview.activeOrganizationId}
    >
      {children}
    </AppShell>
  );
}
