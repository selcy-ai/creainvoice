"use client";

// src/components/layout/command-palette.tsx
// Command search (feature 08): Cmd+K / Ctrl+K opens a palette that (1)
// navigates to any route the session may actually see (permission-aware —
// same visibility flags as the sidebar) and (2) searches invoices by number /
// customer through the server (searchInvoicesAction → query-service, org
// scoped and capped — the client never queries the database itself).
// Navigation goes through guardedPush so the invoice editor's dirty guard
// still asks before an unsaved draft is left behind.

import * as React from "react";
import { ReceiptTextIcon, SearchIcon } from "lucide-react";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { buttonVariants } from "@/components/ui/button";
import { useNavigationBlocker } from "@/components/layout/navigation-blocker";
import {
  NAV_GROUPS,
  visibleLinks,
  type NavVisibility,
} from "@/components/layout/nav-config";
import { INVOICE_STATUS_LABELS } from "@/components/invoice/invoice-status-badge";
import { searchInvoicesAction } from "@/modules/invoices/actions";
import type { InvoiceQuickMatch } from "@/modules/invoices/query-service";

export interface CommandPaletteProps {
  navVisibility: NavVisibility;
}

/** Debounce before hitting the server (a keystroke is not a query). */
const SEARCH_DEBOUNCE_MS = 250;

export function CommandPalette({ navVisibility }: CommandPaletteProps) {
  const { guardedPush } = useNavigationBlocker();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [matches, setMatches] = React.useState<InvoiceQuickMatch[]>([]);
  const [searching, setSearching] = React.useState(false);

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((current) => !current);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Debounced server lookup. All synchronous state moves (clearing the query,
  // marking the request in flight) happen in the input's change handler — the
  // effect only schedules the fetch and applies the resolved result.
  React.useEffect(() => {
    const q = query.trim();
    if (q.length === 0) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      searchInvoicesAction({ q })
        .then((result) => {
          if (cancelled) return;
          setMatches(result.ok ? result.data : []);
          setSearching(false);
        })
        .catch(() => {
          if (cancelled) return;
          setMatches([]);
          setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  function handleQueryChange(value: string) {
    setQuery(value);
    if (value.trim().length === 0) {
      setMatches([]);
      setSearching(false);
      return;
    }
    setSearching(true);
  }

  const routes = React.useMemo(
    () =>
      NAV_GROUPS.flatMap((group) =>
        visibleLinks(group.links, navVisibility),
      ),
    [navVisibility],
  );

  function go(href: string) {
    setOpen(false);
    setQuery("");
    setMatches([]);
    setSearching(false);
    guardedPush(href);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Cari (Cmd+K)"
        className={`${buttonVariants({ variant: "outline", size: "sm" })} hidden w-56 justify-between text-muted-foreground md:flex`}
      >
        <span className="flex items-center gap-2">
          <SearchIcon aria-hidden="true" />
          Cari...
        </span>
        <kbd className="pointer-events-none rounded border border-border bg-muted px-1.5 font-mono text-[10px]">
          ⌘K
        </kbd>
      </button>

      <CommandDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setQuery("");
            setMatches([]);
            setSearching(false);
          }
        }}
        title="Cari menu dan invoice"
        description="Navigasi cepat dan pencarian invoice berdasarkan nomor atau customer."
      >
        {/* CommandDialog only provides the dialog shell — the cmdk context
            (Command) has to wrap the input/list, or CommandInput throws. */}
        <Command>
          <CommandInput
            placeholder="Ketik menu, nomor invoice, atau customer..."
            value={query}
            onValueChange={handleQueryChange}
          />
          <CommandList>
            <CommandEmpty>
              {searching
                ? "Mencari invoice..."
                : query.trim().length > 0
                  ? "Tidak ada invoice yang cocok."
                  : "Ketik untuk mencari."}
            </CommandEmpty>

            {routes.length > 0 ? (
              <CommandGroup heading="Menu">
                {routes.map((route) => {
                  const Icon = route.icon;
                  return (
                    <CommandItem
                      key={route.href}
                      value={`menu ${route.label}`}
                      onSelect={() => go(route.href)}
                    >
                      <Icon aria-hidden="true" />
                      {route.label}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ) : null}

            {matches.length > 0 ? (
              <CommandGroup heading="Invoice">
                {matches.map((invoice) => (
                  <CommandItem
                    key={invoice.id}
                    value={`invoice ${invoice.label} ${invoice.customerName}`}
                    onSelect={() => go(`/invoices/${invoice.id}`)}
                  >
                    <ReceiptTextIcon aria-hidden="true" />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-mono text-sm">{invoice.label}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {invoice.customerName} ·{" "}
                        {INVOICE_STATUS_LABELS[invoice.displayStatus]}
                      </span>
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
}
