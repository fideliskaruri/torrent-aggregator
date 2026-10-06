export type DownloadStatus =
  | "downloading"
  | "queued"
  | "paused"
  | "finishing"
  | "ready"
  | "waiting"
  | "error";

export type DownloadMediaKind = "movie" | "series" | "anime";
export type DownloadResolution = number | null;
export type DownloadQualitySource = "web" | "bluray" | "hdtv" | "dvd" | "cam" | "ts" | null;

export interface DownloadQuality {
  resolution: DownloadResolution;
  source: DownloadQualitySource;
  label: string | null;
}

export interface DownloadActions {
  pause: boolean;
  resume: boolean;
  downloadNow: boolean;
  findAnother: boolean;
  open: boolean;
  remove: boolean;
}

export interface ClientTorrent {
  hash: string;
  name: string;
  progress: number;
  sizeBytes: number;
  dlspeed: number;
  upspeed: number;
  status: DownloadStatus;
  statusLabel: string;
  quality: DownloadQuality;
  mediaKind: DownloadMediaKind;
  isSeries: boolean;
  groupKey: string;
  actions: DownloadActions;
  eta?: number;
  peers?: number;
  category?: string | null;
  savePath?: string | null;
  addedAt?: string | null;
  filesMissing?: boolean;
  workId?: string | null;
  workKey?: string | null;
  workTitle?: string | null;
  workYear?: number | null;
  workMediaType?: string | null;
  posterUrl?: string | null;
  season?: number | null;
  episode?: number | null;
  targetId?: number | string | null;
  packed?: boolean;
  transferId: string;
  magnet?: string | null;
}

export type TorrentRowAction = "pause" | "resume" | "force" | "find-another-release";
