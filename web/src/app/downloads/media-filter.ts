/**
 * The Downloads page's media-type filter: All, Movies, Series, Anime.
 *
 * The page already had a *status* filter — Active / Downloading / Ready /
 * Paused — which answers "what is this transfer doing right now". It could not
 * answer "which of these is the show I came here for", and on a client holding
 * forty episodes and six films that is the question you actually arrive with.
 *
 * The classification itself is deliberately **not** re-decided here.
 * `src/app/watchlist/library-tabs.ts` already owns the All/Movies/Series/Anime
 * rules for the Library, including the one that matters — that a row nothing
 * vouches for is never guessed into a narrow tab — and two surfaces that each
 * decide for themselves what "Series" means will eventually disagree, which is
 * how a show ends up under Series in the Library and under Movies here. So the
 * tab list, the labels and the placement rule are imported, and this module
 * owns exactly the one thing the Library does not need: how to get a media
 * type out of a torrent, which carries a raw release name rather than a
 * catalogue field.
 */
import { workIdentityFor } from "@/components/title/work-key";
import {
  DEFAULT_LIBRARY_TAB,
  LIBRARY_TABS,
  LIBRARY_TAB_LABELS,
  rowInTab,
  tabForRow,
  type LibraryTab,
} from "@/app/watchlist/library-tabs";
import {
  isSeriesMediaType,
  normalizeMediaType,
  type MediaType,
} from "@/lib/metadata/media-type";

export type DownloadTab = LibraryTab;

/**
 * All four tabs, always, unlike the Library's `visibleTabs`, which hides the
 * ones holding nothing.
 *
 * The Library is a settled list; this page is a live one that re-renders every
 * five seconds. Hiding empty tabs there means a stable bar, but here it would
 * mean buttons appearing and disappearing under the cursor as the last anime
 * finishes seeding or a new film is sent — and the failure mode of a control
 * that moves while you are reaching for it is pressing the wrong one. The
 * placement *rules* are still shared; only this presentation choice differs.
 */
export const DOWNLOAD_TABS = LIBRARY_TABS;
export const DOWNLOAD_TAB_LABELS = LIBRARY_TAB_LABELS;
export const DEFAULT_DOWNLOAD_TAB: DownloadTab = DEFAULT_LIBRARY_TAB;

/**
 * The little a torrent states about itself.
 *
 * `category` is what this app recorded when it sent the release ("Movies",
 * "TV", "Anime"); it is absent for anything added straight to an external
 * client, and for streams the engine created on its own.
 */
export interface DownloadRow {
  name: string;
  category?: string | null;
}

/**
 * The media type of a download row, or null when nothing vouches for one.
 *
 * Two sources of evidence, strongest first:
 *
 *  1. **The stored category.** It is a decision this app already made from a
 *     categorised search rather than a guess read back off a filename, and it
 *     is the only thing that can separate anime from television:
 *     `[SubsPlease] Frieren - 28` and `Rick and Morty S09E02` are structurally
 *     identical, so no rule reading the name alone can tell them apart.
 *  2. **Season/episode structure in the release name.** `workIdentityFor` is
 *     the same funnel the title page, the browse rails and search grouping
 *     already use to decide whether a release belongs to a series, so an
 *     uncategorised row lands in the same place here as it does everywhere
 *     else in the app.
 *
 * A name carrying *no* episode structure deliberately proves nothing and
 * returns null. Reading "no season marker" as "therefore a film" is precisely
 * the quietly-filed-under-Movies failure `library-tabs.ts` exists to prevent,
 * and this page is not restricted to media: a torrent someone sideloaded — an
 * ISO, a game, a font pack — has no season marker either, and filing it under
 * Movies would hide it in a tab nobody would think to look in. Under All,
 * where every row lives regardless, it is still there.
 */
export function downloadMediaType(row: DownloadRow): MediaType | null {
  const stated = normalizeMediaType(row.category);
  if (stated) return stated;
  return workIdentityFor(row.name ?? "").isSeries ? "tv" : null;
}

/**
 * Does this row have seasons and episodes?
 *
 * The grouping module asks this to decide what becomes a combined row, and the
 * tab bar asks it (via `tabForDownload`) to decide what Series holds. One
 * answer for both, so a row can never be grouped as a series while sitting
 * under the Movies tab.
 */
export function isSeriesDownload(row: DownloadRow): boolean {
  return isSeriesMediaType(downloadMediaType(row));
}

/** Which narrow tab this row belongs to, or null when nothing vouches for one. */
export function tabForDownload(
  row: DownloadRow,
): Exclude<DownloadTab, "all"> | null {
  return tabForRow({ mediaType: downloadMediaType(row) });
}

/** Does `row` belong under `tab`? All holds everything, including the unknown. */
export function downloadInTab(row: DownloadRow, tab: DownloadTab): boolean {
  return rowInTab({ mediaType: downloadMediaType(row) }, tab);
}

export function filterDownloadsByTab<T extends DownloadRow>(
  rows: readonly T[],
  tab: DownloadTab,
): T[] {
  return rows.filter((row) => downloadInTab(row, tab));
}
