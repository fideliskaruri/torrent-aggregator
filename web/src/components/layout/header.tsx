import { useLayoutEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { ChevronDown, CircleUser, Eye, LogOut, Search } from "lucide-react";
import { NotificationBell } from "@/components/notifications/notification-feed";
import { cn } from "@/lib/utils";
import { openSearchOverlay } from "@/components/search/search-overlay";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { signOut } from "@/lib/sign-out";
import {
  NavigationMenu,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  navigationMenuTriggerStyle,
} from "@/components/ui/navigation-menu";
import { Separator } from "@/components/ui/separator";
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

  // The nav also narrows when the actions grow (the bell count loads late).
  // Re-render so the check below can fold further without a row resize.
  const [, setNavTick] = useState(0);
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setNavTick((n) => n + 1));
    observer.observe(nav);
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
  const { pendingRequests: pending, via, email } = useSessionInfo();
  const showAccount = via === "tunnel" && !!email;
  const requestsBadge = caps.canReviewRequests ? pendingBadge(pending) : null;
  const searchActive = navActive(pathname, HEADER_SEARCH_HREF);

  const { rowRef, navRef, fold } = useHeaderFold(
    `${navRow.map((i) => i.href).join(",")}|${requestsBadge ?? ""}|${caps.canPreview}|${showAccount}`,
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
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--brand)] text-[var(--primary-foreground)]">
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
            <Separator orientation="vertical" className="md:hidden data-vertical:h-4 data-vertical:self-center" />
            <span
              data-header-page-title
              className="md:hidden min-w-0 truncate text-[13px] font-medium text-muted-foreground"
            >
              {pageTitle}
            </span>
          </>
        ) : null}

        {/* Desktop: flat nav — one click to every main page. It never scrolls:
            useHeaderFold folds labels and, as a last resort, moves trailing
            links into "More" until the row fits. py/-my give the focus ring
            room inside the clipped row. */}
        <NavigationMenu
          ref={navRef}
          viewport={false}
          className="hidden md:flex flex-1 min-w-0 max-w-none justify-start overflow-hidden py-1.5 -my-1.5 px-0.5 -mx-0.5"
          data-desktop-nav
          data-header-fold={fold}
          aria-label="Main"
        >
          <NavigationMenuList className="flex-none justify-start gap-0.5">
            {inlineRow.map((item) => {
              const { href, label } = item;
              const active = href === activeDesktopHref;
              // Divider separates the primary path from the secondary pages.
              const showDivider = href === dividerHref;
              return (
                <NavigationMenuItem key={href} className="flex items-center">
                  {showDivider ? (
                    <Separator orientation="vertical" className="mx-1 data-vertical:h-4 data-vertical:self-center" />
                  ) : null}
                  <NavigationMenuLink asChild active={active}>
                    <Link
                      to={href}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        navigationMenuTriggerStyle(),
                        "h-9 pointer-coarse:h-11 gap-1.5 whitespace-nowrap text-[13px]",
                        tightLinks ? "px-2" : "px-3",
                        active
                          ? "bg-muted text-foreground"
                          : "text-subtle-foreground hover:text-muted-foreground",
                      )}
                    >
                      {label}
                      {href === REQUESTS_HREF && requestsBadge ? (
                        <Badge
                          variant="solid"
                          data-nav-requests-pending
                          aria-label={`${requestsBadge} pending`}
                          className="min-w-5 rounded-full px-1.5 text-[12px] font-semibold tabular-nums"
                        >
                          {requestsBadge}
                        </Badge>
                      ) : null}
                    </Link>
                  </NavigationMenuLink>
                </NavigationMenuItem>
              );
            })}
            {moreRow.length ? (
              <NavigationMenuItem>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    data-header-more
                    aria-current={moreActive ? "page" : undefined}
                    className={cn(
                      navigationMenuTriggerStyle(),
                      "h-9 pointer-coarse:h-11 gap-1 px-2 text-[13px] whitespace-nowrap",
                      moreActive
                        ? "bg-muted text-foreground"
                        : "text-subtle-foreground hover:text-muted-foreground",
                    )}
                  >
                    More
                    {requestsBadge && moreRow.some((item) => item.href === REQUESTS_HREF) ? (
                      <Badge
                        variant="solid"
                        data-nav-more-pending
                        aria-label={`${requestsBadge} pending`}
                        className="min-w-5 rounded-full px-1.5 text-[12px] font-semibold tabular-nums"
                      >
                        {requestsBadge}
                      </Badge>
                    ) : null}
                    <ChevronDown className="size-3.5" aria-hidden />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    {moreRow.map((item) => (
                      <DropdownMenuItem
                        key={item.href}
                        onSelect={() => navigate(item.href)}
                        className={cn(
                          "min-h-11",
                          item.href === activeDesktopHref && "bg-muted text-foreground",
                        )}
                      >
                        {item.label}
                        {item.href === REQUESTS_HREF && requestsBadge ? (
                          <span className="ml-auto text-[12px] tabular-nums text-subtle-foreground">
                            {requestsBadge} pending
                          </span>
                        ) : null}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </NavigationMenuItem>
            ) : null}
          </NavigationMenuList>
        </NavigationMenu>

        {/* Desktop actions: search, then list density */}
        <div className="flex items-center gap-1 sm:gap-1.5 ml-auto shrink-0">
          <NotificationBell />
          {/* Search is a permanent affordance rather than a word in the nav
              row: it is the second thing anyone does here, and on Browse there
              is no input for the `/` shortcut to land on. Full control on
              desktop, icon on phones where the bottom tab bar also carries it. */}
          <Button
            asChild
            variant="outline"
            className={cn(
              "hidden md:inline-flex shrink-0 text-[12px] font-normal",
              showSearchLabel ? "h-9 justify-start px-2.5" : "size-9 px-0",
              searchActive
                ? "border-input bg-muted text-foreground"
                : "bg-card text-subtle-foreground hover:text-muted-foreground",
            )}
          >
            <Link
              to={HEADER_SEARCH_HREF}
              onClick={onSearchClick}
              aria-current={searchActive ? "page" : undefined}
              aria-label="Search"
              data-header-search
              data-search-trigger
            >
              <Search className="size-3.5 shrink-0" aria-hidden />
              {showSearchLabel ? (
                <>
                  <span className="min-w-[7rem] text-left" aria-hidden>Search</span>
                  <Kbd aria-hidden>/</Kbd>
                </>
              ) : null}
            </Link>
          </Button>
          <Button
            asChild
            variant="ghost"
            size="icon"
            className={cn(
              "md:hidden size-11",
              searchActive ? "bg-muted text-foreground" : "text-subtle-foreground",
            )}
          >
            <Link
              to={HEADER_SEARCH_HREF}
              onClick={onSearchClick}
              aria-label="Search"
              aria-current={searchActive ? "page" : undefined}
              data-search-trigger
            >
              <Search className="size-4" aria-hidden />
            </Link>
          </Button>
          {/* Phones get the toggle in the More sheet. Rendering a CSS-hidden twin here
              gave the page two "View as requester" buttons, one of them invisible. */}
          {caps.canPreview && isDesktop ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => setPreviewAsRequester(true)}
              data-preview-toggle
              aria-label="View as requester"
              title="See the app the way people you share it with do"
              className="hidden md:inline-flex h-9 min-w-9 pointer-coarse:h-11 pointer-coarse:min-w-11 shrink-0 px-2.5 text-[12px] text-subtle-foreground hover:text-muted-foreground"
            >
              <Eye className="size-3.5 shrink-0" aria-hidden />
              {/* One name: aria-label. The word is shown only when the row has room. */}
              {showPreviewLabel ? <span aria-hidden>View as requester</span> : null}
            </Button>
          ) : null}
          {/* Only a Cloudflare Access session can be signed out of. On this
              computer nobody signs in, so there is no account menu at all. */}
          {showAccount && isDesktop ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  data-account-menu
                  aria-label={`Account, signed in as ${email}`}
                  title={email ?? undefined}
                  className="hidden md:inline-flex size-9 pointer-coarse:size-11 shrink-0 text-subtle-foreground hover:text-muted-foreground"
                >
                  <CircleUser className="size-4" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuLabel className="flex flex-col gap-0.5 font-normal">
                  <span className="text-[12px] text-subtle-foreground">Signed in as</span>
                  <span data-account-email className="truncate text-[13px] font-medium text-foreground">
                    {email}
                  </span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={signOut} data-sign-out className="min-h-11 text-[13px]">
                  <LogOut className="size-4" aria-hidden />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
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
