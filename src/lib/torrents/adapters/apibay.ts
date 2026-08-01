import type {
  SearchOptions,
  TorrentResult,
  TorrentSourceAdapter,
} from "../types";
import { extractTags } from "../ranking";
import { indexerTimeoutSignal } from "./timeouts";

const BASE = process.env.APIBAY_BASE_URL ?? "https://apibay.org";

/**
 * The Pirate Bay public JSON API (apibay.org) — no API key.
 */
export class ApiBayAdapter implements TorrentSourceAdapter {
  readonly id = "apibay" as const;
  readonly name = "ThePirateBay";

  async search(options: SearchOptions): Promise<TorrentResult[]> {
    const limit = options.limit ?? 40;
    const q = options.query.trim();
    if (!q) return [];

    const url = new URL(`${BASE}/q.php`);
    url.searchParams.set("q", q);
    url.searchParams.set("cat", categoryToApibay(options.category));

    const res = await fetch(url, {
      headers: {
        // apibay's edge returns 403 to anything that does not look like a
        // browser — a self-identifying agent gets the whole source blocked,
        // which reads as "no results" rather than an outage.
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Accept: "application/json, text/plain, */*",
      },
      signal: indexerTimeoutSignal(),
      next: { revalidate: 0 },
    });

    if (!res.ok) {
      throw new Error(`apibay HTTP ${res.status}`);
    }

    const data = (await res.json()) as ApibayRow[];
    if (!Array.isArray(data) || data.length === 0) return [];

    // apibay returns a dummy row when empty
    if (data.length === 1 && data[0].id === "0" && data[0].name === "No results returned") {
      return [];
    }

    return data.slice(0, limit).map((row, index) => toResult(row, index));
  }
}

interface ApibayRow {
  id: string;
  name: string;
  info_hash: string;
  leechers: string;
  seeders: string;
  size: string;
  username?: string;
  added?: string;
  category?: string;
  status?: string;
}

function categoryToApibay(category?: string): string {
  switch (category) {
    case "movies":
      return "201";
    case "tv":
      return "205";
    case "music":
      return "101";
    case "games":
      return "401";
    case "apps":
      return "301";
    // 601 is E-books. Audiobooks live under Audio (102) and comics under 602,
    // so a books search that pinned 601 would drop two of the three things the
    // owner means by "books". `0` searches everything and lets ranking and the
    // title itself sort it out, which measurably returns ebooks, audiobooks and
    // comics together.
    case "books":
      return "0";
    case "anime":
      return "0"; // no dedicated anime cat that maps cleanly
    default:
      return "0";
  }
}

function toResult(row: ApibayRow, index: number): TorrentResult {
  const infoHash = row.info_hash?.toLowerCase();
  const seeders = parseInt(row.seeders ?? "0", 10) || 0;
  const leechers = parseInt(row.leechers ?? "0", 10) || 0;
  const sizeBytes = parseInt(row.size ?? "0", 10) || null;
  const addedSec = parseInt(row.added ?? "", 10);
  const publishedAt =
    !Number.isNaN(addedSec) && addedSec > 0
      ? new Date(addedSec * 1000).toISOString()
      : null;

  const magnet = infoHash
    ? `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(row.name)}&tr=udp://tracker.opentrackr.org:1337/announce`
    : undefined;

  return {
    id: `apibay-${row.id || infoHash || index}`,
    title: row.name,
    magnet,
    infoHash,
    sizeBytes,
    seeders,
    leechers,
    category: row.category,
    source: "apibay",
    sourceUrl: `https://thepiratebay.org/description.php?id=${row.id}`,
    publishedAt,
    tags: extractTags(row.name),
  };
}

export const apibayAdapter = new ApiBayAdapter();
