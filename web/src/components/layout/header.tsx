import { useLayoutEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { ChevronDown, Eye, Search } from "lucide-react";
import { NotificationBell } from "@/components/notifications/notification-feed";
import { cn } from "@/lib/utils";
import { openSearchOverlay } from "@/components/search/search-overlay";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { pendingBadge } from "@/lib/requests";
import { useSessionInfo } from "@/lib/session";
import { setPreviewAsRequester, useCapabilities } from "@/lib/capabilities";
import { useMediaQuery } from "@/hooks/use-media-query";
import {
  HEADER_SEARCH_HREF,
  titleForRoute,
  NOTIFICATIONS_HREF,
  REQUESTS_HREF,
  desktopNavRow,
  navActive,
  navActiveHref,
} from "@/lib/navigation";

/**
 * How far the desktop header has had to fold to fit its row.
 *
 * The header is capped at the page container (72rem), so the room it has stops
 * growing long before the viewport does; viewport breakpoints therefore showed
 * the most text at exactly the widths with the least spare room. Instead the
 * row is measured and folded one step at a time until nothing overflows:
 *
 *   0  everything labelled
 *   1  "View as requester" becomes its eye icon
 *   2  the wordmark goes, the logo stays
 *   3  the search box becomes an icon
 *   4  nav links tighten their padding
 *   5+ trailing nav links move into a "More" menu, one per step
 */
const FOLD_PREVIEW_LABEL = 1;
const FOLD_WORDMARK = 2;
const FOLD_SEARCH_LABEL = 3;
const FOLD_TIGHT_LINKS = 4;
const FOLD_OVERFLOW = 5;

function useHeaderFold(contentKey: string, maxFold: number) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const navRef = useRef<HTMLElement | null>(null);
  const [fold, setFold] = useState(0);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const next = Math.round(entries[0]?.contentRect.width ?? 0);
      setWidth((prev) => (prev === next ? prev : next));
    });
    observer.observe(row);
    return () => observer.disconnect();
  }, []);

  // Width or content changed: start from the roomiest layout and fold again.
  const measuredKey = useRef<string | null>(null);
  useLayoutEffect(() => {
    const key = `${width}|${contentKey}`;
    if (measuredKey.current !== key) {
      measuredKey.current = key;
      if (fold !== 0) {
        setFold(0);
        return;
      }
    }
    const row = rowRef.current;
    const nav = navRef.current;
    if (!row || !nav || nav.offsetParent === null) return;
    const overflowing =
      nav.scrollWidth > nav.clientWidth || row.scrollWidth > row.clientWidth;
    if (overflowing && fold < maxFold) setFold(fold + 1);
  });

  return { rowRef, navRef, fold };
}

