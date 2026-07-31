/**
 * The rules behind `/everything` — the section for what Browse cannot show.
 *
 * Browse and the title page are TMDB-backed, so they can only ever describe a
 * film or a series. Music, games, software, books and anime were reachable from
 * `/api/search` the whole time and had nowhere to be *asked for*. This module
 * holds every decision that section makes which is not a DOM node:
 *
 *  - which scope a URL means (and what to do when it names one we do not have),
 *  - which of the six view states a render is in,
 *  - which page may be requested next,
 *  - what an error actually was — a rate limit is a *wait*, not a failure,
 *  - where the bytes will land, in the owner's own configured path.
 *
 * It is pure and DOM-free so `everything-state.test.ts` can drive each of those
 * as a table over every scope, rather than one hand-picked example. The scope
 * vocabulary itself is never re-declared here: `SECTION_SCOPES` is the single
 * source of truth, and adding a scope there must flow through this module and
 * into the page with no edit to either.
 */
import {
  SECTION_SCOPES,
  parseScopeId,
  type SearchScope,
  type SearchScopeId,
} from "@/lib/torrents/search-scopes";

/** The section's route. Exported so nothing has to hardcode the string. */
export const EVERYTHING_HREF = "/everything";

/**
 * Shortest query worth sending.
 *
 * One character matches most of every indexer's catalogue, so it costs a real
 * fan-out request to return noise. Two matches the search overlay, so the two
 * surfaces feel the same under the fingers.
 */
export const MIN_SECTION_QUERY = 2;

/**
 * Results per request.
 *
 * Deliberately far below the API's 200 cap and the film path's
 * `DEFAULT_PAGE_SIZE`. These rows are read one at a time to decide "is this the
 * edition I want?", so 200 of them is a wall, not a flow — and a smaller page
 * makes the first result appear sooner, which is what the owner is waiting for.
 */
export const SECTION_PAGE_SIZE = 40;

/** The scope the section opens on when the URL does not name one. */
export const DEFAULT_SECTION_SCOPE: SearchScope = SECTION_SCOPES[0];

/**
 * Why the requested scope is not the one being shown.
 *
 *  - `unknown-scope` — the URL named something this app has no concept of.
 *  - `films` — the URL named a real scope (`titles`) that belongs to Browse,
 *    not here. Worth distinguishing: the honest answer is a pointer to the film
 *    surface, not "that does not exist".
 */
export type SectionNotice = "unknown-scope" | "films" | null;

export interface SectionParams {
  scope: SearchScope;
  query: string;
  notice: SectionNotice;
}

function searchParamsOf(input: string | URLSearchParams): URLSearchParams {
  if (typeof input !== "string") return input;
  return new URLSearchParams(input.startsWith("?") ? input.slice(1) : input);
}

/**
 * Read `?scope=…&q=…` into the state the section renders.
 *
 * Untrusted input goes through {@link parseScopeId} rather than a cast, and a
 * scope this section does not carry falls back with a `notice` instead of being
 * silently answered with a different shelf — a `?scope=podcasts` link quietly
 * returning music results is the failure mode this reports on.
 */
export function parseSectionParams(
  input: string | URLSearchParams,
): SectionParams {
  const params = searchParamsOf(input);
  const raw = params.get("scope");
  const id = parseScopeId(raw);
  const scope = id ? (SECTION_SCOPES.find((s) => s.id === id) ?? null) : null;

  let notice: SectionNotice = null;
  if (raw != null && raw.trim() !== "") {
    if (!id) notice = "unknown-scope";
    else if (!scope) notice = "films";
  }

  return {
    scope: scope ?? DEFAULT_SECTION_SCOPE,
    query: (params.get("q") ?? "").trim(),
    notice,
  };
}

/**
 * The canonical URL for a scope + query.
 *
 * `scope` is always written, even for the default: the scope *is* the identity
 * of what you are looking at here, and a shared link that omits it reads as
 * "search everything" to whoever opens it. `q` is omitted when empty so the
 * resting state has a clean, bookmarkable address.
 */
