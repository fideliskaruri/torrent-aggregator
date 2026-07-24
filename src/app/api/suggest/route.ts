import { NextRequest, NextResponse } from "next/server";
import { searchAniList } from "@/lib/metadata/anilist";
import { searchTmdb } from "@/lib/metadata/tmdb";
import { rateLimit } from "@/lib/torrents/search-cache";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!rateLimit(`suggest:${ip}`, 60)) {
    return NextResponse.json({ suggestions: [] });
  }

  const q = request.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) {
    return NextResponse.json({ suggestions: [] });
  }

  const [anime, tmdb] = await Promise.allSettled([
    searchAniList(q, 4),
    searchTmdb(q, 4),
  ]);

  const suggestions: {
    title: string;
    mediaType: string;
    posterUrl?: string | null;
    year?: number | null;
    source: string;
    externalId: string;
  }[] = [];

  if (anime.status === "fulfilled") {
    for (const m of anime.value) {
      suggestions.push({
        title: m.title,
        mediaType: m.mediaType,
        posterUrl: m.posterUrl,
        year: m.year,
        source: m.source,
        externalId: m.externalId,
      });
    }
  }

  if (tmdb.status === "fulfilled") {
    for (const m of tmdb.value) {
      suggestions.push({
        title: m.title,
        mediaType: m.mediaType,
        posterUrl: m.posterUrl,
        year: m.year,
        source: m.source,
        externalId: m.externalId,
      });
    }
  }

  // Dedupe by title
  const seen = new Set<string>();
  const unique = suggestions.filter((s) => {
    const k = s.title.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return NextResponse.json({ suggestions: unique.slice(0, 8) });
}
