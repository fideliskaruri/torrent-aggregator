export type DownloadStatus =
  | "downloading"
  | "queued"
  | "paused"
  | "finishing"
  | "ready"
  | "waiting"
  | "error";

export type DownloadMediaKind = "movie" | "series" | "anime";
export type DownloadResolution = "2160p" | "1080p" | "720p" | "480p" | null;
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
  state: string;
  status: DownloadStatus;
  statusLabel: string;
  quality: DownloadQuality;
  mediaKind: DownloadMediaKind;
  groupKey: string;
  actions: DownloadActions;
  eta?: number;
  peers?: number;
  category?: string | null;
  savePath?: string | null;
  queuePosition?: number;
  error?: string | null;
  forced?: boolean;
  verified?: boolean;
  addedAt?: string | null;
  filesMissing?: boolean;
  workId?: string | null;
  workKey?: string | null;
  workTitle?: string | null;
  workYear?: number | null;
  workMediaType?: string | null;
  posterUrl?: string | null;
  targetScope?: string | null;
  season?: number | null;
  episode?: number | null;
  packEpisodes?: number | null;
  ownerClientType: "qbittorrent" | "transmission" | "builtin";
  ownerClientLabel: string;
  transferId: string;
  magnet?: string | null;
  imported?: boolean;
}

export type TorrentRowAction = "pause" | "resume" | "force" | "find-another-release";

export function isDownloadRow(_torrent: ClientTorrent): boolean {
  return true;
}
