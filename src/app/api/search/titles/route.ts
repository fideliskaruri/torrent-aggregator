import { NextRequest, NextResponse } from "next/server";
import { searchTmdb } from "@/lib/metadata/tmdb";
import { workKeyFor, titlePath } from "@/components/title/work-key";
import { rankTitleHitsByRelevance } from "@/components/search/title-search";
import { rateLimit } from "@/lib/torrents/search-cache";

export const dynamic = "force-dynamic";

export interface TitleSearchHit {
  workKey: string;
  title: string;
  year: number | null;
  mediaType: "movie" | "tv";
  posterUrl: string | null;
  posterPath?: string | null;
  overview?: string | null;
  popularity?: number | null;
  releaseDate?: string | null;
  /** Convenience path so clients don't re-derive the title-page link. */
  href: string;
}

/**
 * TMDB title discovery only.
 *
 * Search must never touch torrent indexers. The user types a name, we return
 * the closest TMDB matches as cards, and only a click on a card (title page)
 * may start torrent matching.
 */
export async function GET(request: NextRequest) {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!rateLimit(`search-titles:${ip}`, 60)) {
    return NextResponse.json(
      { error: "Too many requests", results: [] as TitleSearchHit[] },
      { status: 429 },
    );
  }

  const { searchParams } = request.nextUrl;
  const q = searchParams.get("q")?.trim() ?? "";
  if (!q) {
    return NextResponse.json(
      { error: "Missing query parameter `q`", results: [] as TitleSearchHit[] },
      { status: 400 },
    );
  }
  if (q.length > 200) {
    return NextResponse.json(
      { error: "Query too long", results: [] as TitleSearchHit[] },
      { status: 400 },
    );
  }

  const limitRaw = searchParams.get("limit");
  const limit = Math.min(
    Math.max(parseInt(limitRaw ?? "12", 10) || 12, 1),
    40,
  );

  try {
    const hits = await searchTmdb(q, limit);
    const results: TitleSearchHit[] = [];
    for (const m of hits) {
      const mediaType: "movie" | "tv" =
        m.mediaType === "tv" ? "tv" : "movie";
      const year = m.year ?? null;
      // Films carry year in the key; series do not (same rule as work-key.ts).
      const workKey = workKeyFor(
        m.title,
        mediaType === "movie" ? year : null,
      );
      if (!workKey) continue;
      results.push({
        workKey,
        title: m.title,
        year,
        mediaType,
        posterUrl: m.posterUrl ?? null,
        overview: m.synopsis ?? null,
        releaseDate: m.releaseDate ?? null,
        href: titlePath(workKey, {
          title: m.title,
          year,
          mediaType,
        }),
      });
    }

    return NextResponse.json({
      results: rankTitleHitsByRelevance(results, q),
      query: q,
    });
  } catch (err) {
    console.error("[search/titles]", err);
    return NextResponse.json(
      {
        error: "Title search failed",
        message: err instanceof Error ? err.message : String(err),
        results: [] as TitleSearchHit[],
      },
      { status: 500 },
    );
  }
}