/**
 * Where a brand-new install gets something to look at.
 *
 * Every rail this app had was *personal* — Continue Watching, Ready to Play,
 * Next Up, My Library, Recently Added — so a fresh install had literally
 * nothing to render, and the home page filled the hole with an essay about
 * what it would become. A catalog page that explains itself is not a catalog.
 *
 * These feeds are the cheapest honest source of "what people are actually
 * watching right now": apibay publishes its top-100 lists as static JSON, one
 * file per category, no key, no query, no rate limit worth worrying about.
 * They are a *popularity* signal, not a catalog — which is exactly what a
 * "Trending now" row is.
 *
 * ## Why this is not `ApiBayAdapter`
 *
 * `src/lib/torrents/adapters/apibay.ts` speaks to the same host, and the env
 * var and browser User-Agent below are deliberately the same as its own (its
 * edge returns 403 to anything that self-identifies as a bot, which reads
 * downstream as "no results" rather than as an outage). But the adapter
 * implements `TorrentSourceAdapter.search` — a *query* against `q.php` that
 * returns ranked `TorrentResult`s for the search pipeline. There is no query
 * here and no ranking to do; these are precompiled files. The adapter exposes
 * no lower-level client to reuse, and it is not this module's to change, so the
 * two share the configuration surface and nothing else.
 */
import type { MediaType } from "@/lib/metadata/media-type";

/** Same env var the search adapter reads, so one override moves both. */
const BASE = process.env.APIBAY_BASE_URL ?? "https://apibay.org";

/**
 * Long enough for a slow corporate proxy, short enough that a cold start does
 * not out-wait a user's patience. Every call site treats a timeout as "no data
 * from this feed", never as an error worth failing the page over.
 */
const FEED_TIMEOUT_MS = 8_000;

/** apibay's edge 403s anything that self-identifies. See the module header. */
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

/** The `source` values `CatalogEntry` accepts. */
export type CatalogSource = "trending" | "popular" | "related";

/**
 * One precompiled top-100 list.
 *
 * `mediaType` is what the *category* asserts, and it is the only media-type
 * evidence a feed carries. It is a `MediaType` at the type level so it can
 * never drift from `src/lib/metadata/media-type.ts`'s vocabulary, and it is
 * still normalised at the point of use.
 */
export interface CatalogFeed {
  id: string;
  /** apibay category code. */
  category: number;
  /** Human label, for logs. */
  label: string;
  mediaType: MediaType;
  /** Which `CatalogEntry.source` the works from this feed belong to. */
  source: CatalogSource;
}

/**
 * The feeds worth reading, and only those.
 *
 * Categories 201 ("Movies") and 202 ("Movies DVDR") were probed and are alive
 * but stale — 201's top entry is a 2021 award compilation with a single seeder
 * — so they would fill a row headed "Trending now" with things nobody is
 * watching. 207 (HD Movies), 208 (HD TV) and 205 (TV) are current: probed the
 * same minute, they returned this week's releases with five-figure swarms.
 *
 * 205 and 208 are both read and *merged*: they carry the same shows at
 * different resolutions, and a work's popularity is the sum of its releases —
 * counting only one of the two would rank a show by half its audience.
 */
export const CATALOG_FEEDS: readonly CatalogFeed[] = [
  { id: "movies-hd", category: 207, label: "HD Movies", mediaType: "movie", source: "trending" },
  { id: "tv-hd", category: 208, label: "HD TV", mediaType: "tv", source: "popular" },
  { id: "tv", category: 205, label: "TV", mediaType: "tv", source: "popular" },
] as const;

/** One release as the feed states it. Nothing derived, nothing guessed. */
export interface FeedRelease {
  name: string;
  seeders: number;
  leechers: number;
  infoHash: string | null;
  sizeBytes: number | null;
}

/**
 * The outcome of reading one feed.
 *
 * `releases: []` with `error: null` and `releases: []` with an error are
 * different states and are kept apart all the way to the caller — the same
 * distinction the rest of this app enforces between "empty" and "broken". A
 * refresh that reached nothing must not look like a refresh that found nothing.
 */
export interface FeedResult {
  feed: CatalogFeed;
  releases: FeedRelease[];
  error: string | null;
}

interface ApibayRow {
  id?: number | string;
  name?: string;
  info_hash?: string;
  seeders?: number | string;
  leechers?: number | string;
  size?: number | string;
  category?: number | string;
}

function toInt(value: number | string | undefined): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Parse a feed body into releases. Exported for tests: the shape apibay
 * actually returns is the thing most likely to change under us.
 */
export function parseFeedBody(data: unknown): FeedRelease[] {
  if (!Array.isArray(data)) return [];
  const releases: FeedRelease[] = [];
  for (const raw of data as ApibayRow[]) {
    const name = typeof raw?.name === "string" ? raw.name.trim() : "";
    if (!name) continue;
    // apibay answers an empty list with one placeholder row rather than `[]`.
    if (name === "No results returned") continue;
    const infoHash =
      typeof raw.info_hash === "string" && raw.info_hash.trim()
        ? raw.info_hash.trim().toLowerCase()
        : null;
    releases.push({
      name,
      seeders: toInt(raw.seeders),
      leechers: toInt(raw.leechers),
      infoHash,
      sizeBytes: toInt(raw.size) || null,
    });
  }
  return releases;
}

/**
 * Read one precompiled feed. Never throws.
 *
 * A dead network, a proxy that swallows the request, a 503 from the edge and a
 * body that is not JSON all land in `error`, because none of them is a reason
 * for the home page to fail — there is a cache behind this, and an honest
 * error state behind that.
 */
export async function fetchFeed(feed: CatalogFeed): Promise<FeedResult> {
  const url = `${BASE}/precompiled/data_top100_${feed.category}.json`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "application/json, text/plain, */*",
      },
      signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) {
      return { feed, releases: [], error: `apibay HTTP ${res.status}` };
    }

    const data: unknown = await res.json();
    if (!Array.isArray(data)) {
      return { feed, releases: [], error: "apibay returned a non-list body" };
    }

    return { feed, releases: parseFeedBody(data), error: null };
  } catch (err) {
    return {
      feed,
      releases: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Read every feed concurrently. Never throws; a slow feed cannot block a fast one. */
export async function fetchAllFeeds(
  feeds: readonly CatalogFeed[] = CATALOG_FEEDS,
): Promise<FeedResult[]> {
  return Promise.all(feeds.map((feed) => fetchFeed(feed)));
}
