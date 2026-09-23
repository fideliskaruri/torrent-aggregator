import { NextRequest } from "next/server";
import { rateLimit } from "@/lib/torrents/search-cache";
import {
  parseWorkSearchScope,
  type WorkSearchHit,
} from "@/lib/search/work-search";
import {
  AllProvidersFailedError,
  searchWorksByScope,
} from "@/lib/search/work-search-fanout";
import {
  jsonResponse,
  observeRequest,
} from "@/lib/observability/logging";

export const dynamic = "force-dynamic";

/**
 * Canonical work discovery only.
 *
 * Search must never touch torrent indexers. Movies and series use their
 * dedicated TMDB endpoints; anime uses AniList and preserves its format.
 * The query is canonicalized once (see `canonicalizeSearchQuery`) so casing and
 * whitespace variants of the same search take the same provider requests, the
 * same ranking and the same upstream cache entries.
 */
export async function GET(request: NextRequest) {
  const observer = observeRequest(request, "title-search", "search-titles");
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!rateLimit(`search-titles:${ip}`, 60)) {
    return jsonResponse(
      observer,
      { error: "Too many requests", results: [] as WorkSearchHit[] },
      { status: 429 },
    );
  }

  const { searchParams } = request.nextUrl;
  const q = searchParams.get("q")?.trim() ?? "";
  const category = parseWorkSearchScope(searchParams.get("category"));
  if (!q) {
    return jsonResponse(
      observer,
      { error: "Missing query parameter `q`", results: [] as WorkSearchHit[] },
      { status: 400 },
    );
  }
  if (q.length > 200) {
    return jsonResponse(
      observer,
      { error: "Query too long", results: [] as WorkSearchHit[] },
      { status: 400 },
    );
  }

  const limitRaw = searchParams.get("limit");
  const limit = Math.min(
    Math.max(parseInt(limitRaw ?? "12", 10) || 12, 1),
    40,
  );

  try {
    const outcome = await searchWorksByScope(category, q, limit);

    if (outcome.partial) {
      // Honest partial: the categories that answered are returned, and the
      // failure is named in the payload instead of failing the whole search.
      observer.degraded("TITLE_SEARCH_FAILED", {
        category,
        status: `partial:${outcome.failed.join(",")}`,
        resultCount: outcome.results.length,
      });
    } else {
      observer.success("TITLE_SEARCH_SUCCEEDED", {
        category,
        resultCount: outcome.results.length,
        limit,
      }, { emit: false });
    }

    return jsonResponse(observer, {
      results: outcome.results,
      query: outcome.displayQuery,
      canonicalQuery: outcome.query,
      category,
      partial: outcome.partial,
      failedProviders: outcome.failed,
      stale: outcome.stale ?? false,
    });
  } catch (err) {
    const safeError = observer.failure("TITLE_SEARCH_FAILED", err, { category });
    return jsonResponse(
      observer,
      {
        error: "Title search failed",
        code: safeError.code,
        message: safeError.message,
        results: [] as WorkSearchHit[],
        partial: false,
        failedProviders:
          err instanceof AllProvidersFailedError ? err.failed : [],
      },
      { status: 500 },
    );
  }
}
