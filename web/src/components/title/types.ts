
import type { AvailabilityState } from "@/lib/browse";
import type { CatalogCardData } from "@/lib/api/catalog-types";
import type { JellyfinNextUp, JellyfinWatchState } from "@/lib/api/watchlist-types";
export type { JellyfinNextUp, JellyfinWatchState } from "@/lib/api/watchlist-types";

/** One row in the episode list. */
export interface TitleEpisode {
  season: number;
  episode: number;
  /** `S02E05`, ready to print. */
  label: string;

  availability: AvailabilityState | null;
  infoHash: string | null;
  /** File inside the torrent, when the transfer named one. */
  filePath: string | null;
  /** 0–1 download progress when the torrent is partially fetched. */
  downloadFraction: number | null;
  /** The episode the library hunt is waiting for, if this show is monitored. */
  nextUp: boolean;
  /** Satisfied by an exact file inside a legacy pack already held locally. */
  fromPack: boolean;
  /** Exact user acquisition state. Never inferred from a covering pack. */
  transfer: TitleEpisodeTransfer | null;
  /** Requester view only: the owner already has this episode. */
  available?: boolean;
  /** Requester view only: the plain state of the owner's download, never its queue position. */
  state?: TitleTransferState | null;
  /** Jellyfin progress for this episode. Absent when Jellyfin has no match. */
  watchState?: JellyfinWatchState;
  /** Present when a file for this episode is in the library, whatever its origin. */
  owned?: TitleOwned | null;
}

/** An owned item: the best owned file's resolution, null when the file names none. */
export interface TitleOwned {
  resolution: number | null;
}

export type TitleTransferState = "looking" | "waiting_english" | "waiting_sources" | "waiting_season_list" | "queued" | "downloading" | "downloaded" | "failed";

export interface TitleEpisodeTransfer {
  status: "queued" | "downloading" | "downloaded" | "failed";
  state?: TitleTransferState;
  progress: number;
  infoHash: string | null;
  filePath: string | null;
  error: string | null;
  /** Owner only, while waiting for a download slot: 1 is next. */
  queuePosition?: number | null;
  /** Owner only, while waiting for a download slot: `queue-full` or `outside-window`. */
  waitReason?: string | null;
  /** Plain-language reason when this transfer is waiting on a source or metadata. */
  reason?: string | null;
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

  transfer: TitleEpisodeTransfer | null;

  downloadedEpisodes?: number;
  /** Distinct episodes queued or transferring, not already downloaded. */
  downloadingEpisodes?: number;
}

/** Where this work stands in the user's library. */
export interface TitleLibraryState {
  inLibrary: boolean;
  watchListItemId: string | null;
  monitored: boolean;
  status: string | null;
  cursorSeason: number | null;
  cursorEpisode: number | null;

  addPayload: {
    mediaType: string;
    externalId: string;
    title: string;
    posterUrl: string | null;
    synopsis: string | null;
    rating: number | null;
    workKey?: string;
    provider?: string | null;
    providerId?: string | null;
    /** The work's stored format (Movie, Series, Special), when known. */
    format?: string | null;
  };
}

/** One labelled name of a work. English and romaji are searched first; native script only matches. */
export interface WorkName {
  text: string;
  kind: "english" | "romaji" | "synonym" | "native" | "original";
}

/** A work's ids at each provider (null when unknown). */
export interface WorkIds {
  tmdb: number | null;
  anilist: number | null;
  mal: number | null;
  imdb: string | null;
}

/** The complete payload for one title page. */
export interface TitleDetailPayload {
  workKey: string;
  title: string;

  aliases: string[];
  /** Every labelled name a grab of this title searches and matches with (the saved work's, else the provider's). */
  names: WorkName[];
  /** The title's ids at each provider that knows it. */
  ids: WorkIds;
  /** Movie, series or special as the provider tells it; null when unknown. Stored only, nothing decides by it yet. */
  format: 'movie' | 'series' | 'special' | null;
  /** ISO 639-1 original language from the provider; null when unknown. */
  originalLanguage: string | null;
  year: number | null;
  /** Canonical media type, or null when nothing vouches for one. */
  mediaType: string | null;
  /** Does this work have seasons and episodes? */
  isSeries: boolean;
  overview: string | null;
  rating: number | null;

  ratingSource?: TitleExtrasPayload["ratingSource"];
  posterUrl: string | null;
  backdropUrl: string | null;

  releaseDate: string | null;


  availability: AvailabilityState | null;
  infoHash: string | null;
  /** 0–1 download progress when the title-level torrent is partial. */
  downloadFraction: number | null;


  transfer: TitleEpisodeTransfer | null;
  /** Present when the film's file is in the library, whatever its origin. */
  owned?: TitleOwned | null;
  /** Jellyfin progress for a film. Absent when Jellyfin is not connected or has no match. */
  watchState?: JellyfinWatchState;
  /** The episode Jellyfin would play next for a series. Absent when unknown. */
  jellyfinNextUp?: JellyfinNextUp;

  /** Every season we know of, ascending. Empty for a film. */
  seasons: TitleSeason[];
  /** The season `episodes` belongs to, or null. */
  season: number | null;
  episodes: TitleEpisode[];
  /** True when the episode list was capped rather than exhausted. */
  episodesTruncated: boolean;

  library: TitleLibraryState;


  known: boolean;

  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Extras — the second round trip
// ---------------------------------------------------------------------------

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
export interface TitleSimilar extends CatalogCardData {
  workKey: string;
  /** Ready-made `/title/...` link, with the identity hints already attached. */
  href: string;
  title: string;
  year: number | null;
  mediaType: string;
  posterUrl: string | null;
  rating: number | null;
}

export interface TitleExtrasPayload {
  workKey: string;
  /** The season `episodes` describes, or null when this is not a series. */
  season: number | null;
  /** Real season count from the metadata provider. Null means *unknown*. */
  seasonCount: number | null;
  /** Every season number the provider knows about, ascending. */
  seasons: number[];

  airedEpisodes?: Record<string, number>;
  episodes: TitleEpisodeMeta[];
  moreLikeThis: TitleSimilar[];

  partOf?: TitleSimilar;

  overview: string | null;
  rating: number | null;

  releaseDate: string | null;

  inTheatricalWindow: boolean;

  nextHomeReleaseAt: string | null;

  genres: string[];

  voteCount: number | null;

  ratingSource?: "tmdb" | "anilist" | "tvmaze" | "itunes" | "cinemeta" | null;

  certification: string | null;

  originalLanguage: string | null;
  /** False when there was no usable provider match — drives nothing but copy. */
  resolved: boolean;
  generatedAt: string;
}

/** What `POST /api/title/[workKey]` answers. */
export interface TitleGrabResponse {
  ok: boolean;
  message: string;

  workKey?: string | null;
  queued?: boolean;
}
