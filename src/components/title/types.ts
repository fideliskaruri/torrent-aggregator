/**
 * The title-page contract — everything `/title/[workKey]` renders, in one
 * round trip.
 *
 * Shaped by one rule: **the page must render instantly from what is already
 * known.** Every field below is answerable from the local database — engine
 * rows, playback progress, library rows, cached catalog metadata — so the
 * server never waits on an indexer to draw a page. Anything that needs the
 * network is an *action* the user takes (see `POST /api/title/[workKey]`), not
 * a precondition for the page appearing.
 *
 * The availability contract is the one from `@/lib/browse`: `null` means *not
 * yet determined* and must render as a neutral, clickable affordance;
 * `unavailable` is a claim, and is only ever set where a real check was made.
 */
import type { AvailabilityState } from "@/lib/browse";
import type { StorageOverrideFacts } from "@/lib/library/storage-override";
import type { SeasonGrabReport } from "./season-grab-state";

/** One row in the episode list. */
export interface TitleEpisode {
  season: number;
  episode: number;
  /** `S02E05`, ready to print. */
  label: string;
  /**
   * Local state only: `ready` / `warm` when a file exists, otherwise `null`.
   *
   * Never `unavailable`. Deciding that for a single episode needs its own
   * indexer search, and the shared search cache is keyed on the *show* title
   * (episode tokens are normalised away), so one stale row for S05E14 would
   * otherwise mark every other episode of the season as checked-and-missing.
   * A claim nobody made is the one thing this contract forbids.
   */
  availability: AvailabilityState | null;
  infoHash: string | null;
  /** File inside the torrent, when a progress row named one. */
  filePath: string | null;
  /** 0–1 download progress when the torrent is partially fetched. */
  downloadFraction: number | null;
  /** 0–1 of the episode watched. */
  watchedFraction: number | null;
  resumePositionSec: number | null;
  watched: boolean;
  /** The episode the library hunt is waiting for, if this show is monitored. */
  nextUp: boolean;
  /** Satisfied by an exact file inside a legacy pack already held locally. */
  fromPack: boolean;
  /** Exact user acquisition state. Never inferred from a covering pack. */
  transfer: TitleEpisodeTransfer | null;
}

export interface TitleEpisodeTransfer {
  status: "queued" | "downloading" | "downloaded" | "failed";
  progress: number;
  infoHash: string | null;
  filePath: string | null;
  error: string | null;
}

/** Lightweight transfer state used while the title page polls active grabs. */
export interface TitleProgressPayload {
  workKey: string;
  transfer: TitleEpisodeTransfer | null;
  seasonTransfers: Record<string, TitleEpisodeTransfer | null>;
  episodeTransfers: Record<string, TitleEpisodeTransfer | null>;
  generatedAt: string;
}

/** A season, and the whole-season pack we hold for it if there is one. */
export interface TitleSeason {
  season: number;
  /** How many episodes we know about. Zero when only a pack is held. */
  knownEpisodes: number;
  pack: {
    name: string;
    availability: AvailabilityState;
    infoHash: string;
    downloadFraction: number | null;
  } | null;
  /**
   * Exact user acquisition state for a season-scoped grab.
   *
   * Stays at season scope. An episode row must not render this as its own
   * progress: a pack being 60% fetched says nothing about which episodes are
   * complete, and the episode contract forbids claims nobody made.
   */
  transfer: TitleEpisodeTransfer | null;
}

/** Where this work stands in the user's library. */
export interface TitleLibraryState {
  inLibrary: boolean;
  watchListItemId: string | null;
  monitored: boolean;
  status: string | null;
  cursorSeason: number | null;
  cursorEpisode: number | null;
  /**
   * Exactly what `POST /api/watchlist` needs to add this work, prepared
   * server-side so the client never has to invent a catalog id. `externalId`
   * reuses the real catalog id when a cached metadata row agrees with this
   * work, and falls back to `work:<workKey>` — stable, and namespaced so it
   * can never collide with a TMDB or AniList id.
   */
  addPayload: {
    mediaType: string;
    externalId: string;
    title: string;
    posterUrl: string | null;
    synopsis: string | null;
    rating: number | null;
  };
}

/** Where playback got to, when there is somewhere to resume. */
export interface TitleResume {
  infoHash: string;
  filePath: string | null;
  positionSec: number;
  durationSec: number | null;
  fraction: number | null;
  season: number | null;
  episode: number | null;
  label: string | null;
}

