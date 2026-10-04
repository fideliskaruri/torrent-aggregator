export interface CatalogCardActionRequest {
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
  searchHref: string | null;
  action: CatalogCardAction;
}

export type ActionStatus = "idle" | "pending" | "done" | "error";
