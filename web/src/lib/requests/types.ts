export interface RequesterTitle {
  key: string;
  title: string;
  year: number | null;
  mediaType: string;
  isSeries: boolean;
  format: string | null;
  category: string;
  provider: string;
  providerId: string | null;
  posterUrl: string | null;
  overview: string | null;
  releaseDate: string | null;
  inLibrary: boolean;
  requestStatus: RequestStatus | null;
  requestId: string | null;
}

export type RequestStatus =
  | "pending"
  | "approved"
  | "downloading"
  | "available"
  | "declined"
  | "fulfilled"
  | "partial"
  | "failed"
  | "cancelled";

export type RequestScope = "movie" | "seasons" | "series";
export type RequestProvider = "tmdb" | "anilist" | "tvmaze" | "cinemeta" | "itunes";

export interface RequesterRequest {
  id: string;
  title: string;
  year: number | null;
  mediaType: string;
  provider: string;
  providerId: string | null;
  posterUrl: string | null;
  scope: RequestScope;
  seasons: number[];
  note: string | null;
  status: RequestStatus;
  decisionReason: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
  done: number;
  total: number;
  airing: boolean;
}

export interface RequesterLibraryTitle {
  key: string;
  title: string;
  year: number | null;
  mediaType: string;
  posterUrl: string | null;
}

export interface OwnerRequest extends RequesterRequest {
  requestedBy: string;
  requesters: string[];
  phase: RequestStatus | null;
  workKey: string;
}

export interface RequestChoice {
  scope: RequestScope;
  seasons: number[];
  note: string;
}

export interface RequestFailure {
  code?: string | null;
  status?: number;
}

export interface RequestState {
  inLibrary: boolean;
  requestStatus: RequestStatus | null;
  requestId: string | null;
  availableSeasons?: number[];
  requestDone?: number;
  requestTotal?: number;
  requestAiring?: boolean;
}

export type StatusTone = "accent" | "success" | "danger" | "outline";

export interface RequestView {
  label: string | null;
  tone: StatusTone;
  action: "Request" | "Request again" | "Request more seasons" | null;
  note?: string | null;
}
