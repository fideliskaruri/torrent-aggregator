"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Rows3, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { useUiPreferences } from "@/components/providers/ui-preferences";
import {
  DESKTOP_NAV,
  HEADER_SEARCH_HREF,
  activeNavLabel,
  desktopNavRow,
  navActive,
  navActiveHref,
} from "@/lib/navigation";


export function Header() {
  const pathname = usePathname();
  const { density, setDensity } = useUiPreferences();
  const pageTitle = activeNavLabel(pathname);
  const activeDesktopHref = navActiveHref(DESKTOP_NAV, pathname);
  const { items: navRow, dividerIndex } = desktopNavRow();
  const searchActive = navActive(pathname, HEADER_SEARCH_HREF);

  return (
    <header className="app-header" data-app-header>
      <div className="container-app flex h-14 items-center gap-3 sm:gap-4">
        <Link href="/" className="flex items-center gap-2 shrink-0 min-w-0">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--accent)] text-[var(--primary-foreground)]">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M12 3v10m0 0l4-4m-4 4L8 9M5 17h14"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span className="text-sm font-semibold tracking-tight text-[var(--text)] truncate">
            TorrentFlow
          </span>
        </Link>

        {/* Mobile: name the current page — the bottom tab bar is the only other
            cue, and its labels are small. */}
        {pageTitle ? (
          <>
            <span
              className="md:hidden h-4 w-px shrink-0 bg-[var(--border)]"
              aria-hidden
            />
            <span className="md:hidden text-[13px] font-medium text-[var(--text-secondary)] truncate">
              {pageTitle}
            </span>
          </>
        ) : null}

        {/* Desktop: flat nav — one click to every main page.
            py/-my give the focus ring room: the scroll container clips on both
            axes, so without it the ring's top and bottom edges are cut off. */}
        <nav
          className="hidden md:flex items-center gap-0.5 flex-1 min-w-0 overflow-x-auto py-1.5 -my-1.5"
          data-desktop-nav
          aria-label="Main"
        >
          {navRow.map((item, i) => {
            const { href, label } = item;
            const active = href === activeDesktopHref;
            // Divider separates the primary path from the secondary pages.
            const showDivider = i === dividerIndex;
            return (
              <span key={href} className="contents">
                {showDivider ? (
                  <span
                    className="mx-1 h-4 w-px shrink-0 bg-[var(--border)]"
                    aria-hidden
                  />
                ) : null}
                <Link
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "px-2.5 lg:px-3 py-1.5 rounded-md text-[13px] font-medium transition-colors whitespace-nowrap shrink-0",
                    "outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]",
                    active
                      ? "text-[var(--text)] bg-[var(--bg-muted)]"
                      : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-muted)]",
                  )}
                >
                  {label}
                </Link>
              </span>
            );
          })}
        </nav>

        {/* Desktop actions: search, then list density */}
        <div className="flex items-center gap-1 sm:gap-1.5 ml-auto shrink-0">
          {/* Search is a permanent affordance rather than a word in the nav
              row: it is the second thing anyone does here, and on Browse there
              is no input for the `/` shortcut to land on. Full control on
              desktop, icon on phones where the bottom tab bar also carries it. */}
          <Link
            href={HEADER_SEARCH_HREF}
            aria-current={searchActive ? "page" : undefined}
            data-header-search
            className={cn(
              "hidden md:inline-flex h-8 items-center gap-2 rounded-md border px-2.5 text-[12px] transition-colors",
              "outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]",
              searchActive
                ? "border-[var(--border-strong)] bg-[var(--bg-muted)] text-[var(--text)]"
                : "border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--text-tertiary)] hover:border-[var(--border-strong)] hover:text-[var(--text-secondary)]",
            )}
          >
            <Search className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="lg:min-w-[7rem] text-left">Search</span>
            <kbd className="hidden lg:inline rounded border border-[var(--border)] bg-[var(--bg)] px-1 font-mono text-[10px] text-[var(--text-tertiary)]">
              /
            </kbd>
          </Link>
          <Link
            href={HEADER_SEARCH_HREF}
            aria-label="Search"
            aria-current={searchActive ? "page" : undefined}
            className={cn(
              "md:hidden inline-flex h-9 w-9 items-center justify-center rounded-md transition-colors",
              "outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]",
              searchActive
                ? "bg-[var(--bg-muted)] text-[var(--text)]"
                : "text-[var(--text-tertiary)] hover:bg-[var(--bg-muted)] hover:text-[var(--text-secondary)]",
            )}
          >
            <Search className="h-4 w-4" aria-hidden />
          </Link>
          <button
            type="button"
            className="hidden md:inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-muted)] transition-colors outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
            onClick={() =>
              setDensity(density === "compact" ? "comfortable" : "compact")
            }
            title={
              density === "compact"
                ? "Density: Compact — click for Comfortable"
                : "Density: Comfortable — click for Compact"
            }
            aria-label={`List density: ${density}. Toggle.`}
            data-density-toggle
          >
            <Rows3 className="h-3.5 w-3.5" />
            <span className="hidden xl:inline capitalize">{density}</span>
          </button>
        </div>
      </div>
    </header>
  );
}
