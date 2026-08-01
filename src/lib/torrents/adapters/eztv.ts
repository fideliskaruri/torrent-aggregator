import type {
  SearchOptions,
  TorrentResult,
  TorrentSourceAdapter,
} from "../types";
import { extractTags } from "../ranking";
import { fetchFromMirrors, mirrorList } from "./mirrors";
import {
  INDEXER_METADATA_TIMEOUT_MS,
  INDEXER_TIMEOUT_MS,
  indexerTimeoutSignal,
} from "./timeouts";

/**
 * EZTV — television only, no API key.
 *
 * This exists because TV coverage collapsed to a single working indexer:
 * The Pirate Bay's API now sits behind a Cloudflare challenge that a User-Agent
 * header cannot pass, and it was the main source of episode-level releases.
 * A search for "Family Guy S03" returned exactly one result.
 *
 * EZTV is deliberately awkward: its API filters by IMDb id and ignores a free
 * text `q` parameter entirely — passing `q=family guy` returns the site's
 * latest uploads, boxing included. So the show title is resolved to an IMDb id
 * through TMDB first, and episodes are filtered locally. That indirection is
 * the price of the only keyless TV-specific index still answering.
 *
 * Without a TMDB key this adapter returns nothing rather than erroring: it is
 * unconfigured, not down, and reporting an outage for a missing optional key
 * would be a lie in the source-health strip.
 */
const HOSTS = mirrorList(process.env.EZTV_BASE_URL, [
  "https://eztv.wf/api",
  "https://eztvx.to/api",
  "https://eztv.re/api",
]);

const TMDB_BASE = "https://api.themoviedb.org/3";

