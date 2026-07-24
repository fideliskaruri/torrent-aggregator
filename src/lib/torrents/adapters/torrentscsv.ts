import type {
  SearchOptions,
  TorrentResult,
  TorrentSourceAdapter,
} from "../types";
import { extractTags } from "../ranking";

const BASE =
  process.env.TORRENTS_CSV_BASE_URL ?? "https://torrents-csv.com/service/search";

/**
 * Torrents-CSV public search API — no API key.
 */
export class TorrentsCsvAdapter implements TorrentSourceAdapter {
  readonly id = "torrentscsv" as const;
  readonly name = "TorrentsCSV";

  async search(options: SearchOptions): Promise<TorrentResult[]> {
    const limit = Math.min(options.limit ?? 40, 50);
    const q = options.query.trim();
    if (!q) return [];

    const url = new URL(BASE);
    url.searchParams.set("q", q);
    url.searchParams.set("size", String(limit));

    const res = await fetch(url, {
      headers: {
        "User-Agent": "TorrentFlow/1.0",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(12_000),
      next: { revalidate: 0 },
    });

    if (!res.ok) {
      throw new Error(`torrents-csv HTTP ${res.status}`);
    }

    const data = (await res.json()) as {
      torrents?: CsvTorrent[];
    };

    return (data.torrents ?? []).slice(0, limit).map((row, index) =>
      toResult(row, index),
    );
  }
}

interface CsvTorrent {
  infohash: string;
  name: string;
  size_bytes?: number;
  created_unix?: number;
  seeders?: number;
  leechers?: number;
  completed?: number;
  id?: number;
}

function toResult(row: CsvTorrent, index: number): TorrentResult {
  const infoHash = row.infohash?.toLowerCase();
  const magnet = infoHash
    ? `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(row.name)}`
    : undefined;

  return {
    id: `torrentscsv-${row.id ?? infoHash ?? index}`,
    title: row.name,
    magnet,
    infoHash,
    sizeBytes: row.size_bytes ?? null,
    seeders: row.seeders ?? 0,
    leechers: row.leechers ?? 0,
    completed: row.completed,
    source: "torrentscsv",
    sourceUrl: `https://torrents-csv.com/#/search/torrent/${encodeURIComponent(row.name)}/1`,
    publishedAt: row.created_unix
      ? new Date(row.created_unix * 1000).toISOString()
      : null,
    tags: extractTags(row.name),
  };
}

export const torrentsCsvAdapter = new TorrentsCsvAdapter();
