/**
 * The navigation model — single source of truth.
 *
 * Header and mobile nav previously each declared their own list, and they had
 * already drifted (the header exposed Activity as a top-level peer while the
 * mobile primary tabs did not). Both render from this module, and
 * `flow.test.ts` asserts the product rules against it.
 *
 * Product rules encoded here:
 *  - `/` is Browse: the catalog of what you can watch right now. It answers
 *    "here is what you can play", where the old search-box landing asked
 *    "what do you want?" and left a new install staring at an empty page.
 *  - Desktop keeps five primary destinations: Browse, Library, Downloads,
 *    Notifications, Settings. Mobile's bottom bar is five *slots*: Browse,
 *    Library, Downloads, Alerts, More — Settings lives in the More sheet so
 *    labels fit a 390px phone without ellipsis.
 *  - Search is global rather than a destination. It is not a place you go and
 *    come back from; it is something you do from wherever you are. The desktop
 *    header draws it as a permanent box, and mobile opens it full-screen.
 *  - History is not a peer. It is the download log, reached from Notifications.
 *  - "Run automation" lives on Library only; duplicating it on Downloads or
 *    Settings gives the same action three homes and no clear owner.
 *
 * Two renames are deliberate and are not cosmetic:
 *
 *  - **Client → Downloads.** "Client" named the subsystem, not the thing the
 *    user came for. Nobody opens a media app to look at a torrent client; they
 *    open it to see whether their download finished.
 *  - **Activity → Notifications.** Activity was a wall of everything that had
 *    happened. Notifications is a quiet inbox: completed downloads and
 *    terminal failures, with an unread count. The name change is the promise.
 *    Mobile shortens the tab label to **Alerts** so five slots stay readable.
 *
 * Rules is deliberately absent from every list. Its replacement — the
 * per-title Add to Library flow — does not exist yet, so `/rules` remains
 * reachable by URL rather than being deleted out from under anyone still
 * relying on it. It is simply no longer advertised.
 */

export type NavItem = {
  href: string;
  label: string;
  /**
   * Other routes this entry represents. `/history` is reached from
   * Notifications, and the old `/activity` and `/client` paths still resolve
   * for bookmarks, so those pages have no nav entry of their own — without
   * this the desktop header highlights nothing and the user loses their place.
   */
  owns?: readonly string[];
};

/** The search surface. Exported so nothing has to hardcode the route. */
export const SEARCH_HREF = "/search";

/**
 * The one entry the desktop header renders as a search box instead of a link.
 *
 * Search deserves a permanent, always-visible affordance rather than a word in
 * a row of words. It is not a member of {@link PRIMARY_NAV}: the bottom bar
 * holds destinations, and searching is not somewhere you are.
 */
export const HEADER_SEARCH_HREF = SEARCH_HREF;

/**
 * Kept for old bookmarks and presentation maps. It is not a navigation entry.
 */
export const EVERYTHING_HREF = "/everything";

/** Where live and finished transfers are shown. Formerly `/client`. */
export const DOWNLOADS_HREF = "/downloads";

/** The quiet inbox. Formerly `/activity`. */
export const NOTIFICATIONS_HREF = "/notifications";

/**
 * Desktop primary destinations (and the product spine).
 *
 * Exactly five. Adding a sixth is a product decision, not a layout tweak.
 * Mobile does **not** mirror this list 1:1 — see {@link MOBILE_PRIMARY_NAV}.
 */
export const PRIMARY_NAV: readonly NavItem[] = [
  { href: "/", label: "Browse" },
  { href: "/watchlist", label: "Library" },
  { href: DOWNLOADS_HREF, label: "Downloads", owns: ["/client"] },
  { href: NOTIFICATIONS_HREF, label: "Notifications", owns: ["/activity", "/history"] },
  { href: "/settings", label: "Settings", owns: ["/about"] },
] as const;

/**
 * Mobile bottom-tab destinations (More is rendered separately).
 *
 * Four tabs + More = five slots. "Alerts" is the short label for Notifications
 * so the word never ellipsizes at 390px. Settings is not a tab — it lives in
 * {@link MOBILE_MORE_NAV}. History still lights the Alerts tab via `owns`.
 */
export const MOBILE_PRIMARY_NAV: readonly NavItem[] = [
  { href: "/", label: "Browse" },
  { href: "/watchlist", label: "Library" },
  { href: DOWNLOADS_HREF, label: "Downloads", owns: ["/client"] },
  { href: NOTIFICATIONS_HREF, label: "Alerts", owns: ["/activity", "/history"] },
] as const;

/** The owner's inbox of friends' requests. Its entry carries the pending count. */
export const REQUESTS_HREF = "/requests";
export const UPCOMING_HREF = "/upcoming";
export const SETTINGS_HREF = "/settings";

/**
 * Desktop: after the divider. Mobile More base (Upcoming + Requests).
 *
 * Settings is appended for mobile only via {@link MOBILE_MORE_NAV} so desktop
 * keeps Settings in the primary row.
 */
