import { NextRequest } from "next/server";
import { searchTmdbByType } from "@/lib/metadata/tmdb";
import { searchAniListWorks } from "@/lib/metadata/anilist";
import { rankTitleHitsByRelevance } from "@/components/search/title-search";
import { rateLimit } from "@/lib/torrents/search-cache";
import {
  parseWorkSearchCategory,
  workSearchHitFromMetadata,
  type WorkSearchHit,
} from "@/lib/search/work-search";
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
  const category = parseWorkSearchCategory(searchParams.get("category"));
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
    const results: WorkSearchHit[] = [];
    switch (category) {
      case "movies": {
        const works = await searchTmdbByType("movie", q, limit);
        for (const metadata of works) {
          const hit = workSearchHitFromMetadata(metadata, category);
          if (hit) results.push(hit);
        }
        break;
      }
      case "series": {
        const works = await searchTmdbByType("tv", q, limit);
        for (const metadata of works) {
          const hit = workSearchHitFromMetadata(metadata, category);
          if (hit) results.push(hit);
        }
        break;
      }
      case "anime": {
        const works = await searchAniListWorks(q, limit);
        for (const work of works) {
          const hit = workSearchHitFromMetadata(
            work.metadata,
            category,
            work.format,
          );
          if (hit) results.push(hit);
        }
        break;
      }
    }

    const ranked = rankTitleHitsByRelevance(results, q);
    observer.success("TITLE_SEARCH_SUCCEEDED", {
      category,
      resultCount: ranked.length,
      limit,
    }, { emit: false });
    return jsonResponse(observer, {
      results: ranked,
      query: q,
      category,
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
      },
      { status: 500 },
    );
  }
}