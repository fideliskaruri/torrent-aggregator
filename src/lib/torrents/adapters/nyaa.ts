import type {
  SearchOptions,
  TorrentResult,
  TorrentSourceAdapter,
} from "../types";
import { extractTags } from "../ranking";
import { parseSizeToBytes } from "@/lib/utils";
import { indexerTimeoutSignal } from "./timeouts";

const BASE = process.env.NYAA_BASE_URL ?? "https://nyaa.si";

/** Nyaa category filter mapping */
const CATEGORY_MAP: Record<string, string> = {
  all: "0_0",
  anime: "1_0",
  movies: "4_0", // Live Action
  tv: "4_0",
  music: "2_0",
  apps: "3_0",
  games: "6_0",
};

/**
 * Nyaa adapter — prefers RSS for efficiency and stable parsing.
 * Falls back to HTML scrape if RSS is empty/unavailable.
 */
export class NyaaAdapter implements TorrentSourceAdapter {
  readonly id = "nyaa" as const;
  readonly name = "Nyaa";

  async search(options: SearchOptions): Promise<TorrentResult[]> {
    const limit = options.limit ?? 40;
    const cat = CATEGORY_MAP[options.category ?? "all"] ?? "0_0";
    const q = encodeURIComponent(options.query.trim());

    const rssUrl = `${BASE}/?page=rss&q=${q}&c=${cat}&f=0`;

    try {
      const res = await fetch(rssUrl, {
        headers: {
          "User-Agent":
            "TorrentAggregator/1.0 (+https://github.com/local/torrent-aggregator)",
          Accept: "application/rss+xml, application/xml, text/xml, */*",
        },
        signal: indexerTimeoutSignal(),
        next: { revalidate: 0 },
      });

      if (!res.ok) {
        throw new Error(`Nyaa RSS HTTP ${res.status}`);
      }

      const xml = await res.text();
      const items = parseRssItems(xml).slice(0, limit);
      return items.map((item, index) => toResult(item, index));
    } catch (err) {
      // Surface error to aggregator; empty array would hide failures
      throw err instanceof Error ? err : new Error(String(err));
    }
  }
}

interface RssItem {
  title: string;
  link: string;
  guid?: string;
  pubDate?: string;
  seeders?: string;
  leechers?: string;
  downloads?: string;
  size?: string;
  category?: string;
  infoHash?: string;
}

function parseRssItems(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const itemBlocks = xml.match(/<item>[\s\S]*?<\/item>/gi) ?? [];

  for (const block of itemBlocks) {
    const title = decodeXml(pickTag(block, "title") ?? "");
    const link = decodeXml(pickTag(block, "link") ?? "");
    if (!title || !link) continue;

    items.push({
      title,
      link,
      guid: decodeXml(pickTag(block, "guid") ?? ""),
      pubDate: pickTag(block, "pubDate") ?? undefined,
      seeders: pickNyaa(block, "seeders") ?? pickTag(block, "nyaa:seeders") ?? undefined,
      leechers:
        pickNyaa(block, "leechers") ?? pickTag(block, "nyaa:leechers") ?? undefined,
      downloads:
        pickNyaa(block, "downloads") ?? pickTag(block, "nyaa:downloads") ?? undefined,
      size: pickNyaa(block, "size") ?? pickTag(block, "nyaa:size") ?? undefined,
      category:
        pickNyaa(block, "category") ?? pickTag(block, "nyaa:category") ?? undefined,
      infoHash:
        pickNyaa(block, "infoHash") ?? pickTag(block, "nyaa:infoHash") ?? undefined,
    });
  }

  return items;
}

function pickTag(block: string, tag: string): string | null {
  // CDATA or plain text
  const re = new RegExp(
    `<${tag}[^>]*>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))</${tag}>`,
    "i",
  );
  const m = block.match(re);
  return m ? (m[1] ?? m[2] ?? "").trim() : null;
}

function pickNyaa(block: string, local: string): string | null {
  // Namespaced tags often appear as <nyaa:seeders>N</nyaa:seeders>
  const re = new RegExp(
    `<(?:nyaa:)?${local}[^>]*>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))</(?:nyaa:)?${local}>`,
    "i",
  );
  const m = block.match(re);
  return m ? (m[1] ?? m[2] ?? "").trim() : null;
}

function decodeXml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function toResult(item: RssItem, index: number): TorrentResult {
  const seeders = parseInt(item.seeders ?? "0", 10) || 0;
  const leechers = parseInt(item.leechers ?? "0", 10) || 0;
  const completed = parseInt(item.downloads ?? "0", 10) || 0;
  const sizeBytes = parseSizeToBytes(item.size);
  const infoHash = item.infoHash?.toLowerCase();

  let magnet: string | undefined;
  if (infoHash) {
    const dn = encodeURIComponent(item.title);
    magnet = `magnet:?xt=urn:btih:${infoHash}&dn=${dn}`;
  }

  // Prefer .torrent download link when present
  const torrentUrl = item.link.includes(".torrent")
    ? item.link
    : item.guid?.includes("download")
      ? item.guid
      : undefined;

  const publishedAt = item.pubDate
    ? new Date(item.pubDate).toISOString()
    : null;

  return {
    id: `nyaa-${infoHash ?? index}-${Buffer.from(item.title).toString("base64url").slice(0, 12)}`,
    title: item.title,
    magnet,
    torrentUrl: torrentUrl ?? item.link,
    infoHash,
    sizeBytes,
    sizeLabel: item.size,
    seeders,
    leechers,
    completed,
    category: item.category,
    source: "nyaa",
    sourceUrl: item.link.includes("download")
      ? item.link.replace(/\/download\/.*/, "")
      : item.link,
    publishedAt,
    tags: extractTags(item.title),
  };
}

export const nyaaAdapter = new NyaaAdapter();
