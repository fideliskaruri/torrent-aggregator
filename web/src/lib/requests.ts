/**
 * Requests: the one module both roles share. Parsing, labels, and the calls
 * that send or cancel a request live here; the pages only render.
 */
import { sessionAwareFetch } from "@/lib/session-expiry";

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
  | "partial"
  | "failed"
  | "cancelled";

export type RequestScope = "movie" | "seasons" | "series";

/** Catalog sources `POST /api/requester/requests` accepts — keep with server `IMetadataResolver.Providers`. */
export const REQUEST_PROVIDERS = ["tmdb", "anilist", "tvmaze", "cinemeta", "itunes"] as const;
export type RequestProvider = (typeof REQUEST_PROVIDERS)[number];

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

/** One title from `GET /api/requester/library`: identity and art only. */
export interface RequesterLibraryTitle {
  key: string;
  title: string;
  year: number | null;
  mediaType: string;
  posterUrl: string | null;
}

export function parseLibrary(json: unknown): RequesterLibraryTitle[] {
  const body = (json ?? {}) as { titles?: unknown };
  const rows = Array.isArray(body.titles) ? body.titles : [];
  return rows.flatMap((row): RequesterLibraryTitle[] => {
    const r = (row ?? {}) as Record<string, unknown>;
    const key = str(r.key);
    const title = str(r.title);
    if (!key || !title) return [];
    return [{ key, title, year: int(r.year), mediaType: str(r.mediaType) ?? "", posterUrl: str(r.posterUrl) }];
  });
}

/** One row of the owner's `GET /api/requests`. */
export interface OwnerRequest extends RequesterRequest {
  requestedBy: string;
}

export function parseOwnerRequests(json: unknown): { requests: OwnerRequest[]; pendingCount: number } {
  const body = (json ?? {}) as { requests?: unknown; pendingCount?: unknown };
  const rows = Array.isArray(body.requests) ? body.requests : [];
  const base = parseRequests({ requests: rows });
  const byId = new Map(
    rows.map((row) => {
      const r = (row ?? {}) as Record<string, unknown>;
      return [str(r.id) ?? "", str(r.requestedBy) ?? ""] as const;
    }),
  );
  const requests = base.map((r) => ({ ...r, requestedBy: byId.get(r.id) ?? "" }));
  const pending = int(body.pendingCount);
  return { requests, pendingCount: pending !== null && pending >= 0 ? pending : requests.filter((r) => r.status === "pending").length };
}

/**
 * The owner inbox shows what needs a decision, what can be retried, and what was decided.
 * Partial and failed rows stay so the owner can retry the missing episodes; cancelled and
 * fulfilled rows are history.
 */
export const INBOX_STATUSES: readonly RequestStatus[] = ["pending", "partial", "failed", "approved", "declined"];

/** Rows the owner can retry: only the episodes that never started are searched again. */
export function canRetryRequest(status: RequestStatus): boolean {
  return status === "partial" || status === "failed";
}

export function inboxRows(requests: readonly OwnerRequest[]): OwnerRequest[] {
  const rank = (s: RequestStatus) => INBOX_STATUSES.indexOf(s);
  return requests
    .filter((r) => rank(r.status) >= 0)
    .sort((a, b) => rank(a.status) - rank(b.status) || b.createdAt.localeCompare(a.createdAt));
}

/** The nav badge text for a pending count: nothing at zero or unknown, capped at 99+. */
export function pendingBadge(count: number | null | undefined): string | null {
  if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) return null;
  return count > 99 ? "99+" : String(Math.floor(count));
}

/** Owner auto-approve mode for one requester email. */
export type AutoApproveMode = "none" | "moviesOnly" | "everything";

export interface AutoApproveRule {
  email: string;
  mode: AutoApproveMode;
}

export interface AutoApproveConfig {
  rules: AutoApproveRule[];
  knownEmails: string[];
}

const AUTO_MODES: readonly AutoApproveMode[] = ["none", "moviesOnly", "everything"];

function asAutoMode(value: unknown): AutoApproveMode | null {
  return typeof value === "string" && (AUTO_MODES as readonly string[]).includes(value)
    ? (value as AutoApproveMode)
    : null;
}