export function sectionHref(
  scopeId: SearchScopeId,
  query: string = "",
): string {
  const params = new URLSearchParams({ scope: scopeId });
  const q = query.trim();
  if (q) params.set("q", q);
  return `${EVERYTHING_HREF}?${params.toString()}`;
}

/** What an unsuccessful search was — a wait, or a genuine failure. */
export interface SectionError {
  kind: "throttled" | "failed";
  message: string;
  /** Seconds to wait, when the server said. Never invented. */
  retryAfterSeconds: number | null;
}

function positiveSeconds(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.ceil(n);
}

/**
 * Turn an `/api/search` failure into something a person can act on.
 *
 * 429 is the case that matters: the indexers are busy and the *only* correct
 * advice is how long to wait. Rendering that as "Search failed" would tell the
 * owner their app is broken when it is working exactly as designed, so it gets
 * its own kind and carries the server's own `retryAfterSeconds` — never a
 * number this module made up.
 */
export function searchErrorFrom(
  status: number,
  body: { error?: unknown; message?: unknown; retryAfterSeconds?: unknown } | null,
): SectionError {
  const retryAfterSeconds = positiveSeconds(body?.retryAfterSeconds);
  if (status === 429) {
    return {
      kind: "throttled",
      message: retryAfterSeconds
        ? `The indexers are rate-limiting us. Try again in ${retryAfterSeconds} seconds.`
        : "The indexers are rate-limiting us. Try again in a moment.",
      retryAfterSeconds,
    };
  }
  const detail =
    (typeof body?.message === "string" && body.message.trim()) ||
    (typeof body?.error === "string" && body.error.trim()) ||
    "";
  return {
    kind: "failed",
    message: detail || `Search failed (HTTP ${status}).`,
    retryAfterSeconds: null,
  };
}

/** A thrown fetch error — no response, so nothing about waiting is knowable. */
export function networkErrorFrom(err: unknown): SectionError {
  const detail = err instanceof Error ? err.message.trim() : String(err ?? "").trim();
  return {
    kind: "failed",
    message: detail
      ? `Could not reach the search service: ${detail}`
      : "Could not reach the search service.",
    retryAfterSeconds: null,
  };
}

/**
 * The six states this section can be in.
 *
 *  - `brief` — no usable query. The resting state most visits see, so it says
 *    what the scope holds instead of rendering a blank void.
 *  - `loading` / `results` / `empty` / `error` / `throttled`.
 */
export type SectionViewKind =
  | "brief"
  | "loading"
  | "results"
  | "empty"
  | "error"
  | "throttled";

export interface SectionViewInput {
  query: string;
  /** True from the keystroke onward, including the debounce window. */
  loading: boolean;
  resultCount: number;
  error: SectionError | null;
}

/**
 * Pick the state to render.
 *
 * Two orderings are load-bearing. Results outrank `loading` so fetching page 2
 * never blanks the rows already on screen — the "load more" spinner belongs
 * under the list, not instead of it. And they outrank `error` for the same
 * reason: a failed *second* page must not throw away the first.
 *
 * `loading` outranks `empty` so the debounce window never flashes "nothing
 * matched" at a query that has not been sent yet.
 */
export function sectionView({
  query,
  loading,
  resultCount,
  error,
}: SectionViewInput): SectionViewKind {
  if (query.trim().length < MIN_SECTION_QUERY) return "brief";
  if (resultCount > 0) return "results";
  if (error) return error.kind === "throttled" ? "throttled" : "error";
  if (loading) return "loading";
  return "empty";
}

/** True when a query is long enough to be worth a request. */
export function isSearchable(query: string): boolean {
  return query.trim().length >= MIN_SECTION_QUERY;
}

/**
 * Keep a page number inside what the server actually has.
 *
 * Guards every route into paging: a hand-edited number, a stale "load more"
 * click after the total shrank, and `totalPages: 0` on an empty result — all of
 * which would otherwise request a page that cannot exist.
 */
