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

/** A day. These lists move on the scale of weeks. */
const REVALIDATE_SECONDS = 86_400;

const TMDB_BASE = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p/w342";
const ANILIST_URL = "https://graphql.anilist.co";

export type Recommendation = {
  mediaType: MediaMetadata["mediaType"];
  externalId: string;
  title: string;
  posterUrl: string | null;
  year: number | null;
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
};

async function fromAniList(id: string): Promise<Recommendation[]> {
  const res = await fetch(ANILIST_URL, {
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
    .map((m) => ({
      mediaType: "anime" as const,
      externalId: String(m.id),
      title: m.title?.english || m.title?.romaji || "",
      posterUrl: m.coverImage?.large ?? null,
      year: m.startDate?.year ?? null,
    }))
    .filter((r) => r.title);
}

type TmdbResult = {
  id?: number;
  title?: string;
  name?: string;
  poster_path?: string | null;
  release_date?: string;
  first_air_date?: string;
};

async function fromTmdb(
  mediaType: "tv" | "movie",
  id: string,
): Promise<Recommendation[]> {
  const key = process.env.TMDB_API_KEY;
  if (!key) return [];

  const url = new URL(`${TMDB_BASE}/${mediaType}/${id}/recommendations`);
  url.searchParams.set("api_key", key);
  url.searchParams.set("language", "en-US");
  url.searchParams.set("page", "1");

  const res = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    next: { revalidate: REVALIDATE_SECONDS },
  });
  if (!res.ok) return [];

  const json = (await res.json()) as { results?: TmdbResult[] };

  return (json.results ?? [])
    .filter((r) => r.id != null)
    .map((r) => {
      const date = r.release_date || r.first_air_date || "";
      return {
        mediaType,
        externalId: String(r.id),
        title: r.title || r.name || "",
        posterUrl: r.poster_path ? `${IMG}${r.poster_path}` : null,
        year: date ? Number(date.slice(0, 4)) || null : null,
      };
    })
    .filter((r) => r.title);
}

/** `mediaType:externalId`, the key a rail excludes on. */
export function libraryKey(item: {
  mediaType: string;
  externalId: string;
}): string {
  return `${item.mediaType}:${item.externalId}`;
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
  // Placeholder ids from the demo seeder cannot be looked up at all.
  if (!/^\d+$/.test(seed.externalId)) return null;

  let found: Recommendation[];
  try {
    found =
      seed.mediaType === "anime"
        ? await fromAniList(seed.externalId)
        : seed.mediaType === "tv" || seed.mediaType === "movie"
          ? await fromTmdb(seed.mediaType, seed.externalId)
          : [];
  } catch {
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
