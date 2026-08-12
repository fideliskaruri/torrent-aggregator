import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { normalizeMediaType, isSeriesMediaType } from "@/lib/metadata/media-type";
import { titlePath, workKeyFor } from "@/components/title/work-key";
import type {
  TitleExtrasPayload,
  TitleSimilar,
} from "@/components/title/types";
import {
  recommendationsForProvider,
  type Recommendation,
} from "@/lib/recommend";
import {
  fetchHomeRelease,
  fetchSeasonEpisodes,
  fetchShowShape,
  fetchTitleFacts,
  fetchWorkBlurb,
  resolveTmdbRef,
} from "../../tmdb-extras";
import { resolveTitleProviderIdentity } from "../provider-identity";
import { providerEpisodePlaceholders } from "./episode-placeholders";
import { providerExtrasResponse } from "./provider-response";
import { tvmazeExtrasResponse } from "./tvmaze-response";
import { fetchAniListRecommendationsForPoster } from "@/lib/metadata/anilist";

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
    overview: null,
    rating: null,
    releaseDate: null,
    inTheatricalWindow: false,
    nextHomeReleaseAt: null,
    genres: [],
    voteCount: null,
    certification: null,
    originalLanguage: null,
    resolved: false,
    generatedAt: new Date().toISOString(),
  };

  // Without a title there is nothing to search for. A work key is a slug, and
  // un-slugging it would guess at punctuation the provider matches on.
  if (!title) return NextResponse.json(empty);

  try {
    const providerResult = await resolveTitleProviderIdentity(url.searchParams, key);
    const providerResponse = providerExtrasResponse(providerResult, empty);
    if (providerResponse) {
      if (providerResult.kind !== "verified") {
        return NextResponse.json(providerResponse);
      }
      const rail = await recommendationsForProvider(
        {
          provider: providerResult.identity.provider,
          title,
          mediaType: providerResult.identity.mediaType,
          externalId: providerResult.identity.externalId,
        },
        new Set(),
        12,
      );
      return NextResponse.json({
        ...providerResponse,
        moreLikeThis: (rail?.items ?? []).map(toSimilarLink),
      });
    }

    // A verified TMDB identity already names the exact work. A carried id is
    // still client-supplied and has not been matched to the selected title, so
    // never use it directly or replace it with a different title-search guess.
    const tmdbIdentity =
      providerResult.kind === "verified" &&
      providerResult.identity.provider === "tmdb"
        ? providerResult.identity
        : null;
    const exactTmdbId = tmdbIdentity
      ? Number.parseInt(tmdbIdentity.externalId, 10)
      : null;
    const ref =
      exactTmdbId != null && Number.isFinite(exactTmdbId)
        ? {
            id: exactTmdbId,
            mediaType:
              tmdbIdentity?.mediaType === "tv"
                ? ("tv" as const)
                : ("movie" as const),
          }
        : providerResult.kind === "absent"
          ? await resolveTmdbRef({ title, year, mediaType })
          : null;
    if (!ref) {
      const posterUrl = url.searchParams.get("poster");
      const [keylessTvResponse, animeRecommendations] = await Promise.all([
        tvmazeExtrasResponse(
          providerResult,
          empty,
          {
            workKey: key,
            title,
            year,
            posterUrl,
            isSeries:
              isSeriesMediaType(mediaType)
              || url.searchParams.get("series") === "1",
          },
        ),
        normalizeMediaType(mediaType) === "anime"
          ? fetchAniListRecommendationsForPoster(title, posterUrl).catch(() => [])
          : Promise.resolve([]),
      ]);
      const moreLikeThis = animeRecommendations.map((work) => {
        const recommendation: Recommendation = {
          provider: "anilist",
          sourceMediaType: "anime",
          mediaType: "anime",
          titleMediaType: work.isSeries ? "anime" : "movie",
          externalId: work.metadata.externalId,
          title: work.metadata.title,
          year: work.metadata.year ?? null,
          posterUrl: work.metadata.posterUrl ?? null,
          rating: work.metadata.rating ?? null,
          format: work.format,
          isSeries: work.isSeries,
        };
        return toSimilarLink(recommendation);
      });
      return NextResponse.json(
        {
          ...(keylessTvResponse ?? empty),
          moreLikeThis,
        },
      );
    }

    const series = ref.mediaType === "tv";

    // The season shape, the neighbours, the blurb, and (for movies only) the
    // home-release dates have no dependency on each other, so serialising them
    // would multiply the wait for no reason.
    const [shape, rail, blurb, homeRelease, facts] = await Promise.all([
      series ? fetchShowShape(ref.id) : Promise.resolve(null),
      recommendationsForProvider(
        {
          provider: "tmdb",
          title,
          mediaType: ref.mediaType,
          externalId: String(ref.id),
        },
        new Set(),
        12,
      ),
      fetchWorkBlurb(ref),
      // Home-release gating applies to movies only. Series episodes are already
      // gated individually via air dates (isUnaired in merge-extras.ts).
      series ? Promise.resolve(null) : fetchHomeRelease(ref.id),
      // Genres, vote count, certification, language — the hero's extra facts.
      // Its own content_ratings/release_dates call runs inside fetchTitleFacts,
      // parallelised there, so this stays one slot in the outer Promise.all.
      fetchTitleFacts(ref),
    ]);

    // Which season to describe: what the page asked for, else the first one
    // the provider admits to. Never season 0 — specials are not "season one".
    const wanted =
      season != null && season >= 1
        ? season
        : (shape?.seasons[0] ?? (series ? 1 : null));

    const fetchedEpisodes =
      series && wanted != null ? await fetchSeasonEpisodes(ref.id, wanted) : [];
    const episodes =
      fetchedEpisodes.length > 0
        ? fetchedEpisodes
        : providerEpisodePlaceholders(wanted, shape?.episodesBySeason);

    // A film is in its theatrical window when:
    //   1. It is a movie (series are never gated by this rule).
    //   2. The release_dates endpoint actually responded (checked).
    //   3. Its primary release date is in the past (theatrically released).
    //   4. No Digital/Physical/TV release date is in the past.
    //
    // If any of these is unknown, the gate stays open — false is the safe default.
    const today = new Date().toISOString().slice(0, 10);
    const primaryDate = blurb.releaseDate;
    const primaryInPast = primaryDate != null && primaryDate <= today;
    const inTheatricalWindow =
      !series &&
      primaryInPast &&
      homeRelease?.checked === true &&
      homeRelease.releasedAt === null;

    const payload: TitleExtrasPayload = {
      workKey: key,
      season: series ? wanted : null,
      seasonCount: shape?.seasonCount ?? null,
      seasons: shape?.seasons ?? [],
      episodes,
      moreLikeThis: (rail?.items ?? []).map(toSimilarLink),
      overview: blurb.overview,
      rating: blurb.rating,
      releaseDate: blurb.releaseDate,
      inTheatricalWindow,
      nextHomeReleaseAt: inTheatricalWindow ? (homeRelease?.nextHomeReleaseAt ?? null) : null,
      genres: facts.genres,
      voteCount: facts.voteCount,
      certification: facts.certification,
      originalLanguage: facts.originalLanguage,
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
function toSimilarLink(item: Recommendation): TitleSimilar {
  const normalized = normalizeMediaType(item.titleMediaType);
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
      provider: item.provider,
      providerId: item.externalId,
      sourceType: item.sourceMediaType,
      format: item.format,
      series: item.isSeries,
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
