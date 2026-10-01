/**
 * Home's views: All, one type, or one type's genre. The URL is the state
 * (`/?type=films&genre=comedy`), so Back, reload and a shared link keep it.
 * The types are routes and live here; the genres are data and come from the
 * server's rail list with each payload.
 */
import type { BrowseType } from "./types";

export type BrowseView = "all" | BrowseType;

export const BROWSE_VIEWS: readonly { id: BrowseView; label: string }[] = [
  { id: "all", label: "All" },
  { id: "films", label: "Films" },
  { id: "series", label: "Series" },
  { id: "anime", label: "Anime" },
];

export interface BrowseQuery {
  view: BrowseView;
  /** A genre id of the view's type, or null. */
  genre: string | null;
}

/** An unknown type reads as All; a genre needs a type. */
export function parseBrowseQuery(params: URLSearchParams): BrowseQuery {
  const type = params.get("type")?.trim().toLowerCase() ?? "";
  const view = BROWSE_VIEWS.find((v) => v.id === type)?.id ?? "all";
  const genre = params.get("genre")?.trim().toLowerCase() || null;
  return { view, genre: view === "all" ? null : genre };
}

function search(view: BrowseView, genre: string | null): string {
  if (view === "all") return "";
  const params = new URLSearchParams({ type: view });
  if (genre) params.set("genre", genre);
  return `?${params.toString()}`;
}

export function browseHref(view: BrowseView, genre: string | null = null): string {
  return `/${search(view, genre)}`;
}

export function browseApiUrl({ view, genre }: BrowseQuery): string {
  return `/api/browse${search(view, genre)}`;
}

export function browseViewLabel(view: BrowseView): string {
  return BROWSE_VIEWS.find((v) => v.id === view)?.label ?? "All";
}