export function Header() {
  const pathname = useLocation().pathname;
  const navigate = useNavigate();
  // Synchronous with the route — never derived from a previous page's owns map.
  const pageTitle = titleForRoute(pathname);
  const caps = useCapabilities();
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const { items: fullRow, dividerIndex: fullDivider } = desktopNavRow(caps);
  // Notifications is the bell beside search, which carries the one unread
  // count. A text link to the same page next to it printed the count twice.
  const dividerHref = fullRow[fullDivider]?.href ?? null;
  const navRow = fullRow.filter((item) => item.href !== NOTIFICATIONS_HREF);
  const activeDesktopHref = navActiveHref(fullRow, pathname);
  const pending = useSessionInfo().pendingRequests;
  const requestsBadge = caps.canReviewRequests ? pendingBadge(pending) : null;
  const searchActive = navActive(pathname, HEADER_SEARCH_HREF);

  const { rowRef, navRef, fold } = useHeaderFold(
    `${navRow.map((i) => i.href).join(",")}|${requestsBadge ?? ""}|${caps.canPreview}`,
    FOLD_OVERFLOW + navRow.length - 1,
  );
  const overflowCount = Math.max(0, fold - FOLD_OVERFLOW + 1);
  const inlineRow = overflowCount ? navRow.slice(0, navRow.length - overflowCount) : navRow;
  const moreRow = overflowCount ? navRow.slice(navRow.length - overflowCount) : [];
  const moreActive = moreRow.some((item) => item.href === activeDesktopHref);
  const showWordmark = fold < FOLD_WORDMARK;
  const showSearchLabel = fold < FOLD_SEARCH_LABEL;
  const showPreviewLabel = fold < FOLD_PREVIEW_LABEL;
  const tightLinks = fold >= FOLD_TIGHT_LINKS;

  // A plain click opens the palette and gives it the durable `/search` URL;
  // modified clicks still open that fallback route in a new tab.
  function onSearchClick(e: React.MouseEvent) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0)
      return;
    e.preventDefault();
    openSearchOverlay();
  }

  return (
    <header className="app-header" data-app-header>
      <div ref={rowRef} className="container-app flex h-14 items-center gap-3 sm:gap-4">
        <Link
          to="/"
          aria-label="TorrentFlow home"
          data-brand-home
          className={cn(
            "flex h-11 min-h-[44px] min-w-[44px] items-center gap-2 shrink-0 rounded-md",
            showWordmark && isDesktop ? "w-auto justify-start" : "w-11 justify-center",
          )}
        >
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
          {showWordmark && isDesktop ? (
            <span className="text-sm font-semibold tracking-tight text-[var(--text)] whitespace-nowrap">
              TorrentFlow
            </span>
          ) : null}
        </Link>

        {/* Mobile: name the current page — the bottom tab bar is the only other
            cue, and its labels are small. Title comes from titleForRoute so it
            always matches the URL on this render (no lag / owns bleed). */}
        {pageTitle ? (
          <>
            <span
              className="md:hidden h-4 w-px shrink-0 bg-[var(--border)]"
              aria-hidden
            />
            <span
              data-header-page-title
              className="md:hidden text-[13px] font-medium text-[var(--text-secondary)] truncate"
            >
              {pageTitle}
            </span>
          </>
        ) : null}

        {/* Desktop: flat nav — one click to every main page. It never scrolls:
            useHeaderFold folds labels and, as a last resort, moves trailing
            links into "More" until the row fits. py/-my give the focus ring
            room inside the clipped row. */}
        <nav
          ref={navRef}
          className="hidden md:flex items-center gap-0.5 flex-1 min-w-0 overflow-hidden py-1.5 -my-1.5 px-0.5 -mx-0.5"
          data-desktop-nav
          data-header-fold={fold}
          aria-label="Main"
        >
          {inlineRow.map((item) => {
            const { href, label } = item;
            const active = href === activeDesktopHref;
            // Divider separates the primary path from the secondary pages.
            const showDivider = href === dividerHref;
            return (
              <span key={href} className="contents">
                {showDivider ? (
                  <span
                    className="mx-1 h-4 w-px shrink-0 bg-[var(--border)]"
                    aria-hidden
                  />
                ) : null}
                <Link
                  to={href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "inline-flex items-center min-h-[44px] py-1.5 rounded-md text-[13px] font-medium transition-colors whitespace-nowrap shrink-0",
                    tightLinks ? "px-2" : "px-3",
                    "outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]",
                    active
                      ? "text-[var(--text)] bg-[var(--bg-muted)]"
                      : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-muted)]",
                  )}
                >
                  {label}
                  {href === REQUESTS_HREF && requestsBadge ? (
                    <span
                      data-nav-requests-pending
                      aria-label={`${requestsBadge} pending`}
                      className="ml-1.5 inline-block min-w-[20px] rounded-full bg-[var(--accent)] px-1.5 text-center text-[12px] font-semibold leading-[18px] tabular-nums text-[var(--primary-foreground)]"
                    >
                      {requestsBadge}
                    </span>
                  ) : null}
                </Link>
              </span>
            );
          })}
          {moreRow.length ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                data-header-more
                aria-current={moreActive ? "page" : undefined}
                className={cn(
                  "inline-flex items-center gap-1 min-h-[44px] px-2 py-1.5 rounded-md text-[13px] font-medium whitespace-nowrap shrink-0 transition-colors",
                  "outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]",
                  moreActive
                    ? "text-[var(--text)] bg-[var(--bg-muted)]"
                    : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-muted)]",
                )}
              >
                More
                {requestsBadge && moreRow.some((item) => item.href === REQUESTS_HREF) ? (
                  <span
                    data-nav-more-pending
                    aria-label={`${requestsBadge} pending`}
                    className="inline-block min-w-[20px] rounded-full bg-[var(--accent)] px-1.5 text-center text-[12px] font-semibold leading-[18px] tabular-nums text-[var(--primary-foreground)]"
                  >
                    {requestsBadge}
                  </span>
                ) : null}
                <ChevronDown className="h-3.5 w-3.5" aria-hidden />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {moreRow.map((item) => (
                  <DropdownMenuItem
                    key={item.href}
                    onSelect={() => navigate(item.href)}
                    className={cn(
                      "min-h-[44px]",
                      item.href === activeDesktopHref && "text-[var(--text)] bg-[var(--bg-muted)]",
                    )}
                  >
                    {item.label}
                    {item.href === REQUESTS_HREF && requestsBadge ? (
                      <span className="ml-auto text-[12px] tabular-nums text-[var(--text-tertiary)]">
                        {requestsBadge} pending
                      </span>
                    ) : null}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </nav>

        {/* Desktop actions: search, then list density */}
        <div className="flex items-center gap-1 sm:gap-1.5 ml-auto shrink-0">
          <NotificationBell />
          {/* Search is a permanent affordance rather than a word in the nav
              row: it is the second thing anyone does here, and on Browse there
              is no input for the `/` shortcut to land on. Full control on
              desktop, icon on phones where the bottom tab bar also carries it. */}
          <Link
            to={HEADER_SEARCH_HREF}
            onClick={onSearchClick}
            aria-current={searchActive ? "page" : undefined}
            aria-label="Search"
            data-header-search
            data-search-trigger
            className={cn(
              "hidden md:inline-flex shrink-0 items-center gap-2 rounded-md border text-[12px] transition-colors",
              showSearchLabel ? "h-9 w-auto justify-start px-2.5" : "h-11 w-11 justify-center",
              "outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]",
              searchActive
                ? "border-[var(--border-strong)] bg-[var(--bg-muted)] text-[var(--text)]"
                : "border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--text-tertiary)] hover:border-[var(--border-strong)] hover:text-[var(--text-secondary)]",
            )}
          >
            <Search className="h-3.5 w-3.5 shrink-0" aria-hidden />
            {showSearchLabel ? (
              <>
                <span className="min-w-[7rem] text-left" aria-hidden>Search</span>
                <kbd className="rounded border border-[var(--border)] bg-[var(--bg)] px-1 font-mono text-[12px] leading-none text-[var(--text-tertiary)]" aria-hidden>
                  /
                </kbd>
              </>
            ) : null}
          </Link>
          <Link
            to={HEADER_SEARCH_HREF}
            onClick={onSearchClick}
            aria-label="Search"
            aria-current={searchActive ? "page" : undefined}
            data-search-trigger
            className={cn(
              "md:hidden inline-flex h-11 w-11 items-center justify-center rounded-md transition-colors",
              "outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]",
              searchActive
                ? "bg-[var(--bg-muted)] text-[var(--text)]"
                : "text-[var(--text-tertiary)] hover:bg-[var(--bg-muted)] hover:text-[var(--text-secondary)]",
            )}
          >
            <Search className="h-4 w-4" aria-hidden />
          </Link>
          {/* Phones get the toggle in the More sheet. Rendering a CSS-hidden twin here
              gave the page two "View as requester" buttons, one of them invisible. */}
          {caps.canPreview && isDesktop ? (
            <button
              type="button"
              onClick={() => setPreviewAsRequester(true)}
              data-preview-toggle
              aria-label="View as requester"
              title="See the app the way people you share it with do"
              className={cn(
                "hidden md:inline-flex h-11 min-w-[44px] shrink-0 items-center justify-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium whitespace-nowrap text-[var(--text-tertiary)] transition-colors",
                "hover:bg-[var(--bg-muted)] hover:text-[var(--text-secondary)]",
                "outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]",
              )}
            >
              <Eye className="h-3.5 w-3.5 shrink-0" aria-hidden />
              {/* One name: aria-label. The word is shown only when the row has room. */}
              {showPreviewLabel ? <span aria-hidden>View as requester</span> : null}
            </button>
          ) : null}
          {/* The list-density toggle used to sit here.
              It answered an implementation question — how tightly should rows
              pack — rather than a user question, and it was a permanent control
              in the header paid for by every viewer to serve the few who ever
              pressed it. Removed with Rules and Activity as part of reducing
              the chrome to five destinations and a search box. */}
        </div>
      </div>
    </header>
  );
}
