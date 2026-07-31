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
  /** Covered by a season pack rather than a file of its own. */
  fromPack: boolean;
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

  /** Every season we know of, ascending. Empty for a film. */
  seasons: TitleSeason[];
  /** The season `episodes` belongs to, or null. */
  season: number | null;
  episodes: TitleEpisode[];
  /** True when the episode list was capped rather than exhausted. */
  episodesTruncated: boolean;

  library: TitleLibraryState;

  /** The release table, kept as the "choose a different release" escape hatch. */
  releasesHref: string;

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
  /** False when there was no usable provider match — drives nothing but copy. */
  resolved: boolean;
  generatedAt: string;
}

export type TitleRetention = "stream" | "keep";

/** Body accepted by `POST /api/title/[workKey]` — the one-click grab. */
export interface TitleGrabRequest {
  /** Omit for the normal title/episode action; `season` plans known rows. */
  mode?: "title" | "season";
  /** Omit both for a film (or a whole-title grab). */
  season?: number | null;
  episode?: number | null;
  /** Known episode numbers for a one-press season grab. */
  episodes?: number[] | null;
  /** Local torrent to promote to kept retention without re-sending it. */
  infoHash?: string | null;
  /** Stream-only cache or permanent keep, matching `/api/torrent/send`. */
  retention?: TitleRetention;
  /**
   * Preferred resolution in pixels (480 / 720 / 1080 / 2160).
   * Only sent when the user has chosen a quality via the Download picker.
   * Play never sends this — it is instant and never prompts.
   */
  resolution?: number | null;
  /** Passed through when the page was reached with only a title in the URL. */
  title?: string | null;
  mediaType?: string | null;
  year?: number | null;
  /**
   * The owner saw the real figures and chose to exceed their own storage cap.
   * Only the cap can be overridden this way — the free-space floor cannot.
   */
  overrideStorageCap?: boolean;
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
export interface TitleSeasonGrabResponse {
  ok: boolean;
  message: string;
  report?: SeasonGrabReport | null;
}
