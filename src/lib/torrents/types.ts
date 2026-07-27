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
  };
  /** Enriched metadata (posters, synopsis) when available */
  metadata?: MediaMetadata | null;
  /**
   * Server-computed download routing. Frontend should display this and
   * only send overrides as commands — never re-classify on the client.
   */
  route?: DownloadRoute | null;
}

/** Download destination decided by the backend */
export interface DownloadRoute {
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

export interface SearchOptions {
  query: string;
  category?: "all" | "anime" | "movies" | "tv" | "music" | "apps" | "games";
  /** Optional max ranked results (e.g. rules/watchlist). Not a page size. */
  limit?: number;
  /** 1-based page index (default 1). */
  page?: number;
  /** Results per page (default 20, max 50). */
  pageSize?: number;
  sources?: TorrentSourceId[];
}

export interface SearchResponse {
  query: string;
  results: TorrentResult[];
  groups?: ReleaseGroup[];
  tookMs: number;
  cached?: boolean;
  /** Total ranked results after filters (before pagination). */
  totalCount: number;
  /** Current 1-based page. */
  page: number;
  /** Page size used for this response. */
  pageSize: number;
  /** totalCount / pageSize, at least 1 when totalCount > 0, else 0. */
  totalPages: number;
  sources: {
    id: TorrentSourceId;
    count: number;
    error?: string;
  }[];
}

export interface ReleaseGroup {
  key: string;
  label: string;
  best: TorrentResult;
  alternatives: TorrentResult[];
}

export interface MediaMetadata {
  source: "anilist" | "tmdb";
  mediaType: "anime" | "movie" | "tv";
  externalId: string;
  title: string;
  posterUrl?: string | null;
  backdropUrl?: string | null;
  synopsis?: string | null;
  rating?: number | null;
  year?: number | null;
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

export interface TorrentSourceAdapter {
  readonly id: TorrentSourceId;
  readonly name: string;
  search(options: SearchOptions): Promise<TorrentResult[]>;
}

export interface ClientTorrent {
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
  category?: string;
  /** Absolute download directory from the torrent client */
  savePath?: string | null;
  /** Whether this torrent is permanent or a stream cache entry. */
  retentionState?: "kept" | "stream" | "prewarm" | "unknown";
}