/** Strips episode/season/quality noise so TMDB is asked about the show. */
export function showTitleFromQuery(query: string): string {
  // Separators are normalised *first*. Scene names use dots for spaces, and
  // some go further ("S.W.A.T.S.05.E.10"), so stripping SxxEyy before the dots
  // are gone leaves the episode marker in the title TMDB is asked about.
  return query
    .replace(/[._]+/g, " ")
    .replace(/\b[Ss]\s?\d{1,3}\s*[Ee]\s?\d{1,4}\b.*$/, "")
    .replace(/\b[Ss]eason\s*\d{1,3}\b.*$/i, "")
    .replace(/\b[Ss]\s?\d{1,3}\b.*$/, "")
    .replace(/\b(1080p|720p|2160p|480p|complete|batch)\b.*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Season/episode the caller is hunting, if the query names one. */
export function episodeFromQuery(
  query: string,
): { season: number; episode?: number } | null {
  const normalized = query.replace(/[._]+/g, " ");
  const se = normalized.match(/\b[Ss]\s?(\d{1,3})\s*[Ee]\s?(\d{1,4})\b/);
  if (se) {
    return { season: parseInt(se[1], 10), episode: parseInt(se[2], 10) };
  }
  const s =
    normalized.match(/\b[Ss]eason\s*(\d{1,3})\b/i) ??
    normalized.match(/\b[Ss](\d{1,3})\b/);
  return s ? { season: parseInt(s[1], 10) } : null;
}

/** Comparable form of a title: case, punctuation and spacing all discarded. */
function normalizeTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

/**
 * Resolved IMDb ids, memoised for the process.
 *
 * Only *answers* are cached — never a transient TMDB failure. Caching a 429 or
 * a 500 as "this show has no IMDb id" would pin the show to zero EZTV results
 * until the process restarts, which is the same "an outage wearing the costume
 * of an empty result" bug this adapter was added to fix.
 */
const imdbCache = new Map<string, string | null>();

async function resolveImdbId(title: string): Promise<string | null> {
  const key = process.env.TMDB_API_KEY;
  if (!key || !title) return null;

  const cacheKey = title.toLowerCase();
  const cached = imdbCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const remember = (value: string | null) => {
    imdbCache.set(cacheKey, value);
    return value;
  };

  const searchUrl = new URL(`${TMDB_BASE}/search/tv`);
  searchUrl.searchParams.set("api_key", key);
  searchUrl.searchParams.set("query", title);
  const searchRes = await fetch(searchUrl, {
    signal: indexerTimeoutSignal(INDEXER_METADATA_TIMEOUT_MS),
    next: { revalidate: 86_400 },
  });
  // Not remembered: a bad response is about TMDB right now, not about the show.
  if (!searchRes.ok) return null;
  const searchJson = (await searchRes.json()) as {
    results?: { id: number; name?: string; original_name?: string }[];
  };

  // Taking results[0] blindly is not safe here. Every other adapter searches
  // free text, so its noise is at least title-relevant; EZTV is queried by id,
  // so a fuzzy TMDB match returns a *different show's* episodes under the right
  // episode number — and the automation runner selects on episode number, then
  // downloads. Common-word titles ("You", "It", "Alone") make that a live risk,
  // so only an exact name match is accepted.
  const wanted = normalizeTitle(title);
  const show = searchJson.results?.find(
    (r) =>
      normalizeTitle(r.name ?? "") === wanted ||
      normalizeTitle(r.original_name ?? "") === wanted,
  );
  if (!show) return remember(null);

  const idsUrl = new URL(`${TMDB_BASE}/tv/${show.id}/external_ids`);
  idsUrl.searchParams.set("api_key", key);
  const idsRes = await fetch(idsUrl, {
    signal: indexerTimeoutSignal(INDEXER_METADATA_TIMEOUT_MS),
    next: { revalidate: 86_400 },
  });
  if (!idsRes.ok) return null;
  const idsJson = (await idsRes.json()) as { imdb_id?: string | null };
  const imdb = idsJson.imdb_id?.trim();
  // EZTV wants the bare digits: tt0182576 → 0182576.
  return remember(imdb ? imdb.replace(/^tt/i, "") : null);
}

export class EztvAdapter implements TorrentSourceAdapter {
  readonly id = "eztv" as const;
  readonly name = "EZTV";

  async search(options: SearchOptions): Promise<TorrentResult[]> {
    const category = options.category ?? "all";
    // Anime is Nyaa's; EZTV carries western TV and would only add noise.
    if (category !== "all" && category !== "tv") return [];

    const q = options.query.trim();
    if (!q) return [];

    const imdbId = await resolveImdbId(showTitleFromQuery(q));
    if (!imdbId) return [];

    const res = await fetchFromMirrors({
      key: "eztv",
      hosts: HOSTS,
      path: (host) => `${host}/get-torrents?imdb_id=${imdbId}&limit=100&page=1`,
      init: {
        headers: {
          // EZTV's edge 403s a self-identifying agent, the same way apibay does.
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          Accept: "application/json",
        },
        next: { revalidate: 0 },
      },
      timeoutMs: INDEXER_TIMEOUT_MS,
    });

    if (!res.ok) throw new Error(`EZTV HTTP ${res.status}`);

    const json = (await res.json()) as { torrents?: EztvTorrent[] };
    const rows = json.torrents ?? [];

    const wanted = episodeFromQuery(q);
    const matches = wanted
      ? rows.filter((row) => {
          const season = Number(row.season);
          const episode = Number(row.episode);
          // EZTV leaves season/episode at 0 for packs and specials. When the
          // caller asked for a whole season rather than one episode, those are
          // exactly what it wants — dropping them was how a "Family Guy S03"
          // hunt whose only release is the season pack came back empty.
          const unnumbered =
            !Number.isFinite(season) || season === 0 || !row.season;
          if (unnumbered) return wanted.episode == null;
          if (season !== wanted.season) return false;
          if (wanted.episode == null) return true;
          return Number.isFinite(episode) && episode === wanted.episode;
        })
      : rows;

    return matches
      .slice(0, options.limit ?? 40)
      .map((row) => toResult(row))
      .filter((r): r is TorrentResult => r !== null);
  }
}

interface EztvTorrent {
  id?: number;
  hash?: string;
  filename?: string;
  title?: string;
  magnet_url?: string;
  episode_url?: string;
  seeds?: number;
  peers?: number;
  size_bytes?: string | number;
  date_released_unix?: number;
  season?: string | number;
  episode?: string | number;
}

function toResult(row: EztvTorrent): TorrentResult | null {
  const title = (row.title || row.filename || "").trim();
  const infoHash = row.hash?.toLowerCase();
  if (!title || !infoHash) return null;

  const sizeBytes = Number(row.size_bytes);

  return {
    id: `eztv-${row.id ?? infoHash}`,
    title,
    magnet: row.magnet_url || undefined,
    infoHash,
    sizeBytes: Number.isFinite(sizeBytes) && sizeBytes > 0 ? sizeBytes : 0,
    seeders: Number(row.seeds) || 0,
    leechers: Number(row.peers) || 0,
    category: "tv",
    source: "eztv",
    sourceUrl: row.episode_url || "https://eztv.wf",
    publishedAt: row.date_released_unix
      ? new Date(row.date_released_unix * 1000).toISOString()
      : null,
    tags: extractTags(title),
  };
}

export const eztvAdapter = new EztvAdapter();
