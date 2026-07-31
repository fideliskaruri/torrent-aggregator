/**
 * What the search palette should be doing right now — as data, not JSX.
 *
 * The overlay has to answer two questions on every keystroke and every scope
 * change: *which request do I make?* and *what do I show while I wait?* Both
 * used to be implicit in the component, which was survivable while there was
 * exactly one kind of search. With scopes there are two request shapes and six
 * display states, and the combinations are where the wrong thing gets shown:
 * an empty film grid for a music query, or a "no results" panel while a request
 * is still in flight.
 *
 * Pulling them out makes the rules assertable without a DOM (`search-overlay-
 * state.test.ts`) and keeps the component to layout and wiring.
 */
import {
  getScope,
  type SearchScope,
  type SearchScopeId,
} from "@/lib/torrents/search-scopes";

/** The minimum query length worth sending. */
export const MIN_QUERY_LENGTH = 2;

export interface SearchRequest {
  url: string;
  /** Which renderer the response feeds. */
  kind: "work" | "release";
}

/**
 * The request for a scope + query, or null when there is nothing worth asking.
 *
 * Returning null rather than a request with an empty `q` is deliberate: the
 * indexer budget is shared and finite (see `aggregator.ts`), and a one-letter
 * query spends it on results nobody can use.
 */
export function searchRequestFor(
  scopeId: SearchScopeId,
  query: string,
  opts: { limit?: number } = {},
): SearchRequest | null {
  const q = query.trim();
  if (q.length < MIN_QUERY_LENGTH) return null;

  const scope = getScope(scopeId);
  if (scope.kind === "work") {
    const qs = new URLSearchParams({ q, limit: String(opts.limit ?? 12) });
    return { url: `/api/search/titles?${qs}`, kind: "work" };
  }

  const qs = new URLSearchParams({
    q,
    category: scope.category ?? "all",
    pageSize: String(opts.limit ?? 20),
  });
  return { url: `/api/search?${qs}`, kind: "release" };
}

/**
 * What the results area shows.
 *
 * `prompt` is the state a scope opens in, and it is the one most likely to be
 * seen: the owner picks "Music" and has not typed yet. Rendering nothing there
 * — which is what the film-only overlay did for an empty query — leaves a blank
 * panel that looks broken. The scope knows what it holds and what a real query
 * looks like, so it says so.
 */
export type SearchDisplay =
  | { state: "prompt"; scope: SearchScope }
  | { state: "typing"; scope: SearchScope }
  | { state: "loading"; scope: SearchScope }
  | { state: "empty"; scope: SearchScope; query: string }
  | { state: "error"; scope: SearchScope; message: string }
  | { state: "results"; scope: SearchScope; kind: "work" | "release" };

export function searchDisplayFor(input: {
  scopeId: SearchScopeId;
  query: string;
  loading: boolean;
  error: string | null;
  resultCount: number;
}): SearchDisplay {
  const scope = getScope(input.scopeId);
  const q = input.query.trim();

  // Results first, and while loading too: a scope switch or a new keystroke
  // must not blank the list that is already useful. Replacing rows with a
  // spinner on every character is the flicker that makes search feel broken.
  if (input.resultCount > 0) {
    return { state: "results", scope, kind: scope.kind === "work" ? "work" : "release" };
  }
  if (input.loading) return { state: "loading", scope };

  // An error outranks "empty": "nothing matched" is a claim about the corpus,
  // and we have no right to make it when the request never completed.
  if (input.error) return { state: "error", scope, message: input.error };

  if (q.length === 0) return { state: "prompt", scope };
  if (q.length < MIN_QUERY_LENGTH) return { state: "typing", scope };
  return { state: "empty", scope, query: q };
}

/**
 * The input's placeholder for a scope.
 *
 * Each scope carries a real example rather than "Search…", because the useful
 * query shape differs per scope — "Daft Punk Discovery" and "Mistborn epub"
 * teach the owner that format words work, which is not obvious.
 */
export function placeholderFor(scopeId: SearchScopeId): string {
  return getScope(scopeId).placeholder;
}

/**
 * Turn a failed search into something worth reading.
 *
 * The aggregator rate-limits shared indexer budget and answers 429; that is a
 * "try again shortly", not a failure, and saying "search failed" would send the
 * owner looking for a problem that does not exist.
 */
export function searchErrorMessage(
  status: number,
  body: { error?: string | null } | null,
): string {
  if (status === 429) {
    return "Searching too quickly — the indexers need a moment. Try again shortly.";
  }
  const stated = body?.error?.trim();
  if (stated) return stated;
  if (status >= 500) return "The indexers did not answer. Try again in a moment.";
  return "Could not run that search.";
}
