"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { MenuIcon } from "lucide-react";
import { UserButton } from "@clerk/nextjs";
import { CommandPalette } from "@/components/layout/command-palette";
import {
  NAV_GROUPS,
  visibleLinks,
  type NavVisibility,
} from "@/components/layout/nav-config";
import { GuardedLink, NavigationBlockerProvider } from "@/components/layout/navigation-blocker";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { WorkspaceSwitcher } from "@/components/layout/workspace-switcher";
import { toast } from "@/components/ui/toast";
import { buttonVariants } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "cn";

export interface ShellUser {
  name: string | null;
  email: string | null;
}

const SEGMENT_LABELS: Record<string, string> = {
  dashboard: "Dashboard",
  invoices: "Invoice",
  profiles: "Profil Invoice",
  onboarding: "Onboarding",
  "bank-accounts": "Rekening Bank",
  signers: "Penanda Tangan",
  "pdf-jobs": "Job PDF",
  payments: "Pembayaran",
  customers: "Customer",
  projects: "Project / PO",
};

function breadcrumbLabel(segment: string): string {
  if (segment.length > 20) return "Detail"; // route ids ([id]) — not displayable
  return SEGMENT_LABELS[segment] ?? segment.charAt(0).toUpperCase() + segment.slice(1);
}