export const SECONDARY_NAV: readonly NavItem[] = [
  { href: UPCOMING_HREF, label: "Upcoming" },
  { href: REQUESTS_HREF, label: "Requests" },
] as const;

/**
 * Mobile More sheet: secondary destinations plus Settings (and About is
 * reached from Settings; More lights for `/about` via {@link MORE_ACTIVE_PREFIXES}).
 */
export const MOBILE_MORE_NAV: readonly NavItem[] = [
  ...SECONDARY_NAV,
  { href: SETTINGS_HREF, label: "Settings", owns: ["/about"] },
] as const;

/** Desktop header: the primary path. */
export const DESKTOP_NAV: readonly NavItem[] = [
  ...PRIMARY_NAV.flatMap((item) =>
    item.href === DOWNLOADS_HREF
      ? [item, { href: UPCOMING_HREF, label: "Upcoming" }]
      : [item],
  ),
  ...SECONDARY_NAV.filter((item) => item.href !== UPCOMING_HREF),
];

/**
 * The desktop header's text links, and where the divider sits among them.
 *
 * Search is not in `DESKTOP_NAV`, so the row is the nav as-is. The function is
 * kept because the header calls it and because the divider position must stay
 * computed rather than hardcoded — a constant here was previously corrected by
 * hand in the header every time the model changed.
 */
export function desktopNavRow(): {
  items: readonly NavItem[];
  dividerIndex: number;
} {
  const items = DESKTOP_NAV.filter((item) => item.href !== HEADER_SEARCH_HREF);
  const primaryHrefs = new Set(
    PRIMARY_NAV.filter((item) => item.href !== HEADER_SEARCH_HREF).map(
      (item) => item.href,
    ),
  );
  primaryHrefs.add(UPCOMING_HREF);
  const dividerIndex = items.findIndex((item) => !primaryHrefs.has(item.href));
  return { items, dividerIndex: dividerIndex === -1 ? items.length : dividerIndex };
}

/** Routes that light the mobile More tab when the sheet is closed. */
export const MORE_ACTIVE_PREFIXES: readonly string[] = [
  ...MOBILE_MORE_NAV.map((item) => item.href),
  "/about",
];

/**
 * History is deliberately absent from both lists: it is a filtered view of the
 * download log, linked from Notifications.
 */
const HISTORY_HREF = "/history";

export function navActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * True when `item` should be highlighted for `pathname`, including the routes
 * it stands in for.
 *
 * Prefer {@link navActiveHref} when rendering a list: `owns` claims can overlap
 * a real entry, and only a list-wide decision can keep exactly one row
 * highlighted.
 */
function navItemActive(pathname: string, item: NavItem): boolean {
  if (navActive(pathname, item.href)) return true;
  return (item.owns ?? []).some((href) => navActive(pathname, href));
}

/**
 * The single entry in `items` that represents `pathname`, or null.
 *
 * A direct href match always beats an `owns` claim. Among direct matches the
 * longest href wins, so a nested route never lights up its parent as well.
 */
export function navActiveHref(
  items: readonly NavItem[],
  pathname: string,
): string | null {
  let direct: NavItem | null = null;
  for (const item of items) {
    if (!navActive(pathname, item.href)) continue;
    if (!direct || item.href.length > direct.href.length) direct = item;
  }
  if (direct) return direct.href;

  for (const item of items) {
    if ((item.owns ?? []).some((href) => navActive(pathname, href))) {
      return item.href;
    }
  }
  return null;
}

/**
 * Header / wayfinding title for the current path.
 *
 * Derived purely from the route (not from which nav item "owns" it). Nav `owns`
 * is for highlighting tabs; the chrome title must name the actual page — e.g.
 * `/about` is "About", not "Settings"; `/history` is "Download log".
 *
 * Title/media hero pages intentionally return null so the header stays quiet.
 * Keep in sync with every leaf in `router.tsx`.
 */
export function titleForRoute(pathname: string): string | null {
  if (pathname === "/") return "Browse";
  if (navActive(pathname, "/title")) return null;
  if (navActive(pathname, HISTORY_HREF)) return "Download log";
  if (navActive(pathname, "/about")) return "About";
  if (navActive(pathname, "/share")) return "Share";
  if (navActive(pathname, "/rules")) return "Rules";
  if (navActive(pathname, SEARCH_HREF)) return "Search";
  if (navActive(pathname, EVERYTHING_HREF)) return "Search";
  if (navActive(pathname, "/client")) return "Downloads";
  if (navActive(pathname, DOWNLOADS_HREF)) return "Downloads";
  if (navActive(pathname, "/activity")) return "Notifications";
  if (navActive(pathname, NOTIFICATIONS_HREF)) return "Notifications";
  if (navActive(pathname, "/watchlist")) return "Library";
  if (navActive(pathname, UPCOMING_HREF)) return "Upcoming";
  if (navActive(pathname, REQUESTS_HREF)) return "Requests";
  if (navActive(pathname, SETTINGS_HREF)) return "Settings";
  return null;
}

/** @deprecated Prefer {@link titleForRoute} — kept as the prior public name. */
export function activeNavLabel(pathname: string): string | null {
  return titleForRoute(pathname);
}