export function clampPage(page: number, totalPages: number): number {
  const max = Math.max(
    1,
    Number.isFinite(totalPages) ? Math.floor(totalPages) : 1,
  );
  const wanted = Number.isFinite(page) ? Math.floor(page) : 1;
  return Math.min(Math.max(wanted, 1), max);
}

/** Whether another page exists beyond the one just loaded. */
export function hasMorePages(page: number, totalPages: number): boolean {
  if (!Number.isFinite(page) || !Number.isFinite(totalPages)) return false;
  return totalPages > 0 && page < totalPages;
}

/** "40 of 70 results" — what is on screen against what exists. */
export function loadedLabel(loaded: number, totalCount: number): string {
  const total = Math.max(0, Math.floor(totalCount));
  const shown = Math.max(0, Math.min(Math.floor(loaded), total));
  if (total === 0) return "No results";
  if (shown >= total) {
    return `${total} ${total === 1 ? "result" : "results"}`;
  }
  return `${shown} of ${total} results`;
}

export interface ClientPathSettings {
  baseDownloadPath?: string | null;
  savePath?: string | null;
  pathRules?: Record<string, string> | null;
}

export interface DownloadDestination {
  /** The folder to show. Empty only when nothing at all is configured. */
  path: string;
  /** False when the owner has not chosen a download folder yet. */
  configured: boolean;
  /** The category folder these results are filed under, when there is one. */
  category: string | null;
  /**
   * True when the folder depends on what each result turns out to be — the
   * mixed `everything` scope, where a single answer would be a guess.
   */
  perResult: boolean;
}

/** Client-side path join for previews. Mirrors the settings page's joinBase. */
export function joinDownloadPath(base: string, segment: string): string {
  const b = base.replace(/[/\\]+$/, "");
  if (!b) return "";
  if (!segment) return b;
  const sep = b.includes("\\") ? "\\" : "/";
  return `${b}${sep}${segment}`;
}

/**
 * Where a scope's downloads will land, in the owner's own configured path.
 *
 * The complaint behind this whole section was not knowing where bytes go, so
 * the section states it *before* the download starts rather than after. This is
 * a promise about the configured folder, not the routing decision itself —
 * `smart-category.ts` still decides on the server, and a per-category path rule
 * the owner set takes precedence exactly as it does there.
 */
export function downloadDestination(
  scope: SearchScope,
  settings: ClientPathSettings | null,
): DownloadDestination {
  const category = scope.downloadCategory;
  const rules = settings?.pathRules ?? {};
  const base = settings?.baseDownloadPath?.trim() ?? "";
  const savePath = settings?.savePath?.trim() ?? "";
  const perResult = category === null;

  if (category) {
    const rule = rules[category]?.trim();
    if (rule) return { path: rule, configured: true, category, perResult };
  }
  if (base) {
    return {
      path: category ? joinDownloadPath(base, category) : base,
      configured: true,
      category,
      perResult,
    };
  }
  if (savePath) {
    return { path: savePath, configured: true, category, perResult };
  }
  return { path: category ?? "", configured: false, category, perResult };
}

/**
 * Real queries to offer on the resting state, read from the scope's own
 * placeholder rather than invented here.
 *
 * A single example is a placeholder, not a set of suggestions — offering one
 * clickable chip that just repeats the input's grey text is decoration. So a
 * scope that states fewer than two gets none, which is why the deliberately
 * vague `everything` placeholder ("Anything at all…") produces an empty list
 * instead of a button that means nothing.
 */
export function exampleQueries(scope: SearchScope): string[] {
  const parts = scope.placeholder
    .split(",")
    .map((part) => part.replace(/[\u2026.\s]+$/u, "").trim())
    .filter(Boolean);
  return parts.length >= 2 ? parts : [];
}

/** "Try again in 12s" while a rate limit is still counting down. */
export function retryLabel(secondsLeft: number): string {
  const s = Number.isFinite(secondsLeft) ? Math.ceil(secondsLeft) : 0;
  return s > 0 ? `Try again in ${s}s` : "Try again";
}
