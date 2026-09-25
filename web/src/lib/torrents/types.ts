/** Normalized torrent result shared by all source adapters */
export interface TorrentResult {
  id: string;
  title: string;
  magnet?: string;
  torrentUrl?: string;
  infoHash?: string;
  sizeBytes: number | null;
  sizeLabel?: string;
  seeders: number;
  leechers: number;
  completed?: number;
  category?: string;
  source: TorrentSourceId;
  sourceUrl: string;
  publishedAt?: string | null;
  /** Optional quality tags extracted from title */
  tags: string[];
  /** Ranking score assigned by aggregator (higher = better) */
  score?: number;
  /** 0–100 swarm health estimate */
  health?: number;
  /** Best pick in a release group */
  bestPick?: boolean;
  /** Group key for same show/episode releases */
  groupKey?: string;
  /** Parsed episode info */
  episode?: {
    season?: number;
    episode?: number;
    label: string | null;
    isBatch: boolean;
    isSeasonPack: boolean;
    /** A range like S01-S05 — must not be filed under a single season. */
    isMultiSeason?: boolean;
    /** Non-episode companion material identified from explicit release words. */
    specialType?: "ova" | "movie" | "recap" | "special";
  };
  /** Scene/fansub group parsed from an explicit bracketed release prefix. */
  releaseGroup?: string;
  /** Enriched metadata (posters, synopsis) when available */
  metadata?: MediaMetadata | null;
  /**
   * Server-computed download routing. Frontend should display this and
   * only send overrides as commands — never re-classify on the client.
   */
  route?: DownloadRoute | null;
}

/** Download destination decided by the backend */
interface DownloadRoute {
  kind: string;
  category: string;
  confidence: "high" | "medium" | "low";
  cleanTitle?: string | null;
  /** Absolute path when base folder / rules known (auth + settings) */
  savePath?: string | null;
  /** Relative hint when no base path configured, e.g. TV/Show Name */
  relativePath?: string | null;
}

export type TorrentSourceId =
  | "nyaa"
  | "1337x"
  | "apibay"
  | "torrentscsv"
  | "eztv"
  | "yts";

export interface MediaMetadata {
  source: "anilist" | "tmdb";
  mediaType: "anime" | "movie" | "tv";
  externalId: string;
  title: string;
  /** Provider-verified alternate names for this exact work. */
  aliases?: string[];
  posterUrl?: string | null;
  backdropUrl?: string | null;
  synopsis?: string | null;
  rating?: number | null;
  year?: number | null;
  /**
   * Primary release date (movie) or first-air date (tv/anime), ISO string.
   * Drives future-gating (grayed poster + "Coming {date}"). Null/absent =
   * unknown, which is never gated. See src/lib/browse/release-status.ts.
   */
  releaseDate?: string | null;
  genres?: string[];
  /**
   * ISO 639-1 original language reported by the catalog (TMDB), e.g. "ja".
   * Together with an Animation genre this is what separates a Japanese
   * animated series from a same-named western show.
   */
  originalLanguage?: string | null;
  /** ISO 3166-1 origin countries reported by the catalog (TMDB), e.g. ["JP"]. */
  originCountry?: string[];
}

interface ClientTorrent {
  hash: string;
  name: string;
  progress: number; // 0–1
  sizeBytes: number;
  dlspeed: number;
  upspeed: number;
  state: string;
  eta?: number;
  /** Connected peers. 0 while downloading is what "stalled" actually means. */
  peers?: number;
  /** Client-reported failure reason, when state is "error". */
  error?: string | null;
  /** False only when the app has proof this transfer contains no playable video. */
  playable?: boolean;
  category?: string;
  /** Absolute download directory from the torrent client */
  savePath?: string | null;
  /** Whether this torrent is permanent or a stream cache entry. */
  retentionState?: "kept" | "stream" | "prewarm" | "unknown";
}

/**
 * A transfer after the server has attached the client that actually owns it.
 * The owner is derived from the adapter being queried, never trusted from a
 * remote client's payload.
 */
export interface OwnedClientTorrent extends ClientTorrent {
  ownerClientType: "qbittorrent" | "transmission" | "builtin";
  ownerClientLabel: string;
  /** Stable row/action identity; hashes are only unique inside one client. */
  transferId: string;
}
