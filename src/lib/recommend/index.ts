/**
 * "Because you're watching X" — one rail, from the catalogs' own
 * recommendations.
 *
 * There is deliberately no recommender here. TMDB's `/recommendations` is
 * behavioural (people who watched this watched that) and is already better than
 * anything that could be built over a five-row library. Its neighbour
 * `/similar` is a genre-vector match and is not usable: it returns 320,032
 * films "similar" to Oppenheimer, led by titles nobody has heard of. AniList
 * exposes a community-voted equivalent.
 *
 * One seed, one rail. A blended rank across several seeds is degenerate at this
 * library size — every candidate would have exactly one vote — and per-seed
 * provenance is the only thing that makes a suggestion explicable.
 */
import type { MediaMetadata } from "@/lib/torrents/types";
import { normalizeMediaType } from "@/lib/metadata/media-type";
import {
  applyTmdbCredential,
  tmdbApiKey,
} from "@/lib/metadata/tmdb";

/** A day. These lists move on the scale of weeks. */
const REVALIDATE_SECONDS = 86_400;
const POSITIVE_TTL_MS = 6 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 2 * 60 * 1000;
const MAX_CACHE_ENTRIES = 400;

const TMDB_BASE = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p/w342";
const ANILIST_URL = "https://graphql.anilist.co";
const ANILIST_RECOMMENDATIONS_URL =
  `${ANILIST_URL}?operation=recommendations`;

export type Recommendation = {
  provider: "anilist" | "tmdb";
  sourceMediaType: "anime" | "movie" | "tv";
  /** Provider/library family. AniList movies remain anime identities. */
  mediaType: MediaMetadata["mediaType"];
  /** Shape consumed by the title route. */
  titleMediaType: MediaMetadata["mediaType"];
  externalId: string;
  title: string;
  posterUrl: string | null;
  year: number | null;
  rating: number | null;
  format: string | null;
  isSeries: boolean;
};

export type RecommendationRail = {
  /** The library title this rail is explained by. */
  seedTitle: string;
  items: Recommendation[];
};

const ANILIST_QUERY = `
query ($id: Int) {
  Media(id: $id, type: ANIME) {
    recommendations(sort: RATING_DESC, perPage: 12) {
      nodes {
        mediaRecommendation {
          id
          title { romaji english }
          coverImage { large }
          startDate { year }
          averageScore
          format
        }
      }
    }
  }
}
`;

type AniListRecommended = {
  id?: number;
  title?: { romaji?: string | null; english?: string | null };
  coverImage?: { large?: string | null };
  startDate?: { year?: number | null };
  averageScore?: number | null;
  format?: string | null;
};

const ANILIST_FORMATS = new Set([
  "TV",
  "TV_SHORT",
  "MOVIE",
  "SPECIAL",
  "OVA",
  "ONA",
  "MUSIC",
]);

async function fromAniList(id: string): Promise<Recommendation[]> {
  const res = await fetch(ANILIST_RECOMMENDATIONS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query: ANILIST_QUERY, variables: { id: Number(id) } }),
    signal: AbortSignal.timeout(10_000),
    next: { revalidate: REVALIDATE_SECONDS },
  });
  if (!res.ok) return [];

  const json = (await res.json()) as {
    data?: {
      Media?: {
        recommendations?: {
          nodes?: { mediaRecommendation?: AniListRecommended | null }[];
        };
      };
    };
  };

  return (json.data?.Media?.recommendations?.nodes ?? [])
    .map((n) => n.mediaRecommendation)
    .filter((m): m is AniListRecommended => Boolean(m?.id))
    .filter(
      (m): m is AniListRecommended & { format: string } =>
        Boolean(m.format && ANILIST_FORMATS.has(m.format)),
    )
    .map((m) => {
      const isSeries = m.format !== "MOVIE";
      return {
        provider: "anilist" as const,
        sourceMediaType: "anime" as const,
        mediaType: "anime" as const,
        titleMediaType: isSeries ? ("anime" as const) : ("movie" as const),
        externalId: String(m.id),
        title: m.title?.english || m.title?.romaji || "",
        posterUrl: m.coverImage?.large ?? null,
        year: m.startDate?.year ?? null,
        rating:
          typeof m.averageScore === "number"
            ? Math.round(m.averageScore) / 10
            : null,
        format: m.format ?? null,
        isSeries,
      };
    })
    .filter((r) => r.title);
}