export function parseAutoApprove(json: unknown): AutoApproveConfig {
  const body = (json ?? {}) as { rules?: unknown; knownEmails?: unknown };
  const rules = (Array.isArray(body.rules) ? body.rules : []).flatMap((row): AutoApproveRule[] => {
    const r = (row ?? {}) as Record<string, unknown>;
    const email = str(r.email);
    const mode = asAutoMode(r.mode);
    if (!email || !mode || mode === "none") return [];
    return [{ email: email.toLowerCase(), mode }];
  });
  const known = (Array.isArray(body.knownEmails) ? body.knownEmails : [])
    .flatMap((e) => {
      const v = str(e);
      return v ? [v.toLowerCase()] : [];
    });
  const emails = [...new Set([...known, ...rules.map((r) => r.email)])].sort((a, b) => a.localeCompare(b));
  return { rules, knownEmails: emails };
}

/** Rows the Auto-approve panel shows: every known email plus any draft the owner just typed. */
export function autoApproveRows(
  config: AutoApproveConfig,
  extraEmails: readonly string[] = [],
): { email: string; mode: AutoApproveMode }[] {
  const modeByEmail = new Map(config.rules.map((r) => [r.email, r.mode] as const));
  const emails = [...new Set([...config.knownEmails, ...extraEmails.map((e) => e.trim().toLowerCase()).filter(Boolean)])]
    .sort((a, b) => a.localeCompare(b));
  return emails.map((email) => ({ email, mode: modeByEmail.get(email) ?? "none" }));
}

export function autoApproveModeLabel(mode: AutoApproveMode): string {
  switch (mode) {
    case "none":
      return "Off";
    case "moviesOnly":
      return "Movies only";
    case "everything":
      return "Everything";
  }
}