function NavList({
  visibility,
  onNavigate,
}: {
  visibility: NavVisibility;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-6 px-3 py-4">
      {NAV_GROUPS.map((group) => (
        <div key={group.title} className="flex flex-col gap-1">
          <p className="px-3 pb-1.5 text-xs font-medium tracking-widest text-muted-foreground uppercase">
            {group.title}
          </p>
          {visibleLinks(group.links, visibility).map((link) => {
            const active =
              pathname === link.href || pathname.startsWith(`${link.href}/`);
            const Icon = link.icon;
            return (
              <GuardedLink
                key={link.href}
                href={link.href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={cn(
                  buttonVariants({ variant: active ? "secondary" : "ghost", size: "sm" }),
                  "w-full justify-start gap-2 font-normal",
                  "hover:bg-sidebar-accent hover:text-foreground",
                  active && "bg-sidebar-accent font-medium text-foreground",
                )}
              >
                <Icon
                  aria-hidden="true"
                  className={cn(
                    "size-3.5",
                    active
                      ? "text-primary"
                      : "text-muted-foreground group-hover/button:text-foreground",
                  )}
                />
                {link.label}
              </GuardedLink>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

function Breadcrumb() {
  const pathname = usePathname();
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  return (
    <nav aria-label="Breadcrumb" className="hidden items-center gap-1 text-sm md:flex">
      {segments.map((segment, index) => {
        const isLast = index === segments.length - 1;
        return (
          <React.Fragment key={`${segment}-${index}`}>
            {index > 0 ? (
              <span className="text-muted-foreground" aria-hidden="true">
                /
              </span>
            ) : null}
            <span className={isLast ? "font-medium text-foreground" : "text-muted-foreground"}>
              {breadcrumbLabel(segment)}
            </span>
          </React.Fragment>
        );
      })}
    </nav>
  );
}

export function AppShell({
  user,
  memberships: _memberships,
  activeOrganizationId: _activeOrganizationId,
  navVisibility,
  children,
}: {
  user: ShellUser;
  /** Change 6: workspace switching is Clerk's <OrganizationSwitcher />; the
   *  membership list is no longer rendered by this shell. Kept in the props
   *  so the dashboard layout stays readable — intentionally unused. */
  memberships?: unknown[];
  activeOrganizationId?: string | null;
  /** Permission flags for the gated sidebar entries (resolved server-side). */
  navVisibility?: NavVisibility;
  children: React.ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const pathname = usePathname();
  const brandHref = "/dashboard";
  const isInvoiceEditor =
    pathname === "/invoices/new" || /^\/invoices\/[^/]+\/edit$/.test(pathname);

  // Flat workspace (Change 6): every member is a full admin, so the whole
  // nav is visible whenever there is a workspace.
  const visibility: NavVisibility = navVisibility ?? {
    payments: true,
    customers: true,
    projects: true,
    bankAccounts: true,
    signers: true,
  };

  // Frame 06/07: a fixed bottom tab bar on mobile with the three primary
  // destinations. Hidden on the invoice editor (its own tabs own the screen).
  const visiblePrimaryLinks = NAV_GROUPS.flatMap((group) =>
    visibleLinks(group.links, visibility),
  );
  const primaryTabs = ["dashboard", "invoices", "payments", "customers"]
    .map((segment) =>
      visiblePrimaryLinks.find((link) => link.href === `/${segment}`),
    )
    .filter((link): link is NonNullable<typeof link> => Boolean(link));

  return (
    <NavigationBlockerProvider>
      <div className="flex min-h-screen bg-background">
        <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar lg:flex">
          <div className="flex h-14 items-center border-b border-border px-4">
            <Link href={brandHref} className="text-base font-semibold tracking-tight">
              CreaInvoice
            </Link>
          </div>
          <div className="flex flex-1 flex-col overflow-y-auto py-3">
            <NavList visibility={visibility} />
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-background/90 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/75 lg:px-6">
            <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
              <SheetTrigger
                aria-label="Buka menu navigasi"
                className={buttonVariants({ variant: "ghost", size: "icon" })}
              >
                <MenuIcon aria-hidden="true" />
              </SheetTrigger>
              <SheetContent side="left" className="w-64 p-0">
                <SheetHeader className="border-b border-border">
                  <SheetTitle>CreaInvoice</SheetTitle>
                </SheetHeader>
                <NavList visibility={visibility} onNavigate={() => setMobileOpen(false)} />
              </SheetContent>
            </Sheet>

            <Breadcrumb />

            <div className="ml-auto flex items-center gap-2">
              <CommandPalette navVisibility={visibility} />
              <WorkspaceSwitcher />
              <ThemeToggle />
              <UserButton
                appearance={{
                  elements: {
                    rootBox: "flex",
                    avatarBox: "size-8 rounded-lg",
                  },
                }}
              />
            </div>
          </header>

          <main
            className={cn(
              "mx-auto w-full flex-1 px-4 pb-24 pt-6 sm:pt-8 lg:px-8 lg:py-8",
              // The split-screen invoice editor owns the widest canvas (form +
              // sticky A4 preview); every other page keeps the reading width.
              isInvoiceEditor ? "max-w-[1680px]" : "max-w-6xl",
            )}
          >
            {children}
          </main>
        </div>

        {/* Frame 06/07: fixed bottom tab bar, lg:hidden (sidebar owns ≥lg). */}
        {primaryTabs.length > 0 && !isInvoiceEditor ? (
          <nav
            aria-label="Navigasi utama"
            className="fixed inset-x-0 bottom-0 z-40 flex h-14 items-stretch border-t border-border bg-card lg:hidden"
            data-testid="mobile-tab-bar"
          >
            {primaryTabs.map((link) => {
              const active =
                pathname === link.href || pathname.startsWith(`${link.href}/`);
              const Icon = link.icon;
              const label = link.label === "Dashboard" ? "Beranda" : link.label;
              return (
                <GuardedLink
                  key={link.href}
                  href={link.href}
                  aria-current={active ? "page" : undefined}
                  className="flex flex-1 flex-col items-center justify-center gap-0.5 text-[10px] font-semibold"
                >
                  <Icon
                    aria-hidden="true"
                    className={cn("size-4", active ? "text-primary" : "text-muted-foreground")}
                  />
                  <span className={active ? "text-primary" : "text-muted-foreground"}>{label}</span>
                </GuardedLink>
              );
            })}
          </nav>
        ) : null}
      </div>
    </NavigationBlockerProvider>
  );
}

// `toast` is re-exported so callers that previously imported the shell for the
// toast helper keep compiling during the Change 6 migration.
export { toast };
