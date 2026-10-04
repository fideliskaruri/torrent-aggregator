export interface JellyfinWatchState {
  watched: boolean;
  inProgress: number | null;
}

export interface JellyfinNextUp {
  episodeId: string;
  season: number;
  episode: number;
}

export interface WatchlistItem {
  id: string;
  userId?: string;
  workId?: string;
  workKey?: string | null;
  mediaType: string;
  externalId: string;
  provider?: string;
  title: string;
  posterUrl: string | null;
  synopsis: string | null;
  rating: number | null;
  status: string;
  monitored?: boolean;
  fromSeason?: number | null;
  fromEpisode?: number | null;
  cursorSeason?: number | null;
  cursorEpisode?: number | null;
  cursorMisses?: number;
  monitorMode?: string | null;
  newEpisodesSince?: string | null;
  ready?: boolean;
  createdAt?: string;
  updatedAt: string;
  seederWaitSince?: string | null;
  preferredResolution?: number | null;
  watchState?: JellyfinWatchState;
  jellyfinNextUp?: JellyfinNextUp;
}

export interface WatchlistResponse {
  items: WatchlistItem[];
}

export interface OnDemandResponse {
  ok?: boolean;
  message?: string;
  advanced?: boolean;
  cursorSeason?: number;
  cursorEpisode?: number;
  lastEpisode?: string;
  nextEpisodeHint?: string;
  noReleaseFound?: { manualSearchQuery?: string | null } | null;
  workKey?: string;
}

export interface DeletePlan {
  outcome: "deletes" | "blocked" | "nothing-held";
  fileCount: number;
  totalBytes: number;
  missingFileCount: number;
  releases: Array<{ name: string; fileCount: number; bytes: number }>;
  blocked: Array<{ name: string; covers: string; fileCount: number }>;
  summary: string;
}
