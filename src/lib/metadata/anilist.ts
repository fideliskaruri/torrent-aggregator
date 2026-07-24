import type { MediaMetadata } from "@/lib/torrents/types";

const ANILIST_URL = "https://graphql.anilist.co";

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
      }
      genres
      format
    }
  }
}
`;

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
  startDate?: { year?: number | null };
  genres?: string[] | null;
}

/**
 * Search AniList for anime metadata matching a free-text query.
 */
export async function searchAniList(
  search: string,
  perPage = 5,
): Promise<MediaMetadata[]> {
  const res = await fetch(ANILIST_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      query: SEARCH_QUERY,
      variables: { search, perPage },
    }),
    signal: AbortSignal.timeout(10_000),
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

  const media = json.data?.Page?.media ?? [];
  return media.map(mapAniList);
}

export async function getAniListById(id: string): Promise<MediaMetadata | null> {
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
        startDate { year }
        genres
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
  return json.data?.Media ? mapAniList(json.data.Media) : null;
}

function mapAniList(m: AniListMedia): MediaMetadata {
  const title =
    m.title.english || m.title.romaji || m.title.native || `AniList #${m.id}`;

  return {
    source: "anilist",
    mediaType: "anime",
    externalId: String(m.id),
    title,
    posterUrl: m.coverImage?.extraLarge || m.coverImage?.large || null,
    backdropUrl: m.bannerImage || null,
    synopsis: stripHtml(m.description ?? null),
    rating: m.averageScore != null ? m.averageScore / 10 : null, // normalize ~0-10
    year: m.seasonYear ?? m.startDate?.year ?? null,
    genres: m.genres ?? [],
  };
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