/** The complete payload for one title page. */
export interface TitleDetailPayload {
  workKey: string;
  title: string;
  /**
   * Alternate provider names for this work — AniList romaji/native and other
   * verified aliases. Threaded into the episode grab ladder so anime is
   * acquirable under the name indexers actually carry, not just its English
   * label (BUG-010). Empty when the provider offers none.
   */
  aliases: string[];
  year: number | null;
  /** Canonical media type, or null when nothing vouches for one. */
  mediaType: string | null;
  /** Does this work have seasons and episodes? */
  isSeries: boolean;
  overview: string | null;
  rating: number | null;
  posterUrl: string | null;
  backdropUrl: string | null;
  /**
   * Primary release / first-air date as an ISO string, or null when unknown.
   * A date strictly in the future gates the page visually (grayed, "Coming
   * {date}", disabled actions). Unknown dates are never gated.
   */
  releaseDate: string | null;

  /**
   * Title-level availability.
   *
   * Local state always; `fetchable` / `unavailable` only when a cached search
   * for this exact title exists to justify the claim. `null` otherwise.
   */
  availability: AvailabilityState | null;
  infoHash: string | null;
  /** 0–1 download progress when the title-level torrent is partial. */
  downloadFraction: number | null;

  resume: TitleResume | null;

  /**
   * The user's acquisition state for the *work itself* — a film they sent, or
   * a whole-series grab. Never a summary of its parts.
   *
   * Separate from {@link TitleSeason.transfer} and {@link TitleEpisode.transfer}
   * because the three answer different questions and only the control that owns
   * a scope may read it. Merging them is how a season pack at 40% ends up
   * claiming episode 3 is 40% watched-ready, and how a title with one queued
   * episode starts describing itself as queued.
   */
  transfer: TitleEpisodeTransfer | null;

  /** Every season we know of, ascending. Empty for a film. */
  seasons: TitleSeason[];
  /** The season `episodes` belongs to, or null. */
  season: number | null;
  episodes: TitleEpisode[];
  /** True when the episode list was capped rather than exhausted. */
  episodesTruncated: boolean;

  library: TitleLibraryState;

