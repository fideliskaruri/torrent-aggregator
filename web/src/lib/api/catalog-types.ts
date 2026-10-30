interface CatalogCardActionRequest {
  watchListItemId: string;
  title: string;
  mediaType: string;
  season: number;
  episode: number;
}

export type CatalogCardAction =
  | { kind: "local"; label: string; disabled: false; reason: null; href: string; request: null }
  | { kind: "downloading"; label: string; disabled: true; reason: string; href: null; request: null }
  | { kind: "get"; label: string; disabled: false; reason: null; href: null; request: CatalogCardActionRequest }
  | { kind: "search"; label: string; disabled: false; reason: null; href: string; request: null }
  | { kind: "request"; label: string; disabled: false; reason: null; href: string; request: null }
  | { kind: "blocked"; label: string; disabled: true; reason: string; href: null; request: null };

export interface CatalogCardData {
  href: string;
  action: CatalogCardAction;
}

export type MediaFileInspectionState = "pending" | "unknown" | "verified" | "rejected";

export interface MediaFileInspection {
  mediaFileId: string;
  inspectionState: MediaFileInspectionState;
  audioLanguages: string[];
  replacement?: MediaFileReplacement | null;
}

export interface MediaFileReplacement {
  targetId: string;
  state: "looking" | "downloading" | "ready" | "failed";
  mediaFileId: string | null;
  inspectionState: MediaFileInspectionState | null;
}

export interface RejectedAudioSummary {
  languages: string[];
}

export interface MediaInspectionSummary {
  mediaFiles?: MediaFileInspection[];
  rejectedAudio?: RejectedAudioSummary | null;
}

export type ActionStatus = "idle" | "pending" | "done" | "error";
