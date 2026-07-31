/**
 * What kinds of thing this app can find — the single vocabulary.
 *
 * ## The gap this closes
 *
 * Search was TMDB-only, and TMDB knows about films and television and nothing
 * else. So music, games, software and books were unreachable from the UI even
 * though every other layer already handled them: the indexers return them
 * (`/api/search?category=music` was answering with real releases the whole
 * time), `smart-category.ts` classifies them, and the download pipeline routes
 * them to Music/Games/Software/Books folders. One missing UI concept made a
 * working feature invisible.
 *
 * The owner's words: *"this is only configured to download films.. i want other
 * torrents too. or more like i can download them but it's not easy to search
 * for them."*
 *
 * ## Why films are modelled differently from everything else
 *
 * A film has a **work** that exists independently of any release: a canonical
 * title, a year, a poster, a synopsis, seasons and episodes. That is why films
 * and TV get poster cards leading to a title page, and why choosing a release
 * happens *after* choosing the work.
 *
 * An album, a game, a program or a book has no such layer here. There is no
 * metadata provider behind them, so the release **is** the artifact — its name
 * carries the edition, the format and the version, and there is nothing to show
 * on a "work page" that the release row does not already say. Inventing a
 * poster grid for albums would be decoration standing in for information.
 *
 * So `kind` is not cosmetic. It decides which of two genuinely different
 * flows a scope uses, and it is the reason this vocabulary exists as data
 * rather than as a `switch` repeated on every surface.
 */

/** Scope ids are URL-facing (`/everything?scope=music`) — keep them stable. */
export type SearchScopeId =
  | "titles"
  | "anime"
  | "music"
  | "games"
  | "software"
  | "books"
  | "everything";

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
export const SEARCH_SCOPES: readonly SearchScope[] = [
  {
    id: "titles",
    label: "Films & TV",
    blurb: "Films and series, with posters, seasons and episodes.",
    kind: "work",
    playable: true,
    category: null,
    downloadCategory: null,
    placeholder: "Dune, Severance, The Bear…",
  },
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
    blurb: "Subbed and dubbed series, films and OVAs.",
    kind: "release",
    // Anime is video: Play works, and it is how most people use these.
    playable: true,
    category: "anime",
    downloadCategory: "Anime",
    placeholder: "Frieren, Attack on Titan…",
  },
  {
    id: "everything",
    label: "All categories",
    blurb: "Every category at once, when you are not sure what it counts as.",
    kind: "release",
    // Mixed bag — a result could be a film or a keygen. Withholding Play is the
    // honest default; the row still offers Download, which always applies.
    playable: false,
    category: "all",
    downloadCategory: null,
    placeholder: "Anything at all…",
  },
] as const;

/** The scope search opens on. Films and TV are still the common case. */
export const DEFAULT_SCOPE_ID: SearchScopeId = "titles";

/** Scopes shown in the dedicated section — everything TMDB cannot describe. */
export const SECTION_SCOPES: readonly SearchScope[] = SEARCH_SCOPES.filter(
  (s) => s.kind === "release",
);

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
  const hit = SEARCH_SCOPES.find((s) => s.id === value.trim().toLowerCase());
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
