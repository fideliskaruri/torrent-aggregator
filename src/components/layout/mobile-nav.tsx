"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  Boxes,
  Circle,
  Clapperboard,
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
import {
  EVERYTHING_HREF,
  MORE_ACTIVE_PREFIXES,
  PRIMARY_NAV,
  SECONDARY_NAV,
  SEARCH_HREF,
  navActiveHref,
} from "@/lib/navigation";

/** Icons live here because they are presentation, not part of the nav model. */
const NAV_ICONS: Record<string, typeof Search> = {
  "/": Clapperboard,
  [SEARCH_HREF]: Search,
  [EVERYTHING_HREF]: Boxes,
  "/watchlist": Library,
  "/downloads": HardDriveDownload,
  "/notifications": Activity,
  "/settings": Settings,
  "/rules": Zap,
  "/about": Info,
};

/**
 * A nav entry with no icon must still render. The model is the source of truth
 * for *what* the nav contains, so a new entry there cannot be allowed to crash
 * the tab bar just because this presentation map has not caught up.
 */
const NAV_ICON_FALLBACK = Circle;

const PRIMARY_TABS = PRIMARY_NAV.map((item) => ({
  ...item,
  icon: NAV_ICONS[item.href] ?? NAV_ICON_FALLBACK,
}));

const MORE_ITEMS = SECONDARY_NAV.map((item) => ({
  ...item,
  icon: NAV_ICONS[item.href] ?? NAV_ICON_FALLBACK,
}));

export function MobileNav() {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const sheetRef = useRef<HTMLDivElement | null>(null);
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
    // Lock the *document element*, not `body`. `body { overflow: hidden }` only
    // stops the page when the UA propagates body's overflow to the viewport,
    // and that propagation is disabled whenever `html` is not `overflow:
    // visible` — which it isn't, because `html` carries `overflow-x: hidden`.
    // Locking body was therefore a no-op and the page scrolled behind the open
    // sheet. `scrollbar-gutter: stable` on `html` keeps this from shifting the
    // layout when the scrollbar goes away.
    const root = document.documentElement;
    const prev = root.style.overflow;
    root.style.overflow = "hidden";

    // The sheet claims `aria-modal="true"`, which tells assistive technology
    // that everything behind it is inert. Without focus management that claim
    // was false: focus stayed on the More button, and 41 tab stops sat between
    // it and the first item *inside* the sheet — a keyboard or screen-reader
    // user tabbed through the dimmed page they were told they could not reach.
    const sheet = sheetRef.current;
    const restoreTo = document.activeElement as HTMLElement | null;
    const focusables = () =>
      Array.from(
        sheet?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter(
        // The scrim is a full-bleed close button that exists for pointer
        // dismissal only; putting it in the tab order would mean the first Tab
        // press lands on "close the thing you just opened".
        (el) => el.offsetParent !== null && !el.hasAttribute("data-sheet-scrim"),
      );

    focusables()[0]?.focus();

    const onTab = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusables();
      if (!items.length) return;
      const head = items[0];
      const tail = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (!sheet?.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? tail : head).focus();
      } else if (e.shiftKey && active === head) {
        e.preventDefault();
        tail.focus();
      } else if (!e.shiftKey && active === tail) {
        e.preventDefault();
        head.focus();
      }
    };
    document.addEventListener("keydown", onTab, true);

    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("keydown", onTab, true);
      root.style.overflow = prev;
      // Only restore focus if it is still inside the sheet; a click on a nav
      // link has already moved it somewhere the user chose.
      if (!restoreTo) return;
      if (sheet && sheet.contains(document.activeElement)) restoreTo.focus();
      else if (document.activeElement === document.body) restoreTo.focus();
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
          ref={sheetRef}
          role="dialog"
          aria-modal="true"
          aria-label="More"
        >
          <button
            type="button"
            data-sheet-scrim
            tabIndex={-1}
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
                className="inline-flex h-11 w-11 items-center justify-center rounded-md text-[var(--text-tertiary)] hover:bg-[var(--bg-muted)] hover:text-[var(--text)] transition-colors outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
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
                          "flex items-center gap-3 rounded-lg px-3 py-2.5 min-h-[44px] text-[13px] font-medium transition-colors",
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
        {/* One column per primary tab, plus More only when there is anything
            in it. Driven by the nav model so adding an entry cannot leave a tab
            hanging off the edge — and so an empty More sheet does not cost
            every other tab a sixth of the bar. At 390px that is 78px per tab
            instead of 65px, which is what decides whether "Notifications"
            renders or truncates to a half-word. */}
        <div
          className="grid h-[var(--mobile-nav-h)]"
          style={{
            gridTemplateColumns: `repeat(${
              PRIMARY_TABS.length + (MORE_ITEMS.length > 0 ? 1 : 0)
            }, minmax(0, 1fr))`,
          }}
        >
          {PRIMARY_TABS.map(({ href, label, icon: Icon }) => {
            // Browse (`/`) is the catalog — active for exact `/` only
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
                <span className="max-w-full truncate px-0.5">{label}</span>
              </Link>
            );
          })}

          {MORE_ITEMS.length > 0 ? (
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
          ) : null}
        </div>
      </nav>
    </>
  );
}
