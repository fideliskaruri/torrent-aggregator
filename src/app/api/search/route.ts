import { NextRequest, NextResponse } from "next/server";
import { searchTorrents, listAvailableSources, SearchThrottledError } from "@/lib/torrents/aggregator";
import type { TorrentSourceId } from "@/lib/torrents/types";
import type { SearchFilters } from "@/lib/torrents/filters";
import { AGGREGATOR_CATEGORIES } from "@/lib/torrents/search-scopes";
import { auth } from "@/lib/auth";
import { getUserClientConfig } from "@/lib/clients";
import {
  queryNumber,
  queryString,
  requestFailureResponse,
  type RequestResult,
} from "@/lib/http/request";

export const dynamic = "force-dynamic";

const VALID_SOURCES = [
  "nyaa",
  "1337x",
  "apibay",
  "torrentscsv",
  "yts",
] as const satisfies readonly TorrentSourceId[];

function sourceId(value: string): TorrentSourceId | null {
  return VALID_SOURCES.find((candidate) => candidate === value) ?? null;
}

function binaryQuery(
  params: URLSearchParams,
  name: string,
): RequestResult<boolean | undefined> {
  const parsed = queryString(params, name, { allowed: ["0", "1"] });
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    value: parsed.value === undefined ? undefined : parsed.value === "1",
  };
}

export async function GET(request: NextRequest) {

  const { searchParams } = request.nextUrl;
  const qResult = queryString(searchParams, "q", {
    required: true,
    maxLength: 200,
  });
  if (!qResult.ok) {
    return NextResponse.json(
      {
        error: qResult.error,
        ...(qResult.field ? { field: qResult.field } : {}),
        availableSources: listAvailableSources(),
      },
      { status: qResult.status },
    );
  }
  const q = qResult.value ?? "";

  const categoryResult = queryString(searchParams, "category", {
    allowed: AGGREGATOR_CATEGORIES,
  });
  if (!categoryResult.ok) return requestFailureResponse(categoryResult);
  const category =
    AGGREGATOR_CATEGORIES.find(
      (candidate) => candidate === categoryResult.value,
    ) ?? "all";

  const pageResult = queryNumber(searchParams, "page", {
    integer: true,
    min: 1,
    max: 10_000,
  });
  if (!pageResult.ok) return requestFailureResponse(pageResult);
  const page = pageResult.value ?? 1;

  const pageSizeResult = queryNumber(searchParams, "pageSize", {
    integer: true,
    min: 1,
    max: 200,
  });
  if (!pageSizeResult.ok) return requestFailureResponse(pageSizeResult);
  const pageSize = pageSizeResult.value ?? 20;

  const limitResult = queryNumber(searchParams, "limit", {
    integer: true,
    min: 1,
    max: 200,
  });
  if (!limitResult.ok) return requestFailureResponse(limitResult);
  const limit = limitResult.value;

  const sourcesParam = searchParams.get("sources");
  let sources: TorrentSourceId[] | undefined;
  if (sourcesParam != null) {
    const requested = sourcesParam.split(",").map((value) => value.trim());
    if (requested.length > VALID_SOURCES.length || requested.some((value) => !value)) {
      return NextResponse.json(
        { error: `sources may contain at most ${VALID_SOURCES.length} non-empty values`, field: "sources" },
        { status: 400 },
      );
    }
    sources = [];
    for (const value of requested) {
      const source = sourceId(value);
      if (!source) {
        return NextResponse.json(
          { error: `Unknown source \`${value}\``, field: "sources" },
          { status: 400 },
        );
      }
      if (!sources.includes(source)) sources.push(source);
    }
  }

  const enrichResult = binaryQuery(searchParams, "enrich");
  if (!enrichResult.ok) return requestFailureResponse(enrichResult);
  const refreshResult = binaryQuery(searchParams, "refresh");
  if (!refreshResult.ok) return requestFailureResponse(refreshResult);
  const hasMagnetResult = binaryQuery(searchParams, "hasMagnet");
  if (!hasMagnetResult.ok) return requestFailureResponse(hasMagnetResult);

  const numericFilters = {
    minSeeders: queryNumber(searchParams, "minSeeders", { integer: true, min: 0 }),
    maxSeeders: queryNumber(searchParams, "maxSeeders", { integer: true, min: 0 }),
    minSizeBytes: queryNumber(searchParams, "minSize", { integer: true, min: 0 }),
    maxSizeBytes: queryNumber(searchParams, "maxSize", { integer: true, min: 0 }),
    season: queryNumber(searchParams, "season", { integer: true, min: 1, max: 10_000 }),
    episode: queryNumber(searchParams, "episode", { integer: true, min: 1, max: 100_000 }),
  };
  if (!numericFilters.minSeeders.ok) return requestFailureResponse(numericFilters.minSeeders);
  if (!numericFilters.maxSeeders.ok) return requestFailureResponse(numericFilters.maxSeeders);
  if (!numericFilters.minSizeBytes.ok) return requestFailureResponse(numericFilters.minSizeBytes);
  if (!numericFilters.maxSizeBytes.ok) return requestFailureResponse(numericFilters.maxSizeBytes);
  if (!numericFilters.season.ok) return requestFailureResponse(numericFilters.season);
  if (!numericFilters.episode.ok) return requestFailureResponse(numericFilters.episode);
  const resolution = queryString(searchParams, "resolution", {
    allowed: ["480p", "720p", "1080p", "2160p", "4k"],
  });
  if (!resolution.ok) return requestFailureResponse(resolution);
  const codec = queryString(searchParams, "codec", {
    allowed: ["x264", "h264", "x265", "h265", "hevc", "av1"],
  });
  if (!codec.ok) return requestFailureResponse(codec);
  const releaseKind = queryString(searchParams, "releaseKind", {
    allowed: ["packs", "episodes"],
  });
  if (!releaseKind.ok) return requestFailureResponse(releaseKind);
  if (
    numericFilters.minSeeders.value != null &&
    numericFilters.maxSeeders.value != null &&
    numericFilters.minSeeders.value > numericFilters.maxSeeders.value
  ) {
    return NextResponse.json(
      { error: "minSeeders cannot exceed maxSeeders", field: "minSeeders" },
      { status: 400 },
    );
  }
  if (
    numericFilters.minSizeBytes.value != null &&
    numericFilters.maxSizeBytes.value != null &&
    numericFilters.minSizeBytes.value > numericFilters.maxSizeBytes.value
  ) {
    return NextResponse.json(
      { error: "minSize cannot exceed maxSize", field: "minSize" },
      { status: 400 },
    );
  }
  const filters: SearchFilters = {
    minSeeders: numericFilters.minSeeders.value,
    maxSeeders: numericFilters.maxSeeders.value,
    minSizeBytes: numericFilters.minSizeBytes.value,
    maxSizeBytes: numericFilters.maxSizeBytes.value,
    season: numericFilters.season.value,
    episode: numericFilters.episode.value,
    resolution: resolution.value,
    codec: codec.value,
    hasMagnet: hasMagnetResult.value || undefined,
    releaseKind:
      releaseKind.value === "packs" || releaseKind.value === "episodes"
        ? releaseKind.value
        : undefined,
  };
  const enrich = enrichResult.value ?? true;
  const skipCache = refreshResult.value ?? false;

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
        message: "One or more indexers could not complete the search.",
      },
      { status: 500 },
    );
  }
}