const STATUSES: readonly RequestStatus[] = [
  "pending",
  "approved",
  "declined",
  "fulfilled",
  "partial",
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

/**
 * Where the request dialog reads a series' season list. A requester asks
 * `/api/requester/seasons`; the owner's "View as requester" preview is still the
 * owner's session (that endpoint refuses it), so it reads the same catalog list
 * from the title's extras. Both answer `{ seasons: number[] }`.
 */
export function requestSeasonsUrl(title: RequesterTitle | null, ownerSession: boolean): string | null {
  if (!title?.isSeries) return null;
  if (ownerSession) {
    const params = new URLSearchParams({ t: title.title, type: title.mediaType, provider: title.provider, series: "1" });
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
  const valid = rows.filter((s): s is number => int(s) !== null && (s as number) >= 1 && (s as number) <= 500);
  return [...new Set(valid)].sort((a, b) => a - b);
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
    case "partial":
      return "Partly done";
    case "failed":
      return "Couldn't get it";
    case "cancelled":
      return "Cancelled";
  }
}

export type StatusTone = "accent" | "success" | "danger" | "outline";

export function statusTone(status: RequestStatus): StatusTone {
  if (status === "pending" || status === "approved" || status === "partial") return "accent";
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

/** Why a request call failed, as far as the UI can tell. */
export interface RequestFailure {
  /** The server's machine-readable `code`, when it sent one. */
  code?: string | null;
  /** HTTP status; omitted when the call never reached the server. */
  status?: number;
}

/**
 * Plain-language copy for a failed request call: what happened and what to do
 * next. The server's own `error` text is never shown — it is written for
 * developers (field names, limits) — so unknown codes fall back by status.
 */
export function requestErrorMessage(failure: RequestFailure | string | null | undefined): string {
  const { code, status } = typeof failure === "string" ? { code: failure, status: undefined } : failure ?? {};
  switch (code) {
    case "in_library":
      return "That's already in the library. Open Library to find it.";
    case "duplicate":
      return "You've already asked for this. Follow it under Requests.";
    case "too_many_open":
      return "You have too many open requests. Cancel one under Requests, or wait for the owner to answer some.";
    case "rate_limited":
      return "You're sending requests too quickly. Wait a minute, then try again.";
    case "not_pending":
      return "The owner has already answered this request, so it can't be cancelled.";
    case "not_found":
      return "That request no longer exists. Refresh Requests to see the current list.";
    case "requester_only":
    case "requester_forbidden":
      return "Requests can only be sent from a friend's account. Sign in with the email the owner shared TorrentFlow with.";
    case "remote_sign_in_required":
      return "Your sign-in has expired. Reload the page to sign in again.";
    case "remote_access_off":
    case "remote_access_not_enabled":
      return "The owner has turned off remote access. Ask them to turn it back on.";
  }
  if (status === undefined) return "Couldn't reach TorrentFlow. Check your connection and try again.";
  if (status === 400) return "This title couldn't be requested. Open it again from Search and send the request once more.";
  if (status === 401) return "Your sign-in has expired. Reload the page to sign in again.";
  if (status === 403) return "Your account can't send requests. Ask the owner to check that your email is allowed.";
  if (status >= 500) return "TorrentFlow couldn't save the request. Try again in a moment.";
  return "The request didn't go through. Try again, and ask the owner if it keeps happening.";
}
/** Owner inbox copy for a failed approve/decline or auto-approve save. */
export function ownerRequestErrorMessage(
  action: "approve" | "decline" | "retry" | "auto-approve",
  failure: RequestFailure,
): string {
  if (action === "retry" && failure.code === "not_pending") return "Nothing is left to retry. The list now shows where it stands.";
  if (failure.code === "not_pending") return "This request was already answered. The list now shows where it stands.";
  if (failure.code === "not_found") return "That request no longer exists. The list now shows the current requests.";
  if (failure.status === undefined) return "Couldn't reach TorrentFlow. Check your connection and try again.";
  if (action === "auto-approve" && failure.status === 400) {
    return "Auto-approve wasn't saved. Check that each entry is a full email address, then try again.";
  }
  const verb = action === "auto-approve" ? "save auto-approve" : action;
  if (failure.status >= 500) return `Couldn't ${verb} right now. Try again in a moment.`;
  return `Couldn't ${verb}. Reload the page and try again.`;
}
/** Movies can be asked for once; a series can take more requests for other seasons. */
export function canRequest(title: RequesterTitle): boolean {
  if (title.inLibrary || title.providerId == null) return false;
  return title.isSeries || title.requestStatus == null;
}


/** What the catalog says about one title for the person asking. */
export interface RequestState {
  inLibrary: boolean;
  requestStatus: RequestStatus | null;
  requestId: string | null;
}

/** Reads the requester fields the server adds to search and title payloads; absent fields mean "nothing known". */
export function parseRequestState(json: unknown): RequestState {
  const r = (json ?? {}) as Record<string, unknown>;
  return { inLibrary: r.inLibrary === true, requestStatus: asStatus(r.requestStatus), requestId: str(r.requestId) };
}

export interface RequestView {
  /** Status chip text, or null for none. */
  label: string | null;
  tone: StatusTone;
  /** The button beside it, or null when there is nothing to ask for. */
  action: "Request" | "Request again" | "Request more seasons" | null;
}

/** What sits where the owner's Download would: a status, a Request button, or both. */
export function requestViewFor(state: RequestState, isSeries: boolean): RequestView {
  if (state.inLibrary || state.requestStatus === "fulfilled") {
    return { label: "Available", tone: "success", action: null };
  }
  switch (state.requestStatus) {
    case "pending":
      return { label: "Requested", tone: "accent", action: isSeries ? "Request more seasons" : null };
    case "approved":
      return { label: "Approved", tone: "accent", action: isSeries ? "Request more seasons" : null };
    case "declined":
      return { label: "Declined", tone: "danger", action: "Request again" };
    case "partial":
      return { label: statusLabel("partial"), tone: "accent", action: isSeries ? "Request more seasons" : null };
    case "failed":
      return { label: statusLabel("failed"), tone: "danger", action: "Request again" };
    default:
      return { label: null, tone: "outline", action: "Request" };
  }
}

/** A requester's own list: waiting first, then newest. */
export function myRequestRows<T extends Pick<RequesterRequest, "status" | "createdAt">>(requests: readonly T[]): T[] {
  return [...requests].sort(
    (a, b) => Number(b.status === "pending") - Number(a.status === "pending") || b.createdAt.localeCompare(a.createdAt),
  );
}

/** Cancels one of my pending requests. Resolves to an error message, or null when it worked. */
export async function cancelRequest(id: string): Promise<string | null> {
  try {
    const res = await sessionAwareFetch(`/api/requester/requests/${encodeURIComponent(id)}/cancel`, { method: "POST" });
    if (res.ok) return null;
    const body = (await res.json().catch(() => null)) as { code?: unknown } | null;
    return requestErrorMessage({ code: typeof body?.code === "string" ? body.code : null, status: res.status });
  } catch {
    return requestErrorMessage({});
  }
}

/** Sends one request. Resolves to an error message, or null when it worked. */
export async function sendRequest(title: RequesterTitle, choice: RequestChoice): Promise<string | null> {
  try {
    const res = await sessionAwareFetch("/api/requester/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createRequestBody(title, choice)),
    });
    if (res.ok) return null;
    const body = (await res.json().catch(() => null)) as { code?: unknown } | null;
    return requestErrorMessage({ code: typeof body?.code === "string" ? body.code : null, status: res.status });
  } catch {
    return requestErrorMessage({});
  }
}