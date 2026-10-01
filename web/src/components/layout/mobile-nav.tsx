import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import {
  Activity,
  Boxes,
  CalendarClock,
  Circle,
  CircleUser,
  Clapperboard,
  Eye,
  HardDriveDownload,
  Inbox,
  Info,
  Library,
  LogOut,
  MoreHorizontal,
  Search,
  Settings,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { useUnreadNotifications } from "@/app/notifications/use-unread";
import {
  EVERYTHING_HREF,
  MOBILE_MORE_NAV,
  MOBILE_PRIMARY_NAV,
  NOTIFICATIONS_HREF,
  REQUESTS_HREF,
  SEARCH_HREF,
  navActiveHref,
  navFor,
  type NavItem,
} from "@/lib/navigation";
import { pendingBadge } from "@/lib/requests";
import { NavPendingBadge } from "./nav-pending-badge";
import { useSessionInfo } from "@/lib/session";
import { setPreviewAsRequester, useCapabilities } from "@/lib/capabilities";
import { signOut } from "@/lib/sign-out";

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
  [REQUESTS_HREF]: Inbox,
  "/upcoming": CalendarClock,
};

/**
 * A nav entry with no icon must still render. The model is the source of truth
 * for *what* the nav contains, so a new entry there cannot be allowed to crash
 * the tab bar just because this presentation map has not caught up.
 */
const NAV_ICON_FALLBACK = Circle;

const withIcons = (items: readonly NavItem[]) =>
  items.map((item) => ({ ...item, icon: NAV_ICONS[item.href] ?? NAV_ICON_FALLBACK }));

