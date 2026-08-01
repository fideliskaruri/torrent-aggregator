import type {
  SearchOptions,
  TorrentResult,
  TorrentSourceAdapter,
} from "../types";
import { extractTags } from "../ranking";
import { fetchFromMirrors, mirrorList } from "./mirrors";
import { INDEXER_TIMEOUT_MS } from "./timeouts";

/**
 * `yts.mx` is the canonical host and is tried first, but it stopped resolving
 * from at least one network while `yts.lt` and the `movies-api.accel.li` host
 * named in YTS's own API response both answered. One dead hostname used to take
 * the entire movie source offline silently.
 */
const HOSTS = mirrorList(process.env.YTS_BASE_URL, [
  "https://yts.mx/api/v2",
  "https://yts.lt/api/v2",
  "https://movies-api.accel.li/api/v2",
]);

/**
 * YTS public JSON API — movies only, no API key.
 */
export class YtsAdapter implements TorrentSourceAdapter {
  readonly id = "yts" as const;
  readonly name = "YTS";

  async search(options: SearchOptions): Promise<TorrentResult[]> {
    const category = options.category ?? "all";
    if (category !== "all" && category !== "movies") {
      return [];
    }

    const q = options.query.trim();
    if (!q) return [];

    const query = new URLSearchParams({
      query_term: q,
      limit: String(Math.min(options.limit ?? 20, 50)),
      sort_by: "seeds",
    });

    const res = await fetchFromMirrors({
      key: "yts",
      hosts: HOSTS,
      path: (host) => `${host}/list_movies.json?${query}`,
      init: {
        headers: { Accept: "application/json", "User-Agent": "TorrentFlow/1.0" },
        next: { revalidate: 0 },
      },
      timeoutMs: INDEXER_TIMEOUT_MS,
    });

    if (!res.ok) {
      throw new Error(`YTS HTTP ${res.status}`);
    }

    const json = (await res.json()) as {
      data?: { movies?: YtsMovie[] };
    };

    const movies = json.data?.movies ?? [];
    const results: TorrentResult[] = [];

    for (const movie of movies) {
      for (const t of movie.torrents ?? []) {
        const infoHash = t.hash?.toLowerCase();
        const title = `${movie.title_long || movie.title} [${t.quality}] [${t.type}] [YTS]`;
        const magnet = infoHash
          ? `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}&tr=udp://tracker.opentrackr.org:1337/announce`
          : undefined;

        results.push({
          id: `yts-${movie.id}-${t.hash ?? t.quality}`,
          title,
          magnet,
          infoHash,
          sizeBytes: parseYtsSize(t.size),
          sizeLabel: t.size,
          seeders: t.seeds ?? 0,
          leechers: t.peers ?? 0,
          category: "movies",
          source: "yts",
          sourceUrl: movie.url || `https://yts.mx/movies/${movie.slug}`,
          publishedAt: t.date_uploaded
            ? new Date(t.date_uploaded).toISOString()
            : null,
          tags: extractTags(title),
          metadata: movie.medium_cover_image
            ? {
                source: "tmdb",
                mediaType: "movie",
                externalId: String(movie.imdb_code || movie.id),
                title: movie.title,
                posterUrl: movie.medium_cover_image,
                synopsis: movie.summary || movie.description_full || null,
                rating: movie.rating ?? null,
                year: movie.year ?? null,
                genres: movie.genres ?? [],
              }
            : undefined,
        });
      }
    }

    // YTS returns fuzzy title matches, and one movie can carry eight torrents.
    // Truncating in API order therefore drops on relevance-by-accident: an
    // unrelated film matched first can eat the whole budget while the actual
    // match's only well-seeded release is cut. Keep the viable ones.
    results.sort((a, b) => b.seeders - a.seeders);

    return results.slice(0, options.limit ?? 40);
  }
}

interface YtsMovie {
  id: number;
  url?: string;
  title: string;
  title_long?: string;
  slug?: string;
  year?: number;
  rating?: number;
  summary?: string;
  description_full?: string;
  imdb_code?: string;
  medium_cover_image?: string;
  genres?: string[];
  torrents?: {
    hash?: string;
    quality?: string;
    type?: string;
    size?: string;
    seeds?: number;
    peers?: number;
    date_uploaded?: string;
  }[];
}

function parseYtsSize(size?: string): number | null {
  if (!size) return null;
  const m = size.trim().match(/^([\d.]+)\s*(GB|MB|KB)$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const u = m[2].toUpperCase();
  if (u === "GB") return Math.round(n * 1e9);
  if (u === "MB") return Math.round(n * 1e6);
  if (u === "KB") return Math.round(n * 1e3);
  return null;
}

export const ytsAdapter = new YtsAdapter();