type TmdbResult = {
  id?: number;
  title?: string;
  name?: string;
  poster_path?: string | null;
  release_date?: string;
  first_air_date?: string;
  vote_average?: number | null;
  vote_count?: number | null;
};

type TmdbCacheEntry = {
  at: number;
  ttl: number;
  value: Recommendation[];
};

const tmdbCache = new Map<string, TmdbCacheEntry>();

export function resetRecommendationCache(): void {
  tmdbCache.clear();
}

async function fromTmdb(
  mediaType: "tv" | "movie",
  id: string,
): Promise<Recommendation[]> {
  const key = tmdbApiKey();
  if (!key) return [];

  const cacheKey = `${mediaType}:${id}`;
  const cached = tmdbCache.get(cacheKey);
  if (cached && Date.now() - cached.at < cached.ttl) {
    return cached.value;
  }

  const url = new URL(`${TMDB_BASE}/${mediaType}/${id}/recommendations`);
  const headers = applyTmdbCredential(url, key);
  url.searchParams.set("language", "en-US");
  url.searchParams.set("page", "1");

  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`TMDB recommendations HTTP ${res.status}`);
  }

  const json = (await res.json()) as { results?: TmdbResult[] };

  const recommendations = (json.results ?? [])
    .filter((r) => r.id != null)
    .map((r) => {
      const date = r.release_date || r.first_air_date || "";
      return {
        provider: "tmdb" as const,
        sourceMediaType: mediaType,
        mediaType,
        titleMediaType: mediaType,
        externalId: String(r.id),
        title: r.title || r.name || "",
        posterUrl: r.poster_path ? `${IMG}${r.poster_path}` : null,
        year: date ? Number(date.slice(0, 4)) || null : null,
        rating:
          typeof r.vote_average === "number" &&
          r.vote_average > 0 &&
          (r.vote_count ?? 0) >= 20
            ? Math.round(r.vote_average * 10) / 10
            : null,
        format: null,
        isSeries: mediaType === "tv",
      };
    })
    .filter((r) => r.title);

  if (tmdbCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = tmdbCache.keys().next();
    if (!oldest.done) tmdbCache.delete(oldest.value);
  }
  tmdbCache.set(cacheKey, {
    at: Date.now(),
    ttl: recommendations.length > 0 ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS,
    value: recommendations,
  });

  return recommendations;
}

/** `mediaType:externalId`, the key a rail excludes on. */
export function libraryKey(item: {
  mediaType: string;
  externalId: string;
}): string {
  return `${normalizeMediaType(item.mediaType) ?? item.mediaType}:${item.externalId}`;
}

/**
 * Builds the rail for one library row.
 *
 * Returns null rather than an empty rail whenever anything is missing — a
 * placeholder id, a catalog outage, nothing left after exclusions. An empty
 * shelf is worse than no shelf: it reads as "there is nothing for you" when the
 * truth is "we could not ask".
 */
export async function recommendationsFor(
  seed: { title: string; mediaType: string; externalId: string },
  exclude: ReadonlySet<string>,
  limit = 6,
): Promise<RecommendationRail | null> {
  const mediaType = normalizeMediaType(seed.mediaType);
  return recommendationsForProvider(
    {
      ...seed,
      mediaType: mediaType ?? seed.mediaType,
      provider: mediaType === "anime" ? "anilist" : "tmdb",
    },
    exclude,
    limit,
  );
}

export async function recommendationsForProvider(
  seed: {
    provider: "anilist" | "tmdb";
    title: string;
    mediaType: string;
    externalId: string;
  },
  exclude: ReadonlySet<string>,
  limit = 6,
): Promise<RecommendationRail | null> {
  // Placeholder ids from the demo seeder cannot be looked up at all.
  if (!/^\d+$/.test(seed.externalId)) return null;

  const mediaType = normalizeMediaType(seed.mediaType);
  let found: Recommendation[];
  try {
    found =
      seed.provider === "anilist"
        ? await fromAniList(seed.externalId)
        : mediaType === "tv" || mediaType === "movie"
          ? await fromTmdb(mediaType, seed.externalId)
          : [];
  } catch (error) {
    console.error(
      `[recommend] ${seed.provider} recommendations failed for ${seed.externalId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }

  const seen = new Set<string>();
  const items = found
    // A card is a poster the user might recognise. Without one it is a grey
    // rectangle, which is worse than one fewer suggestion.
    .filter((r) => Boolean(r.posterUrl))
    .filter((r) => {
      const key = libraryKey(r);
      if (exclude.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);

  return items.length > 0 ? { seedTitle: seed.title, items } : null;
}
