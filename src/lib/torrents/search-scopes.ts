import type { WorkSearchCategory } from "@/lib/search/work-search";

/** Legacy `/everything` ids remain parseable only for bookmark redirects. */
export type LegacySectionScopeId =
  | "anime"
  | "music"
  | "games"
  | "software"
  | "books"
  | "everything";
export type SearchScopeId = WorkSearchCategory | LegacySectionScopeId;

/**
 * How a scope's results are chosen.
 *
 *  - `work` — TMDB-backed. Poster cards → title page → release chosen for you.
 *  - `release` — the release is the artifact. Rows, chosen directly.
 */
export type SearchScopeKind = "work" | "release";

/** The category vocabulary the aggregator and its adapters speak. */
export type AggregatorCategory =
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

export const DEFAULT_SCOPE_ID: WorkSearchCategory = "movies";

/**
 * Compatibility vocabulary for old `/everything` bookmarks.
 *
 * It is deliberately separate from `SEARCH_SCOPES`: these categories belong
 * to the internal aggregator, not to title discovery.
 */
export const SECTION_SCOPES = [
  {
    id: "music",
    label: "Music",
    blurb: "Albums, discographies and singles.",
    kind: "release",
    playable: false,
    category: "music",
    downloadCategory: "Music",
    placeholder: "Daft Punk Discovery, Radiohead FLAC…",
  },
  {
    id: "games",
    label: "Games",
    blurb: "PC and console games, including repacks.",
    kind: "release",
    playable: false,
    category: "games",
    downloadCategory: "Games",
    placeholder: "Stardew Valley, Elden Ring…",
  },
  {
    id: "software",
    label: "Software",
    blurb: "Applications and tools.",
    kind: "release",
    playable: false,
    category: "apps",
    downloadCategory: "Software",
    placeholder: "Blender, Photoshop, Office…",
  },
  {
    id: "books",
    label: "Books",
    blurb: "Ebooks, audiobooks and comics.",
    kind: "release",
    playable: false,
    category: "books",
    downloadCategory: "Books",
    placeholder: "Mistborn epub, Atomic Habits…",
  },
  {
    id: "anime",
    label: "Anime",
    blurb: "Anime release compatibility scope.",
    kind: "release",
    playable: true,
    category: "anime",
    downloadCategory: "Anime",
    placeholder: "Frieren, Attack on Titan…",
  },
  {
    id: "everything",
    label: "All categories",
    blurb: "Every aggregator category.",
    kind: "release",
    playable: false,
    category: "all",
    downloadCategory: null,
    placeholder: "Anything at all…",
  },
] as const satisfies readonly SearchScope[];

export function getScope(id: string | null | undefined): SearchScope {
  return (
    SEARCH_SCOPES.find((s) => s.id === id) ??
    SEARCH_SCOPES.find((s) => s.id === DEFAULT_SCOPE_ID)!
  );
}

/**
 * Narrow an untrusted scope id, or null.
 *
 * Separate from {@link getScope} because a URL that names a scope we do not
 * have should be *noticed* by a caller that cares, not silently answered with
 * films — a `?scope=podcasts` link quietly returning film results is a worse
 * outcome than an honest fallback the page can mention.
 */
export function parseScopeId(value: unknown): SearchScopeId | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  const hit = [...SEARCH_SCOPES, ...SECTION_SCOPES].find(
    (s) => s.id === normalized,
  );
  return hit ? hit.id : null;
}

/** Every category the aggregator accepts. Used to validate the API route. */
export const AGGREGATOR_CATEGORIES: readonly AggregatorCategory[] = [
  "all",
  "anime",
  "movies",
  "tv",
  "music",
  "apps",
  "games",
  "books",
] as const;

export function parseAggregatorCategory(
  value: unknown,
): AggregatorCategory | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return (AGGREGATOR_CATEGORIES as readonly string[]).includes(v)
    ? (v as AggregatorCategory)
    : null;
}
