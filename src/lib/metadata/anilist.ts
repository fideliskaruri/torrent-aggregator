import type { MediaMetadata } from "@/lib/torrents/types";
import {
  canonicalizeSearchQuery,
  searchDiscoveryVariants,
} from "@/lib/search/query-variants";

const ANILIST_URL = "https://graphql.anilist.co";

function isSearchDeadlineError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

const SEARCH_QUERY = `
query ($search: String, $perPage: Int) {
  Page(page: 1, perPage: $perPage) {
    media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
      id
      title {
        romaji
        english
        native
      }
      coverImage {
        large
        extraLarge
      }
      bannerImage
      description(asHtml: false)
      averageScore
      seasonYear
      startDate {
        year
        month
        day
      }
      genres
      format
      episodes
      nextAiringEpisode {
        episode
      }
    }
  }
}
`;

export type AniListFormat =
  | "TV"
  | "TV_SHORT"
  | "MOVIE"
  | "SPECIAL"
  | "OVA"
  | "ONA"
  | "MUSIC";

interface AniListMedia {
  id: number;
  title: {
    romaji?: string | null;
    english?: string | null;
    native?: string | null;
  };
  coverImage?: { large?: string | null; extraLarge?: string | null };
  bannerImage?: string | null;
  description?: string | null;
  averageScore?: number | null;
  seasonYear?: number | null;
  startDate?: { year?: number | null; month?: number | null; day?: number | null };
  genres?: string[] | null;
  format?: AniListFormat | null;
  /** Total episode count when AniList knows it; null while a show is airing. */
  episodes?: number | null;
  /** The next episode due to air — `episode` is the *upcoming* number. */
  nextAiringEpisode?: { episode?: number | null } | null;
}

export interface AniListWork {
  metadata: MediaMetadata;
  format: AniListFormat | null;
  isSeries: boolean;
  /**
   * How many episodes this AniList work honestly has, or null when AniList
   * does not say. Never guessed: a finished series reports `episodes`, an
   * airing one reports only what has already aired (`nextAiringEpisode` minus
   * the episode still to come). Anything else stays null so the title page
   * shows no episode list rather than an invented one.
   */
  episodeCount: number | null;
}

/** Largest episode count AniList could plausibly report for one work. */
const MAX_ANILIST_EPISODES = 5000;

/**
 * The honest episode count for an AniList work.
 *
 * `episodes` is authoritative when present. While a series is still airing it
 * is null, and the only truthful number available is how many episodes have
 * already aired — `nextAiringEpisode.episode - 1`. Neither value is ever
 * extrapolated, and an implausible number is treated as no answer at all.
 */
export function anilistEpisodeCount(
  media: Pick<AniListMedia, "episodes" | "nextAiringEpisode">,
): number | null {
  const total = media.episodes;
  if (isPlausibleEpisodeCount(total)) return total;

  const next = media.nextAiringEpisode?.episode;
  if (typeof next === "number" && Number.isInteger(next) && next > 1) {
    const aired = next - 1;
    if (isPlausibleEpisodeCount(aired)) return aired;
  }
  return null;
}

function isPlausibleEpisodeCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_ANILIST_EPISODES
  );
}

/**
 * Search AniList for anime metadata matching a free-text query.
 */
export async function searchAniList(
  search: string,
  perPage = 5,
): Promise<MediaMetadata[]> {
  const media = await fetchAniListMedia(search, perPage);
  return media.map(mapAniList);
}

/** AniList work discovery with the format needed to distinguish films from series. */
export async function searchAniListWorks(
  search: string,
  perPage = 12,
): Promise<AniListWork[]> {
  const media = await fetchAniListMedia(search, perPage);
  return media.map((item) => ({
    metadata: mapAniList(item),
    format: item.format ?? null,
    isSeries: isAniListSeriesFormat(item.format),
    episodeCount: anilistEpisodeCount(item),
  }));
}

export function isAniListSeriesFormat(
  format: AniListFormat | null | undefined,
): boolean {
  return format !== "MOVIE";
}

