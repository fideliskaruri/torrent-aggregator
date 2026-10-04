import type {
  OwnerRequest,
  RequestScope,
  RequestStatus,
  RequesterLibraryTitle,
  RequesterRequest,
  RequesterTitle,
  RequestState,
} from "./types";

const STATUSES: readonly RequestStatus[] = [
  "pending", "approved", "downloading", "available", "declined",
  "fulfilled", "partial", "failed", "cancelled",
];

function asStatus(value: unknown): RequestStatus | null {
  return typeof value === "string" && (STATUSES as readonly string[]).includes(value)
    ? value as RequestStatus
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function int(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function count(value: unknown): number {
  const number = int(value);
  return number !== null && number > 0 ? number : 0;
}

export function parseLibrary(json: unknown): RequesterLibraryTitle[] {
  const body = (json ?? {}) as { titles?: unknown };
  const rows = Array.isArray(body.titles) ? body.titles : [];
  return rows.flatMap((row): RequesterLibraryTitle[] => {
    const record = (row ?? {}) as Record<string, unknown>;
    const key = str(record.key);
    const title = str(record.title);
    if (!key || !title) return [];
    return [{
      key,
      title,
      year: int(record.year),
      mediaType: str(record.mediaType) ?? "",
      posterUrl: str(record.posterUrl),
    }];
  });
}

export function parseOwnerRequests(json: unknown): { requests: OwnerRequest[]; pendingCount: number } {
  const body = (json ?? {}) as { requests?: unknown; pendingCount?: unknown };
  const rows = Array.isArray(body.requests) ? body.requests : [];
  const requests = parseRequests({ requests: rows });
  const byId = new Map(rows.map((row) => {
    const record = (row ?? {}) as Record<string, unknown>;
    const requestedBy = str(record.requestedBy) ?? "";
    const requesters = Array.isArray(record.requesters)
      ? record.requesters.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [];
    return [str(record.id) ?? "", {
      requestedBy,
      requesters: requesters.length > 0 ? requesters : [requestedBy],
      workKey: str(record.workKey) ?? "",
      phase: asStatus(record.phase),
    }] as const;
  }));
  const ownerRows = requests.map((request) => ({
    ...request,
    requestedBy: byId.get(request.id)?.requestedBy ?? "",
    requesters: byId.get(request.id)?.requesters ?? [],
    workKey: byId.get(request.id)?.workKey ?? "",
    phase: byId.get(request.id)?.phase ?? null,
  }));
  const pending = int(body.pendingCount);
  return {
    requests: ownerRows,
    pendingCount: pending !== null && pending >= 0
      ? pending
      : ownerRows.filter((request) => request.status === "pending").length,
  };
}

export function parseRequests(json: unknown): RequesterRequest[] {
  const body = (json ?? {}) as { requests?: unknown };
  const rows = Array.isArray(body.requests) ? body.requests : [];
  return rows.flatMap((row): RequesterRequest[] => {
    const record = (row ?? {}) as Record<string, unknown>;
    const id = str(record.id);
    const title = str(record.title);
    const status = asStatus(record.status);
    const scope = record.scope === "movie" || record.scope === "seasons" || record.scope === "series"
      ? record.scope as RequestScope
      : null;
    if (!id || !title || !status || !scope) return [];
    return [{
      id,
      title,
      year: int(record.year),
      mediaType: str(record.mediaType) ?? "",
      provider: str(record.provider) ?? "",
      providerId: str(record.providerId),
      posterUrl: str(record.posterUrl),
      scope,
      seasons: Array.isArray(record.seasons)
        ? record.seasons.filter((season): season is number => int(season) !== null)
        : [],
      note: str(record.note),
      status,
      decisionReason: str(record.decisionReason),
      decidedAt: str(record.decidedAt),
      createdAt: str(record.createdAt) ?? "",
      updatedAt: str(record.updatedAt) ?? "",
      done: count(record.done),
      total: count(record.total),
      airing: record.airing === true,
    }];
  });
}

export function requestSeasonsUrl(title: RequesterTitle | null, ownerSession: boolean): string | null {
  if (!title?.isSeries) return null;
  if (ownerSession) {
    const params = new URLSearchParams({
      t: title.title,
      type: title.mediaType,
      provider: title.provider,
      series: "1",
    });
    if (title.year) params.set("y", String(title.year));
    if (title.providerId) params.set("providerId", title.providerId);
    return `/api/title/${encodeURIComponent(title.key)}/extras?${params}`;
  }
  return `/api/requester/seasons?${new URLSearchParams({
    provider: title.provider,
    providerId: title.providerId ?? "",
    mediaType: title.mediaType,
    title: title.title,
    ...(title.year ? { year: String(title.year) } : {}),
  })}`;
}

export function parseSeasons(json: unknown): number[] {
  const body = (json ?? {}) as { seasons?: unknown };
  const rows = Array.isArray(body.seasons) ? body.seasons : [];
  const valid = rows.filter((season): season is number =>
    int(season) !== null && (season as number) >= 1 && (season as number) <= 500);
  return [...new Set(valid)].sort((a, b) => a - b);
}

export function parseRequestState(json: unknown): RequestState {
  const record = (json ?? {}) as Record<string, unknown>;
  const seasons = Array.isArray(record.availableSeasons)
    ? record.availableSeasons.filter((season): season is number => int(season) !== null)
    : [];
  return {
    inLibrary: record.inLibrary === true,
    requestStatus: asStatus(record.requestStatus),
    requestId: str(record.requestId),
    availableSeasons: seasons,
    requestDone: count(record.requestDone),
    requestTotal: count(record.requestTotal),
    requestAiring: record.requestAiring === true,
  };
}
