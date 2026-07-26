import { NextRequest, NextResponse } from "next/server";
import { searchTorrents, listAvailableSources, SearchThrottledError } from "@/lib/torrents/aggregator";
import type { TorrentSourceId } from "@/lib/torrents/types";
import { parseFiltersFromParams } from "@/lib/torrents/filters";
import { auth } from "@/lib/auth";
import { getUserClientConfig } from "@/lib/clients";

export const dynamic = "force-dynamic";

const VALID_CATEGORIES = new Set([
  "all",
  "anime",
  "movies",
  "tv",
  "music",
  "apps",
  "games",
]);

const VALID_SOURCES = new Set<TorrentSourceId>([
  "nyaa",
  "1337x",
  "apibay",
  "torrentscsv",
  "yts",
]);

export async function GET(request: NextRequest) {

  const { searchParams } = request.nextUrl;
  const q = searchParams.get("q")?.trim() ?? "";

  if (!q) {
    return NextResponse.json(
      {
        error: "Missing query parameter `q`",
        availableSources: listAvailableSources(),
      },
      { status: 400 },
    );
  }

  if (q.length > 200) {
    return NextResponse.json({ error: "Query too long" }, { status: 400 });
  }

  const categoryRaw = searchParams.get("category") ?? "all";
  const category = VALID_CATEGORIES.has(categoryRaw)
    ? (categoryRaw as
        | "all"
        | "anime"
        | "movies"
        | "tv"
        | "music"
        | "apps"
        | "games")
    : "all";

  const page = Math.max(
    parseInt(searchParams.get("page") ?? "1", 10) || 1,
    1,
  );
  const pageSize = Math.min(
    Math.max(parseInt(searchParams.get("pageSize") ?? "20", 10) || 20, 1),
    200,
  );
  // Optional hard cap on ranked pool (legacy / power users). Default: no cap.
  const limitRaw = searchParams.get("limit");
  const limit = limitRaw
    ? Math.min(Math.max(parseInt(limitRaw, 10) || 0, 1), 200)
    : undefined;

  const sourcesParam = searchParams.get("sources");
  const sources = sourcesParam
    ? (sourcesParam
        .split(",")
        .map((s) => s.trim())
        .filter((s): s is TorrentSourceId =>
          VALID_SOURCES.has(s as TorrentSourceId),
        ) as TorrentSourceId[])
    : undefined;

  const enrich = searchParams.get("enrich") !== "0";
  const skipCache = searchParams.get("refresh") === "1";
  const filters = parseFiltersFromParams(searchParams);

  try {
    // Routing prefs from logged-in user settings (base folder, categories)
    let routing = null;
    try {
      const session = await auth();
      if (session?.user?.id) {
        const cfg = await getUserClientConfig(session.user.id);
        if (cfg) {
          routing = {
            categories: cfg.categories,
            baseDownloadPath: cfg.baseDownloadPath,
            pathRules: cfg.pathRules,
            savePath: cfg.savePath,
          };
        }
      }
    } catch {
      // unauthenticated / no settings — routes still include kind/category
    }

    const result = await searchTorrents({
      query: q,
      category,
      page,
      pageSize,
      limit,
      sources,
      enrich,
      filters,
      skipCache,
      routing,
    });
    return NextResponse.json({
      ...result,
      availableSources: listAvailableSources(),
    });
  } catch (err) {
    if (err instanceof SearchThrottledError) {
      return NextResponse.json(
        {
          error: "Indexers busy",
          message: err.message,
          retryAfterSeconds: err.retryAfterSeconds,
        },
        {
          status: 429,
          headers: { "Retry-After": String(err.retryAfterSeconds) },
        },
      );
    }
    console.error("[search]", err);
    return NextResponse.json(
      {
        error: "Search failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
