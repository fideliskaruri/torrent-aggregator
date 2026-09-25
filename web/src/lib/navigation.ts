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
 *  - Five destinations, and no sixth: Browse, Library, Downloads,
 *    Notifications, Settings. Mobile's bottom bar mirrors them exactly.
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
 * Always visible on desktop, and the bottom tab bar on mobile.
 *
 * Exactly five. Adding a sixth is a product decision, not a layout tweak: the
 * bar is thumb-width on a 375px phone and a sixth entry makes every target
 * narrower than the 44px minimum.
 */
export const PRIMARY_NAV: readonly NavItem[] = [
  { href: "/", label: "Browse" },
  { href: "/watchlist", label: "Library" },
  { href: DOWNLOADS_HREF, label: "Downloads", owns: ["/client"] },
  { href: NOTIFICATIONS_HREF, label: "Notifications", owns: ["/activity", "/history"] },
  { href: "/settings", label: "Settings", owns: ["/about"] },
] as const;

/**
 * Desktop: after the divider. Mobile: inside the More sheet.
 *
 * Empty by design. Every destination earned a place in the primary five, so
 * there is nothing left to demote — and an empty More sheet is a signal that
 * the model is honest, not that a section is missing.
 */
export const SECONDARY_NAV: readonly NavItem[] = [] as const;

/** Desktop header: the primary path. */
export const DESKTOP_NAV: readonly NavItem[] = [...PRIMARY_NAV];

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
  const dividerIndex = items.findIndex((item) => !primaryHrefs.has(item.href));
  return { items, dividerIndex: dividerIndex === -1 ? items.length : dividerIndex };
}

/** Routes that light the mobile More tab when the sheet is closed. */
export const MORE_ACTIVE_PREFIXES: readonly string[] = [
  ...SECONDARY_NAV.map((item) => item.href),
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

/** The label of the entry representing `pathname`, for the mobile title bar. */
export function activeNavLabel(pathname: string): string | null {
  for (const item of [...PRIMARY_NAV, ...SECONDARY_NAV]) {
    if (navItemActive(pathname, item)) return item.label;
  }
  if (navActive(pathname, SEARCH_HREF)) return "Search";
  if (navActive(pathname, HISTORY_HREF)) return "Download log";
  return null;
}
