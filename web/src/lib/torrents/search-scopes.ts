import type { WorkSearchScope } from "@/lib/search/work-search";

/** Legacy `/everything` ids remain parseable only for bookmark redirects. */
type LegacySectionScopeId =
  | "anime"
  | "music"
  | "games"
  | "software"
  | "books"
  | "everything";
type SearchScopeId = WorkSearchScope | LegacySectionScopeId;

/**
 * How a scope's results are chosen.
 *
 *  - `work` — TMDB-backed. Poster cards → title page → release chosen for you.
 *  - `release` — the release is the artifact. Rows, chosen directly.
 */
type SearchScopeKind = "work" | "release";

/** The category vocabulary the aggregator and its adapters speak. */
type AggregatorCategory =
  | "all"
  | "anime"
  | "movies"
  | "tv"
  | "music"
  | "apps"
  | "games"
  | "books";

export interface SearchScope {
  id: SearchScopeId;
  /** Nav/chip label. A noun for the thing, not a genre adjective. */
  label: string;
  /** One line saying what belongs here, for the section header and a11y. */
  blurb: string;
  kind: SearchScopeKind;
  /**
   * Whether Play is a real action for these results.
   *
   * Only video streams. Offering Play on a program or a game would be a control
   * that cannot work; offering it on an album is nearly as bad, because an album
   * is a *folder of tracks* and the player addresses a single file — it would
   * open on one arbitrary track or fail outright. A button that looks live and
   * does nothing is the exact defect class this app has been clearing out, so
   * these rows show Download only unless the artifact genuinely plays.
   */
  playable: boolean;
  /** Category sent to `/api/search`. Null for the TMDB-backed scope. */
  category: AggregatorCategory | null;
  /**
   * Download folder these land in, from `DEFAULT_CATEGORIES`.
   *
   * Stated here so the UI can promise where a file will go *before* the
   * download starts. The server still decides for itself (`smart-category.ts`)
   * — this must never be the only thing routing a file, only what we tell the
   * owner to expect.
   */
  downloadCategory: string | null;
  /** A real example the owner might type, not "Search…". */
  placeholder: string;
}

/**
 * Ordered as the chips render: the default first, then most-asked-for.
 *
 * `everything` is last deliberately. It is the honest fallback for "I don't
 * know what this counts as", not the default — an unscoped search mixes an
 * audiobook, a documentary and a repack in one list, which is precisely the
 * mess the scopes exist to avoid.
 */
/** Normal Search is work discovery only. Raw release scopes are not UI tabs. */
export const SEARCH_SCOPES = [
  {
    id: "all",
    label: "All",
    blurb: "Search films, series and anime together — best matches first.",
    kind: "work",
    playable: false,
    category: null,
    downloadCategory: null,
    placeholder: "Dune, Severance, Frieren…",
  },
  {
    id: "movies",
    label: "Movies",
    blurb: "Find a movie by title.",
    kind: "work",
    playable: false,
    category: null,
    downloadCategory: null,
    placeholder: "Dune, Arrival, Moonlight…",
  },
  {
    id: "series",
    label: "Series",
    blurb: "Find a series by title.",
    kind: "work",
    playable: false,
    category: null,
    downloadCategory: null,
    placeholder: "Severance, The Bear, Shōgun…",
  },
  {
    id: "anime",
    label: "Anime",
    blurb: "Find an anime title, film, OVA or ONA.",
    kind: "work",
    playable: false,
    category: null,
    downloadCategory: null,
    placeholder: "Frieren, Slime, Cowboy Bebop…",
  },
] as const satisfies readonly SearchScope[];

export const DEFAULT_SCOPE_ID: WorkSearchScope = "all";

export function getScope(id: string | null | undefined): SearchScope {
  return (
    SEARCH_SCOPES.find((s) => s.id === id) ??
    SEARCH_SCOPES.find((s) => s.id === DEFAULT_SCOPE_ID)!
  );
}
