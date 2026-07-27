import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { normalizeMediaType, isSeriesMediaType } from "@/lib/metadata/media-type";
import { titlePath, workKeyFor } from "@/components/title/work-key";
import type {
  TitleExtrasPayload,
  TitleSimilar,
} from "@/components/title/types";
import {
  fetchMoreLikeThis,
  fetchSeasonEpisodes,
  fetchShowShape,
  resolveTmdbRef,
} from "../../tmdb-extras";

export const dynamic = "force-dynamic";

type RouteParams = { workKey: string };
type RouteContext = { params: RouteParams | Promise<RouteParams> };

/**
 * The second round trip for a title page.
 *
 * `GET /api/title/[workKey]` answers from the local database and never touches
 * the network, so the page paints at once. This route is where everything that
 * *does* need the network lives — episode names and air dates, the true season
 * count, and the "more like this" rail that stops a film page being a hero over
 * several hundred pixels of nothing.
 *
 * It is deliberately failure-tolerant to the point of being boring: an absent
 * API key, a timeout, or a work TMDB has never heard of all produce an empty
 * payload with `resolved: false`, never a non-200. The page it feeds is already
 * complete and correct before this answers; nothing here may turn a working
 * page into an error state.
 */
export async function GET(request: Request, context: RouteContext) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { workKey } = await context.params;
  if (!workKey?.trim()) {
    return NextResponse.json({ error: "Missing work key" }, { status: 400 });
  }

  const key = decodeSegment(workKey);
  const url = new URL(request.url);
  const title = url.searchParams.get("t")?.trim() || "";
  const year = intParam(url.searchParams.get("y"));
  const mediaType = url.searchParams.get("type");
  const season = intParam(url.searchParams.get("s"));

  const empty: TitleExtrasPayload = {
    workKey: key,
    season,
    seasonCount: null,
    seasons: [],
    episodes: [],
    moreLikeThis: [],
    resolved: false,
    generatedAt: new Date().toISOString(),
  };

  // Without a title there is nothing to search for. A work key is a slug, and
  // un-slugging it would guess at punctuation the provider matches on.
  if (!title) return NextResponse.json(empty);

  try {
    const ref = await resolveTmdbRef({ title, year, mediaType });
    if (!ref) return NextResponse.json(empty);

    const series = ref.mediaType === "tv";

    // The season shape and the neighbours have no dependency on each other,
    // so serialising them would double the wait for no reason.
    const [shape, similar] = await Promise.all([
      series ? fetchShowShape(ref.id) : Promise.resolve(null),
      fetchMoreLikeThis(ref),
    ]);

    // Which season to describe: what the page asked for, else the first one
    // the provider admits to. Never season 0 — specials are not "season one".
    const wanted =
      season != null && season >= 1
        ? season
        : (shape?.seasons[0] ?? (series ? 1 : null));

    const episodes =
      series && wanted != null ? await fetchSeasonEpisodes(ref.id, wanted) : [];

    const payload: TitleExtrasPayload = {
      workKey: key,
      season: series ? wanted : null,
      seasonCount: shape?.seasonCount ?? null,
      seasons: shape?.seasons ?? [],
      episodes,
      moreLikeThis: similar.map(toSimilarLink),
      resolved: true,
      generatedAt: new Date().toISOString(),
    };

    return NextResponse.json(payload);
  } catch (err) {
    // Enrichment is never worth a red page. Log it and answer with nothing.
    console.error("[title:extras]", err);
    return NextResponse.json(empty);
  }
}

/**
 * Attach the identity the linked page will need.
 *
 * A slug alone is often enough, but a work whose key collapses to something
 * ambiguous ("dune") still renders correctly when the title, year and media
 * type ride along — the same hints a browse card carries.
 */
function toSimilarLink(item: {
  title: string;
  year: number | null;
  mediaType: string;
  posterUrl: string | null;
  rating: number | null;
}): TitleSimilar {
  const normalized = normalizeMediaType(item.mediaType);
  // A film's identity includes its year; a series' does not, because a show
  // spans years and its releases never agree on which one to print.
  const series = normalized ? isSeriesMediaType(normalized) : false;
  const keyYear = series ? null : item.year;
  const key = workKeyFor(item.title, keyYear);

  return {
    workKey: key,
    href: titlePath(key, {
      title: item.title,
      year: item.year,
      mediaType: normalized ?? item.mediaType,
    }),
    title: item.title,
    year: item.year,
    mediaType: normalized ?? item.mediaType,
    posterUrl: item.posterUrl,
    rating: item.rating,
  };
}

/** Path segments arrive percent-encoded for non-Latin slugs. */
function decodeSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function intParam(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}
