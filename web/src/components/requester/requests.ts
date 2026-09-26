import type { TitleResult } from "@/components/search/group-titles";
import { releaseStatus } from "@/lib/browse/release-status";

/** One title from `GET /api/requester/titles`. No file paths, magnets or owner data. */
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
  /** My open request for this title, if any. */
  requestStatus: RequestStatus | null;
  requestId: string | null;
}

export type RequestStatus =
  | "pending"
  | "approved"
  | "declined"
  | "fulfilled"
  | "failed"
  | "cancelled";

export type RequestScope = "movie" | "seasons" | "series";

/** One of my requests from `GET /api/requester/requests`. */
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
}

export type RequesterView = "search" | "requests";

/** The requester shell has two views; every other path shows search. */
export function requesterView(pathname: string): RequesterView {
  return pathname.replace(/\/+$/, "").toLowerCase() === "/requests" ? "requests" : "search";
}

const STATUSES: readonly RequestStatus[] = [
  "pending",
  "approved",
  "declined",
  "fulfilled",
  "failed",
  "cancelled",
];

function asStatus(value: unknown): RequestStatus | null {
  return typeof value === "string" && (STATUSES as readonly string[]).includes(value)
    ? (value as RequestStatus)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function int(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

export function parseTitles(json: unknown): { results: RequesterTitle[]; partial: boolean } {
  const body = (json ?? {}) as { results?: unknown; partial?: unknown };
  const rows = Array.isArray(body.results) ? body.results : [];
  const results = rows.flatMap((row): RequesterTitle[] => {
    const r = (row ?? {}) as Record<string, unknown>;
    const title = str(r.title);
    const key = str(r.key);
    const provider = str(r.provider);
    const mediaType = str(r.mediaType);
    if (!title || !key || !provider || !mediaType) return [];
    return [{
      key,
      title,
      year: int(r.year),
      mediaType,
      isSeries: r.isSeries === true,
      format: str(r.format),
      category: str(r.category) ?? "",
      provider,
      providerId: str(r.providerId),
      posterUrl: str(r.posterUrl),
      overview: str(r.overview),
      releaseDate: str(r.releaseDate),
      inLibrary: r.inLibrary === true,
      requestStatus: asStatus(r.requestStatus),
      requestId: str(r.requestId),
    }];
  });
  return { results, partial: body.partial === true };
}

export function parseRequests(json: unknown): RequesterRequest[] {
  const body = (json ?? {}) as { requests?: unknown };
  const rows = Array.isArray(body.requests) ? body.requests : [];
  return rows.flatMap((row): RequesterRequest[] => {
    const r = (row ?? {}) as Record<string, unknown>;
    const id = str(r.id);
    const title = str(r.title);
    const status = asStatus(r.status);
    const scope = r.scope === "movie" || r.scope === "seasons" || r.scope === "series" ? r.scope : null;
    if (!id || !title || !status || !scope) return [];
    return [{
      id,
      title,
      year: int(r.year),
      mediaType: str(r.mediaType) ?? "",
      provider: str(r.provider) ?? "",
      providerId: str(r.providerId),
      posterUrl: str(r.posterUrl),
      scope,
      seasons: Array.isArray(r.seasons) ? r.seasons.filter((s): s is number => int(s) !== null) : [],
      note: str(r.note),
      status,
      decisionReason: str(r.decisionReason),
      decidedAt: str(r.decidedAt),
      createdAt: str(r.createdAt) ?? "",
      updatedAt: str(r.updatedAt) ?? "",
    }];
  });
}

export function parseSeasons(json: unknown): number[] {
  const body = (json ?? {}) as { seasons?: unknown };
  const rows = Array.isArray(body.seasons) ? body.seasons : [];
  const valid = rows.filter((s): s is number => int(s) !== null && (s as number) >= 1 && (s as number) <= 500);
  return [...new Set(valid)].sort((a, b) => a - b);
}

/** Adapts a requester title to the shared search card (requesters get no title page link). */
export function toTitleResult(title: RequesterTitle): TitleResult {
  return {
    key: title.key,
    name: title.title,
    year: title.year,
    isSeries: title.isSeries,
    mediaType: title.mediaType,
    format: title.format,
    posterUrl: title.posterUrl,
    releaseDate: title.releaseDate,
    status: releaseStatus(title.releaseDate),
    href: null,
    overview: title.overview,
  };
}

export function statusLabel(status: RequestStatus): string {
  switch (status) {
    case "pending":
      return "Waiting for approval";
    case "approved":
      return "Approved";
    case "declined":
      return "Declined";
    case "fulfilled":
      return "Ready";
    case "failed":
      return "Couldn't get it";
    case "cancelled":
      return "Cancelled";
  }
}

export type StatusTone = "accent" | "success" | "danger" | "outline";

export function statusTone(status: RequestStatus): StatusTone {
  if (status === "pending" || status === "approved") return "accent";
  if (status === "fulfilled") return "success";
  if (status === "declined" || status === "failed") return "danger";
  return "outline";
}

export function scopeLabel(request: Pick<RequesterRequest, "scope" | "seasons">): string {
  if (request.scope === "movie") return "Movie";
  if (request.scope === "series") return "Whole series";
  return formatSeasons(request.seasons);
}

/** "Season 2", "Seasons 1–3", "Seasons 1, 3, 5–6". */
export function formatSeasons(seasons: readonly number[]): string {
  const sorted = [...new Set(seasons)].sort((a, b) => a - b);
  if (sorted.length === 0) return "Seasons";
  if (sorted.length === 1) return `Season ${sorted[0]}`;
  const parts: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (const n of [...sorted.slice(1), Number.NaN]) {
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    parts.push(start === prev ? String(start) : `${start}–${prev}`);
    start = n;
    prev = n;
  }
  return `Seasons ${parts.join(", ")}`;
}

export interface RequestChoice {
  scope: RequestScope;
  seasons: number[];
  note: string;
}

/** The exact body `POST /api/requester/requests` accepts. */
export function createRequestBody(title: RequesterTitle, choice: RequestChoice) {
  const note = choice.note.trim();
  const scope: RequestScope = title.isSeries ? (choice.scope === "seasons" ? "seasons" : "series") : "movie";
  return {
    provider: title.provider,
    providerId: title.providerId,
    mediaType: title.mediaType,
    title: title.title,
    year: title.year,
    posterUrl: title.posterUrl,
    scope,
    seasons: scope === "seasons" ? [...new Set(choice.seasons)].sort((a, b) => a - b) : [],
    note: note.length > 0 ? note : null,
  };
}

/** A short, friendly message for a failed request call. */
export function requestErrorMessage(code: string | null | undefined, fallback?: string | null): string {
  switch (code) {
    case "in_library":
      return "That one is already in the library.";
    case "duplicate":
      return "You've already asked for this.";
    case "too_many_open":
      return "You have too many open requests. Wait for some to be handled or cancel one.";
    case "rate_limited":
      return "Slow down a little and try again in a minute.";
    case "not_pending":
      return "Only requests still waiting for approval can be cancelled.";
    case "not_found":
      return "That request no longer exists.";
    default:
      return fallback && fallback.length <= 200 ? fallback : "Something went wrong. Try again.";
  }
}

/** Movies can be asked for once; a series can take more requests for other seasons. */
export function canRequest(title: RequesterTitle): boolean {
  if (title.inLibrary || title.providerId == null) return false;
  return title.isSeries || title.requestStatus == null;
}
