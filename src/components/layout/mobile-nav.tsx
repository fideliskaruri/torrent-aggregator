"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  HardDriveDownload,
  Info,
  Library,
  MoreHorizontal,
  Search,
  Settings,
  X,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useUiPreferences } from "@/components/providers/ui-preferences";
import {
  MORE_ACTIVE_PREFIXES,
  PRIMARY_NAV,
  SECONDARY_NAV,
  navActiveHref,
} from "@/lib/navigation";

/** Icons live here because they are presentation, not part of the nav model. */
const NAV_ICONS: Record<string, typeof Search> = {
  "/": Search,
  "/watchlist": Library,
  "/client": HardDriveDownload,
  "/activity": Activity,
  "/settings": Settings,
  "/rules": Zap,
  "/about": Info,
};

const PRIMARY_TABS = PRIMARY_NAV.map((item) => ({
  ...item,
  icon: NAV_ICONS[item.href],
}));

const MORE_ITEMS = SECONDARY_NAV.map((item) => ({
  ...item,
  icon: NAV_ICONS[item.href],
}));

const DENSITY_OPTIONS = [
  { value: "compact" as const, label: "Compact" },
  { value: "comfortable" as const, label: "Comfortable" },
];

export function MobileNav() {
  const pathname = usePathname();
  const { density, setDensity } = useUiPreferences();
  const [moreOpen, setMoreOpen] = useState(false);
  const activeMoreHref = navActiveHref(SECONDARY_NAV, pathname);

  useEffect(() => {
    // The current route is external navigation state; closing the sheet on route changes belongs in an effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMoreOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!moreOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMoreOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [moreOpen]);

  const moreRouteActive = MORE_ACTIVE_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
  const moreTabActive = moreRouteActive || moreOpen;

  return (
    <>
      {moreOpen ? (
        <div
          className="md:hidden fixed inset-0 z-50"
          data-mobile-more-sheet
          role="dialog"
          aria-modal="true"
          aria-label="More"
        >
          <button
            type="button"
            className="absolute inset-0 bg-black/55"
            aria-label="Close menu"
            onClick={() => setMoreOpen(false)}
          />
          <div
            className="absolute inset-x-0 bottom-0 rounded-t-xl border-t border-[var(--border)] bg-[var(--bg-elevated)] shadow-[var(--shadow-md)]"
            style={{ paddingBottom: "var(--safe-bottom)" }}
          >
            <div className="flex justify-center pt-2 pb-1" aria-hidden>
              <span className="h-1 w-9 rounded-full bg-[var(--border-strong)]" />
            </div>

            <div className="flex items-center justify-between gap-2 px-4 pb-2">
              <h2 className="text-sm font-semibold tracking-tight text-[var(--text)]">
                More
              </h2>
              <button
                type="button"
                onClick={() => setMoreOpen(false)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--text-tertiary)] hover:bg-[var(--bg-muted)] hover:text-[var(--text)] transition-colors outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <nav className="px-2 pb-1" aria-label="Secondary">
              <ul className="flex flex-col gap-0.5">
                {MORE_ITEMS.map(({ href, label, icon: Icon }) => {
                  const active = href === activeMoreHref;
                  return (
                    <li key={href}>
                      <Link
                        href={href}
                        aria-current={active ? "page" : undefined}
                        onClick={() => setMoreOpen(false)}
                        className={cn(
                          "flex items-center gap-3 rounded-lg px-3 py-2.5 text-[13px] font-medium transition-colors",
                          active
                            ? "bg-[var(--accent-dim)] text-[var(--accent-text)]"
                            : "text-[var(--text-secondary)] hover:bg-[var(--bg-muted)] hover:text-[var(--text)]",
                        )}
                      >
                        <Icon
                          className={cn(
                            "h-4 w-4 shrink-0",
                            active
                              ? "text-[var(--accent)]"
                              : "text-[var(--text-tertiary)]",
                          )}
                          strokeWidth={active ? 2.25 : 1.75}
                        />
                        {label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </nav>

            <div
              className="mx-2 my-2 border-t border-[var(--border)] px-2 pt-3 pb-1"
              role="group"
              aria-label="Density"
            >
              <div className="mb-1.5 text-[11px] font-medium tracking-wide text-[var(--text-tertiary)]">
                Density
              </div>
              <div className="grid grid-cols-2 gap-0.5 rounded-md bg-[var(--bg)] p-0.5 ring-1 ring-[var(--border)]">
                {DENSITY_OPTIONS.map(({ value, label }) => {
                  const active = density === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setDensity(value)}
                      className={cn(
                        "rounded-[5px] px-2 py-2 text-[12px] font-medium transition-colors outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]",
                        active
                          ? "bg-[var(--accent-dim)] text-[var(--accent-text)] shadow-[var(--shadow-sm)]"
                          : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-muted)]",
                      )}
                      aria-pressed={active}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <nav
        className="md:hidden fixed inset-x-0 bottom-0 z-40 border-t border-[var(--border)] bg-[var(--bg)]"
        style={{
          paddingBottom: "var(--safe-bottom)",
          height: "calc(var(--mobile-nav-h) + var(--safe-bottom))",
        }}
        data-mobile-nav
        aria-label="Primary"
      >
        <div className="grid h-[var(--mobile-nav-h)] grid-cols-4">
          {PRIMARY_TABS.map(({ href, label, icon: Icon }) => {
            // Home (`/`) is the search surface — active for exact `/` only
            const active =
              href === "/"
                ? pathname === "/"
                : pathname === href || pathname.startsWith(`${href}/`);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors",
                  // The bar is fixed to the bottom edge and the tabs run
                  // edge-to-edge, so an outer ring is clipped by the viewport on
                  // every side. An inset ring is always fully visible.
                  "outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]",
                  active
                    ? "text-[var(--accent-text)]"
                    : "text-[var(--text-tertiary)]",
                )}
              >
                <Icon
                  className={cn("h-5 w-5", active && "text-[var(--accent)]")}
                  strokeWidth={active ? 2.25 : 1.75}
                />
                {label}
              </Link>
            );
          })}

          <button
            type="button"
            data-mobile-more
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((o) => !o)}
            className={cn(
              "flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]",
              moreTabActive
                ? "text-[var(--accent-text)]"
                : "text-[var(--text-tertiary)]",
            )}
          >
            <MoreHorizontal
              className={cn(
                "h-5 w-5",
                moreTabActive && "text-[var(--accent)]",
              )}
              strokeWidth={moreTabActive ? 2.25 : 1.75}
            />
            More
          </button>
        </div>
      </nav>
    </>
  );
}
