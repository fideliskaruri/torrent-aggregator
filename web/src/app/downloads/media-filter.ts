import {
  DEFAULT_LIBRARY_TAB,
  LIBRARY_TABS,
  LIBRARY_TAB_LABELS,
  type LibraryTab,
} from "@/app/watchlist/library-tabs";
import type { ClientTorrent, DownloadMediaKind } from "./types";

export type DownloadTab = LibraryTab;
export const DOWNLOAD_TABS = LIBRARY_TABS;
export const DOWNLOAD_TAB_LABELS = LIBRARY_TAB_LABELS;
export const DEFAULT_DOWNLOAD_TAB: DownloadTab = DEFAULT_LIBRARY_TAB;

export function filterDownloadsByTab<T extends { mediaKind: DownloadMediaKind | null }>(
  rows: readonly T[],
  tab: DownloadTab,
): T[] {
  if (tab === "all") return [...rows];
  const expected = tab === "movies" ? "movie" : tab === "series" ? "series" : "anime";
  return rows.filter((row) => row.mediaKind === expected);
}
