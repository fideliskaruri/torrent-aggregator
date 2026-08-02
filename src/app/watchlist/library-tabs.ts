/**
 * The Library's tabs: All, Movies, Series, Anime.
 *
 * Replaces a row of status chips (All / Watching / Completed / …). Status
 * answers "how far through am I", which is a property of one row and belongs
 * on the card that row draws. The tab bar answers "what kind of thing am I
 * looking for", which is the question people actually arrive with — you go to
 * the Library to find a film, or to find a show, not to find everything you
 * happen to have finished.
 *
 * Anime is its own tab rather than a subset of Series. It is a distinct
 * catalogue with its own naming, its own release conventions and its own
 * subbed/dubbed decision, and the rest of the app already treats it as a first
 * class media type.
 */
import { normalizeMediaType } from "@/lib/metadata/media-type";

export const LIBRARY_TABS = ["all", "movies", "series", "anime"] as const;
export type LibraryTab = (typeof LIBRARY_TABS)[number];

/** All is the default: an empty tab on arrival would look like an empty library. */
export const DEFAULT_LIBRARY_TAB: LibraryTab = "all";

export const LIBRARY_TAB_LABELS: Record<LibraryTab, string> = {
  all: "All",
  movies: "Movies",
  series: "Series",
  anime: "Anime",
};

/** The minimum a row needs for this module to place it. */
export interface LibraryRow {
  mediaType: string | null | undefined;
}

/**
 * Which tab a row belongs to, or null when nothing vouches for a type.
 *
 * An unknown type is deliberately *not* guessed into Movies. A row we cannot
 * classify still exists and still belongs to the user, so it stays visible
 * under All and simply claims no narrower home — the same rule the rest of the
 * app follows for unknown availability.
 */
export function tabForRow(row: LibraryRow): Exclude<LibraryTab, "all"> | null {
  switch (normalizeMediaType(row.mediaType)) {
    case "movie":
      return "movies";
    case "tv":
      return "series";
    case "anime":
      return "anime";
    default:
      return null;
  }
}

/** Does `row` belong under `tab`? */
export function rowInTab(row: LibraryRow, tab: LibraryTab): boolean {
  if (tab === "all") return true;
  return tabForRow(row) === tab;
}

export function filterByTab<T extends LibraryRow>(rows: readonly T[], tab: LibraryTab): T[] {
  return rows.filter((row) => rowInTab(row, tab));
}

/**
 * How many rows sit under each tab.
 *
 * `all` is the total, not the sum of the others: rows with an unknown media
 * type belong to no narrower tab, so the parts genuinely do not add up. That
 * is information, not an error - if `all` exceeds the sum, something in the
 * library has no type and is worth knowing about.
 */
export function tabCounts(rows: readonly LibraryRow[]): Record<LibraryTab, number> {
  const counts: Record<LibraryTab, number> = {
    all: rows.length,
    movies: 0,
    series: 0,
    anime: 0,
  };
  for (const row of rows) {
    const tab = tabForRow(row);
    if (tab) counts[tab] += 1;
  }
  return counts;
}

/**
 * Which tabs to render.
 *
 * Empty ones are hidden, so a library of films does not show three tabs that
 * lead nowhere. All is always present: it is the default and the way back.
 */
export function visibleTabs(rows: readonly LibraryRow[]): LibraryTab[] {
  const counts = tabCounts(rows);
  return LIBRARY_TABS.filter((tab) => tab === "all" || counts[tab] > 0);
}

/** Parse a tab from a URL or stored preference, falling back to the default. */
export function parseLibraryTab(raw: string | null | undefined): LibraryTab {
  const value = (raw ?? "").trim().toLowerCase();
  return (LIBRARY_TABS as readonly string[]).includes(value)
    ? (value as LibraryTab)
    : DEFAULT_LIBRARY_TAB;
}
