"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession, signOut } from "next-auth/react";
import { LogIn, LogOut, Rows3 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useUiPreferences } from "@/components/providers/ui-preferences";
import { Button } from "@/components/ui/button";

/**
 * Library aggregator path:
 *   Search (discover/add) → Library (monitor shows) → Activity → Client
 * Rules are advanced (linked from Settings/footer), not a primary peer.
 */
const NAV = [
  { href: "/", label: "Search" },
  { href: "/watchlist", label: "Library" },
  { href: "/activity", label: "Activity" },
  { href: "/client", label: "Client" },
  { href: "/settings", label: "Settings" },
] as const;

function navActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Header() {
  const pathname = usePathname();
  const { data: session } = useSession();
  const { density, setDensity } = useUiPreferences();

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

        {/* Desktop: flat nav — one click to every main page */}
        <nav
          className="hidden md:flex items-center gap-0.5 flex-1 min-w-0 overflow-x-auto"
          data-desktop-nav
          aria-label="Main"
        >
          {NAV.map(({ href, label }, i) => {
            const active = navActive(pathname, href);
            // Soft split after package trio (Search · Library · Client)
            const showDivider = i === 3;
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
                  className={cn(
                    "px-2.5 lg:px-3 py-1.5 rounded-md text-[13px] font-medium transition-colors whitespace-nowrap shrink-0",
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

        {/* Desktop actions: density (1 click) + auth */}
        <div className="flex items-center gap-1 sm:gap-1.5 ml-auto shrink-0">
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

          {session?.user ? (
            <>
              <span className="hidden lg:block text-[12px] text-[var(--text-tertiary)] max-w-[100px] truncate">
                {session.user.name || session.user.email}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="hidden md:inline-flex"
                onClick={() => signOut({ callbackUrl: "/" })}
              >
                <LogOut className="h-3.5 w-3.5" />
                <span className="hidden lg:inline">Sign out</span>
              </Button>
            </>
          ) : (
            <Button asChild size="sm" className="hidden md:inline-flex">
              <Link href="/login">
                <LogIn className="h-3.5 w-3.5" />
                Sign in
              </Link>
            </Button>
          )}
        </div>
      </div>
    </header>
  );
}