async function fetchAniListMedia(
  search: string,
  perPage: number,
): Promise<AniListMedia[]> {
  const term = canonicalizeSearchQuery(search);
  if (!term) return [];
  const deadline = Date.now() + 10_000;

  const runQuery = async (query: string): Promise<AniListMedia[]> => {
    const res = await fetch(ANILIST_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        query: SEARCH_QUERY,
        variables: { search: query, perPage },
      }),
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      next: { revalidate: 3600 },
    });

    if (!res.ok) {
      throw new Error(`AniList HTTP ${res.status}`);
    }

    const json = (await res.json()) as {
      data?: { Page?: { media?: AniListMedia[] } };
      errors?: { message: string }[];
    };

    if (json.errors?.length) {
      throw new Error(json.errors[0].message);
    }

    return json.data?.Page?.media ?? [];
  };

  const primary = await runQuery(term);
  if (primary.length > 0) return primary;
  for (const variant of searchDiscoveryVariants(term)) {
    if (variant.toLowerCase() === term.toLowerCase()) continue;
    if (Date.now() >= deadline) break;
    try {
      const media = await runQuery(variant);
      if (media.length > 0) return media;
    } catch (error) {
      if (isSearchDeadlineError(error)) break;
      throw error;
    }
  }
  return primary;
}

export async function getAniListWorkById(id: string): Promise<AniListWork | null> {
  const query = `
    query ($id: Int) {
      Media(id: $id, type: ANIME) {
        id
        title { romaji english native }
        coverImage { large extraLarge }
        bannerImage
        description(asHtml: false)
        averageScore
        seasonYear
        startDate { year month day }
        genres
        format
        episodes
        nextAiringEpisode { episode }
      }
    }
  `;

  const res = await fetch(ANILIST_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables: { id: parseInt(id, 10) } }),
    signal: AbortSignal.timeout(10_000),
    next: { revalidate: 3600 },
  });

  if (!res.ok) return null;
  const json = (await res.json()) as { data?: { Media?: AniListMedia } };
  const media = json.data?.Media;
  return media
    ? {
        metadata: mapAniList(media),
        format: media.format ?? null,
        isSeries: isAniListSeriesFormat(media.format),
        episodeCount: anilistEpisodeCount(media),
      }
    : null;
}

export async function getAniListById(id: string): Promise<MediaMetadata | null> {
  return (await getAniListWorkById(id))?.metadata ?? null;
}

function mapAniList(m: AniListMedia): MediaMetadata {
  const title =
    m.title.english || m.title.romaji || m.title.native || `AniList #${m.id}`;
  const aliases = [...new Set(
    [m.title.english, m.title.romaji, m.title.native]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value)),
  )];

  return {
    source: "anilist",
    mediaType: "anime",
    externalId: String(m.id),
    title,
    aliases,
    posterUrl: m.coverImage?.extraLarge || m.coverImage?.large || null,
    backdropUrl: m.bannerImage || null,
    synopsis: stripHtml(m.description ?? null),
    rating: m.averageScore != null ? m.averageScore / 10 : null, // normalize ~0-10
    year: m.seasonYear ?? m.startDate?.year ?? null,
    releaseDate: anilistStartDate(m.startDate),
    genres: m.genres ?? [],
  };
}

/**
 * AniList's `startDate` composed into a stored `YYYY-MM-DD`, or null.
 *
 * AniList reports the parts separately and any of them can be missing on an
 * announced-but-undated series. A full year+month+day composes exactly; a
 * year alone degrades to `YYYY-01-01` — the placeholder release-status.ts
 * renders as "Coming {year}". No year at all is null, which is never gated;
 * nothing is ever fabricated.
 */
export function anilistStartDate(
  startDate: { year?: number | null; month?: number | null; day?: number | null } | null | undefined,
): string | null {
  const year = startDate?.year;
  if (typeof year !== "number" || !(year > 1800 && year < 2200)) return null;

  const month = startDate?.month;
  const day = startDate?.day;
  if (
    typeof month === "number" && month >= 1 && month <= 12 &&
    typeof day === "number" && day >= 1 && day <= 31
  ) {
    return `${pad4(year)}-${pad2(month)}-${pad2(day)}`;
  }
  return `${pad4(year)}-01-01`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function pad4(n: number): string {
  return String(n).padStart(4, "0");
}

function stripHtml(html: string | null): string | null {
  if (!html) return null;
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}