export function MobileNav() {
  const pathname = useLocation().pathname;
  const { badge } = useUnreadNotifications();
  const caps = useCapabilities();
  const { pendingRequests: pending, via, email } = useSessionInfo();
  const requestsBadge = caps.canReviewRequests ? pendingBadge(pending) : null;
  const PRIMARY_TABS = withIcons(navFor(MOBILE_PRIMARY_NAV, caps));
  const MORE_ITEMS = withIcons(navFor(MOBILE_MORE_NAV, caps));
  // The owner's preview switch lives in More, so More shows whenever it has either.
  const showPreviewToggle = caps.canPreview;
  // Only a Cloudflare Access session can be signed out of; on this computer nobody signs in.
  const showAccount = via === "tunnel" && !!email;
  const showMore = MORE_ITEMS.length > 0 || showPreviewToggle || showAccount;
  const [moreOpen, setMoreOpen] = useState(false);
  const moreNavRef = useRef<HTMLElement>(null);
  const activePrimaryHref = navActiveHref(PRIMARY_TABS, pathname);
  const activeMoreHref = navActiveHref(MORE_ITEMS, pathname);

  useEffect(() => {
    // The current route is external navigation state; closing the sheet on route changes belongs in an effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMoreOpen(false);
  }, [pathname]);


  const moreRouteActive =
    activeMoreHref !== null ||
    (MORE_ITEMS.some((item) => item.href === "/settings") &&
      (pathname === "/about" || pathname.startsWith("/about/")));
  const moreTabActive = moreRouteActive || moreOpen;

  return (
    // The Sheet wraps the tab bar too, so the More tab can be its trigger.
    // Radix then owns the focus trap, Escape, scroll lock, and returning focus
    // to More on close; a sheet opened from plain state has nothing to return to.
    <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
      <SheetContent
        side="bottom"
        data-mobile-more-sheet
        className="md:hidden gap-0 max-h-[calc(100dvh-var(--header-h))] overflow-y-auto overscroll-contain rounded-t-xl"
        style={{ paddingBottom: "var(--safe-bottom)" }}
        onOpenAutoFocus={(event) => {
          // Radix skips links when it picks what to focus, which lands on the
          // last control. Start on the first page in the list instead.
          const first = moreNavRef.current?.querySelector<HTMLElement>("a[href]");
          if (!first) return;
          event.preventDefault();
          first.focus();
        }}
      >
        <div className="flex justify-center pt-2 pb-1" aria-hidden>
          <span className="h-1 w-9 rounded-full bg-input" />
        </div>
        <SheetHeader className="px-4 pt-1 pb-2">
          <SheetTitle className="text-sm">More</SheetTitle>
          <SheetDescription className="sr-only">Other pages and options</SheetDescription>
        </SheetHeader>

        <nav ref={moreNavRef} className="px-2 pb-1" aria-label="Secondary">
          <ul className="flex flex-col gap-0.5">
            {MORE_ITEMS.map(({ href, label, icon: Icon }) => {
              const active = href === activeMoreHref;
              return (
                <li key={href}>
                  <Link
                    to={href}
                    aria-current={active ? "page" : undefined}
                    onClick={() => setMoreOpen(false)}
                    className={cn(
                      "flex min-h-[44px] items-center gap-3 rounded-lg px-3 py-2.5 text-[13px] font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                      active
                        ? "bg-brand-dim text-brand-foreground"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    <Icon
                      className={cn("size-4 shrink-0", active ? "text-brand" : "text-subtle-foreground")}
                      strokeWidth={active ? 2.25 : 1.75}
                    />
                    {label}
                    {href === REQUESTS_HREF && requestsBadge ? (
                      <NavPendingBadge count={requestsBadge} data-nav-requests-pending className="ml-auto" />
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        {showPreviewToggle ? (
          <>
            <Separator />
            <div className="px-2 pt-1 pb-2">
              <Button
                type="button"
                variant="ghost"
                data-preview-toggle
                aria-label="View as requester"
                onClick={() => {
                  setPreviewAsRequester(true);
                  setMoreOpen(false);
                }}
                className="h-auto min-h-[44px] w-full justify-start gap-3 px-3 py-2.5 text-[13px] text-muted-foreground"
              >
                <Eye className="size-4 shrink-0 text-subtle-foreground" strokeWidth={1.75} aria-hidden />
                View as requester
              </Button>
            </div>
          </>
        ) : null}
        {showAccount ? (
          <>
            <Separator />
            <div className="px-2 pt-2 pb-2" data-mobile-account>
              <p className="flex min-w-0 items-center gap-3 px-3 pb-1 text-[13px] text-muted-foreground">
                <CircleUser className="size-4 shrink-0 text-subtle-foreground" strokeWidth={1.75} aria-hidden />
                <span className="min-w-0">
                  <span className="block text-[12px] text-subtle-foreground">Signed in as</span>
                  <span data-account-email className="block truncate font-medium text-foreground">
                    {email}
                  </span>
                </span>
              </p>
              <Button
                type="button"
                variant="ghost"
                data-sign-out
                onClick={signOut}
                className="h-auto min-h-[44px] w-full justify-start gap-3 px-3 py-2.5 text-[13px] text-muted-foreground"
              >
                <LogOut className="size-4 shrink-0 text-subtle-foreground" strokeWidth={1.75} aria-hidden />
                Sign out
              </Button>
            </div>
          </>
        ) : null}
      </SheetContent>

      <nav
        className="md:hidden fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background"
        style={{
          paddingBottom: "var(--safe-bottom)",
          height: "calc(var(--mobile-nav-h) + var(--safe-bottom))",
        }}
        data-mobile-nav
        aria-label="Primary"
      >
        {/* Five slots max: four primary tabs + More. Driven by MOBILE_PRIMARY_NAV
            so Settings cannot sneak back into the bar and crush labels. */}
        <div
          className="grid h-[var(--mobile-nav-h)]"
          style={{
            gridTemplateColumns: `repeat(${
              PRIMARY_TABS.length + (showMore ? 1 : 0)
            }, minmax(0, 1fr))`,
          }}
        >
          {PRIMARY_TABS.map(({ href, label, icon: Icon }) => {
            const active = href === activePrimaryHref;
            return (
              <Link
                key={href}
                to={href}
                aria-label={label}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative flex min-h-[44px] flex-col items-center justify-center gap-0.5 px-0.5 text-[12px] leading-tight font-medium transition-colors",
                  // The bar is fixed to the bottom edge and the tabs run
                  // edge-to-edge, so an outer ring is clipped by the viewport on
                  // every side. An inset ring is always fully visible.
                  "outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  active
                    ? "text-brand-foreground"
                    : "text-subtle-foreground",
                )}
              >
                <Icon
                  className={cn("h-5 w-5 shrink-0", active && "text-brand")}
                  strokeWidth={active ? 2.25 : 1.75}
                />
                {/* Badge rides the icon so the label keeps its full width. */}
                {href === NOTIFICATIONS_HREF && badge ? (
                  <Badge
                    variant="solid"
                    data-nav-unread
                    aria-label={`${badge} unread`}
                    className="absolute top-0.5 translate-x-3.5 ring-2 ring-background min-w-5 rounded-full px-1.5 text-[12px] font-semibold tabular-nums"
                  >
                    {badge}
                  </Badge>
                ) : null}
                {/* No truncate: five slots leave room for full short labels. */}
                <span className="max-w-full whitespace-nowrap px-0.5">{label}</span>
              </Link>
            );
          })}

          {showMore ? (
            <SheetTrigger asChild>
              <button
                type="button"
                data-mobile-more
                aria-label="More"
                className={cn(
                  "relative flex min-h-[44px] flex-col items-center justify-center gap-0.5 px-0.5 text-[12px] leading-tight font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  moreTabActive
                    ? "text-brand-foreground"
                    : "text-subtle-foreground",
                )}
              >
                <MoreHorizontal
                  className={cn(
                    "h-5 w-5 shrink-0",
                    moreTabActive && "text-brand",
                  )}
                  strokeWidth={moreTabActive ? 2.25 : 1.75}
                />
                {requestsBadge ? (
                  <Badge
                    variant="solid"
                    data-nav-more-pending
                    aria-label={`${requestsBadge} pending requests`}
                    className="absolute top-0.5 translate-x-3.5 ring-2 ring-background min-w-5 rounded-full px-1.5 text-[12px] font-semibold tabular-nums"
                  >
                    {requestsBadge}
                  </Badge>
                ) : null}
                <span className="whitespace-nowrap">More</span>
              </button>
            </SheetTrigger>
          ) : null}
        </div>
      </nav>
    </Sheet>
  );
}
