/**
 * The navigation model — single source of truth.
 *
 * Header and mobile nav previously each declared their own list, and they had
 * already drifted (the header exposed Activity as a top-level peer while the
 * mobile primary tabs did not). Both now render from this module, and
 * `flow.test.ts` asserts the product rules against it.
 *
 * Product rules encoded here:
 *  - `/` is Browse: the catalog of what you can watch right now. It answers
 *    "here is what you can play", where the old search-box landing asked
 *    "what do you want?" and left a new install staring at an empty page.
 *  - Search is its own entry rather than the home page. It is still one click
 *    away everywhere: the header renders the Search entry as a compact search
 *    affordance (see {@link desktopNavRow}) and it holds a mobile tab.
 *  - Browse, Search, Library and Client are the primary path: see it, find it,
 *    monitor it, watch it download.
 *  - History is not a peer of the others. It is the download log, reached from
 *    Activity.
 *  - "Run automation" lives on Library only; duplicating it on Client or
 *    Settings gives the same action three homes and no clear owner.
 */

export type NavItem = {
  href: string;
  label: string;
  /**
   * Other routes this entry represents. `/rules` is reached from Settings and
   * `/history` from Activity, so those pages have no nav entry of their own —
   * without this the desktop header highlights nothing and the user loses
   * their place.
   */
  owns?: readonly string[];
};

/** The search surface. Exported so nothing has to hardcode the route. */
export const SEARCH_HREF = "/search";

/**
 * The one entry the desktop header renders as a search box instead of a link.
 *
 * Search deserves a permanent, always-visible affordance rather than a word in
 * a row of words — but it must still be a real nav entry so the mobile tab bar
 * and the active-route logic have exactly one model to read.
 */
export const HEADER_SEARCH_HREF = SEARCH_HREF;

/** Always visible on desktop, and the bottom tab bar on mobile. */
export const PRIMARY_NAV: readonly NavItem[] = [
  { href: "/", label: "Browse" },
  { href: SEARCH_HREF, label: "Search" },
  { href: "/watchlist", label: "Library" },
  { href: "/client", label: "Client" },
] as const;

/** Desktop: after the divider. Mobile: inside the More sheet. */
export const SECONDARY_NAV: readonly NavItem[] = [
  { href: "/activity", label: "Activity", owns: ["/history"] },
  { href: "/settings", label: "Settings", owns: ["/rules"] },
  { href: "/rules", label: "Rules (advanced)" },
  { href: "/about", label: "About" },
] as const;

/** Desktop header: the primary path, a divider, then the two busiest pages. */
export const DESKTOP_NAV: readonly NavItem[] = [
  ...PRIMARY_NAV,
  { href: "/activity", label: "Activity", owns: ["/history"] },
  { href: "/settings", label: "Settings", owns: ["/rules", "/about"] },
];

/** Index in DESKTOP_NAV where the primary path ends and secondary begins. */
export const DESKTOP_NAV_DIVIDER_INDEX = PRIMARY_NAV.length;

/**
 * The desktop header's text links, and where the divider sits among them.
 *
 * The Search entry is pulled out of the row because the header renders it as a
 * search box on the far right; removing it shifts every later index by one, so
 * the divider position is computed here rather than being a constant the
 * header has to correct by hand.
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
  "/history",
];

/**
 * History is deliberately absent from both lists: it is a filtered view of the
 * download log, linked from Activity.
 */
export const HISTORY_HREF = "/history";

export function navActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * True when `item` should be highlighted for `pathname`, including the routes
 * it stands in for.
 *
 * Prefer {@link navActiveHref} when rendering a list: `owns` claims can overlap
 * a real entry (Settings owns `/rules` for the desktop header, while the mobile
 * More sheet lists `/rules` itself), and only a list-wide decision can keep
 * exactly one row highlighted.
 */
export function navItemActive(pathname: string, item: NavItem): boolean {
  if (navActive(pathname, item.href)) return true;
  return (item.owns ?? []).some((href) => navActive(pathname, href));
}

/**
 * The single entry in `items` that represents `pathname`, or null.
 *
 * A direct href match always beats an `owns` claim, so a list containing both
 * `/rules` and a Settings entry that stands in for `/rules` highlights `/rules`
 * only. Among direct matches the longest href wins, so a nested route never
 * lights up its parent as well.
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
    if (navActive(pathname, item.href)) return item.label;
  }
  if (navActive(pathname, HISTORY_HREF)) return "Download log";
  return null;
}