  /**
   * Did anything in the database actually know this work, or is the page
   * running on nothing but the URL? Drives honest copy, not a disabled state.
   */
  known: boolean;

  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Extras — the second round trip
// ---------------------------------------------------------------------------

/**
 * What an episode *is*, as opposed to whether we hold it.
 *
 * Split from `TitleEpisode` because the two have different costs and different
 * failure modes. Availability is local and instant; a name and a synopsis come
 * from TMDB and may never arrive. Merging them client-side means a slow or
 * missing metadata provider degrades a row from "Nightmares" back to "S02E01"
 * instead of holding the whole page on a spinner.
 */
export interface TitleEpisodeMeta {
  episode: number;
  name: string | null;
  overview: string | null;
  /** `YYYY-MM-DD`, or null. A future date means the episode has not aired. */
  airDate: string | null;
  runtimeMin: number | null;
  stillUrl: string | null;
}

export function episodeTitleMap(
  season: number,
  episodes: readonly TitleEpisodeMeta[],
): Readonly<Record<string, string>> {
  const titles: Record<string, string> = {};
  for (const episode of episodes) {
    if (!episode.name) continue;
    const key = `S${String(season).padStart(2, "0")}E${String(episode.episode).padStart(2, "0")}`;
    titles[key] = episode.name;
  }
  return titles;
}

/** One neighbour of this work, for the rail under the hero. */
export interface TitleSimilar {
  workKey: string;
  /** Ready-made `/title/...` link, with the identity hints already attached. */
  href: string;
  title: string;
  year: number | null;
  mediaType: string;
  posterUrl: string | null;
  rating: number | null;
}

/**
 * The answer from `GET /api/title/[workKey]/extras`.
 *
 * Every field is optional in spirit: an empty payload is a valid answer and
 * the page must render correctly without any of it.
 */
export interface TitleExtrasPayload {
  workKey: string;
  /** The season `episodes` describes, or null when this is not a series. */
  season: number | null;
  /** Real season count from the metadata provider. Null means *unknown*. */
  seasonCount: number | null;
  /** Every season number the provider knows about, ascending. */
  seasons: number[];
  episodes: TitleEpisodeMeta[];
  moreLikeThis: TitleSimilar[];
  /**
   * Synopsis and score from the resolved provider entity. A fallback for the
   * base payload, which carries these only from local data it can vouch for and
   * so leaves them null when the one cached row was a different work.
   */
  overview: string | null;
  rating: number | null;
  /**
   * Primary release / first-air date from the resolved provider entity. The
   * base payload carries one only for works already in the local catalog, so
   * this is what gates a future title opened straight from search.
   */
  releaseDate: string | null;
  /**
   * True when this is a movie that has had a theatrical/premiere release but
   * no past Digital (4), Physical (5) or TV (6) home release.
   *
   * Only set to true when the TMDB release_dates endpoint actually responded
   * AND the film's primary release date is in the past. The default (false)
   * means "unknown or not applicable" — the UI must never gate on this flag
   * unless the server explicitly set it.
   *
   * Series are never in a theatrical window; this is always false for them.
   */
  inTheatricalWindow: boolean;
  /**
   * The earliest upcoming home release date (YYYY-MM-DD) when the film is in
   * its theatrical window, or null when none is known. When present, the chip
   * reads "Digital Aug 2026" rather than the generic "In cinemas".
   */
  nextHomeReleaseAt: string | null;
  /**
   * Genre names from the resolved provider entity, e.g.
   * `["Sci-Fi & Fantasy", "Drama"]`. Empty array when unknown — the hero simply
   * omits the genre line rather than showing a placeholder.
   */
  genres: string[];
  /**
   * TMDB vote count backing {@link rating}. Null when unknown or zero — a score
   * with no votes behind it is not a rating worth a count.
   */
  voteCount: number | null;
  /**
   * Which provider supplied {@link rating}.
   *
   * The hero badge prints this verbatim, so it must never be guessed. Without a
   * TMDB key the score can come from AniList, TVmaze or iTunes instead, and
   * labelling an AniList score "TMDB" is exactly the kind of confident-but-wrong
   * attribution this codebase refuses elsewhere. Absent means the TMDB path,
   * which is the only source that existed when this field was introduced.
   */
  ratingSource?: "tmdb" | "anilist" | "tvmaze" | "itunes" | null;
  /**
   * Content certification for the US audience, e.g. `"TV-MA"` (series) or
   * `"PG-13"` (film). Falls back to the first available region when TMDB has no
   * US entry. Null when unknown.
   */
  certification: string | null;
  /**
   * TMDB `original_language` as an **uppercased ISO-639-1 code** ready for
   * display, e.g. `"EN"`, `"JA"`. Uppercased here (not raw) so the hero prints
   * it as a badge without further transformation. Null when unknown.
   */
  originalLanguage: string | null;
  /** False when there was no usable provider match — drives nothing but copy. */
  resolved: boolean;
  generatedAt: string;
}

export type TitleRetention = "stream" | "keep";

/** Body accepted by `POST /api/title/[workKey]` — the one-click grab. */
export interface TitleGrabRequest {
  /** Explicit intent boundary; coordinates must match the selected scope. */
  scope?: "title" | "season" | "episode";
  /** Omit both for a film (or a whole-title grab). */
  season?: number | null;
  episode?: number | null;
  /** Known episode numbers for a one-press season grab. */
  episodes?: number[] | null;
  /** Never accepted for scoped acquisition. Retained for strict rejection. */
  infoHash?: string | null;
  /** Stream-only cache or permanent keep, matching `/api/torrent/send`. */
  retention?: TitleRetention;
  /**
   * Preferred resolution in pixels (480 / 720 / 1080 / 2160).
   * Only sent when the user has chosen a quality via the Download picker.
   * Play never sends this — it is instant and never prompts.
   */
  preferredResolution?: number | null;
  /** Passed through when the page was reached with only a title in the URL. */
  title?: string | null;
  mediaType?: string | null;
  year?: number | null;
  /** Provider identity hints re-verified by the server before acquisition. */
  provider?: string | null;
  providerId?: string | null;
  sourceType?: string | null;
  format?: string | null;
  /**
   * The owner saw the real figures and chose to exceed their own storage cap.
   * Only the cap can be overridden this way — the free-space floor cannot.
   */
  overrideStorageCap?: boolean;
  /**
   * Whether the season has finished airing.  The server uses this to decide
   * whether to allow a pack grab.  The client computes this from TMDB episode
   * air dates; absence defaults to `true` (completed) on the server so existing
   * integrations are unaffected.
   */
  seasonComplete?: boolean;
}

/** What `POST /api/title/[workKey]` answers. */
export interface TitleGrabResponse {
  ok: boolean;
  message: string;
  /** The release that was actually sent, when one was. */
  title?: string | null;
  savePath?: string | null;
  /**
   * The release that was sent, addressable.
   *
   * Present whenever the pipeline chose something, including
   * `already_active` — a torrent that is already running is exactly the one a
   * caller wants to open the player on.
   */
  infoHash?: string | null;
  /**
   * Set only when a storage limit refused the grab. Carries which limit it was,
   * whether the owner may knowingly override it, the real figures, and where
   * the setting lives — so the UI can offer a choice instead of a dead end.
   */
  storage?: StorageOverrideFacts | null;
}

/** What a season-level one-click grab answers. */
export interface TitleSeasonEpisodeTransfer {
  episode: number;
  status: "downloading" | "failed";
  infoHash: string | null;
  error: string | null;
}

export interface TitleSeasonGrabResponse {
  ok: boolean;
  message: string;
  report?: SeasonGrabReport | null;
  /**
   * Exact episode outcomes used by the route to persist card-level transfer
   * state. The route removes this internal field before returning JSON.
   */
  episodeTransfers?: TitleSeasonEpisodeTransfer[];
  /**
   * Set only when a storage limit refused every send. Same shape as a single
   * episode grab so the title page can reuse the cap-override dialog.
   */
  storage?: StorageOverrideFacts | null;
}
