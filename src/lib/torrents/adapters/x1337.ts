import * as cheerio from "cheerio";
import type {
  SearchOptions,
  TorrentResult,
  TorrentSourceAdapter,
} from "../types";
import { extractTags } from "../ranking";
import { parseSizeToBytes } from "@/lib/utils";
import { fetchWithBrowser } from "../browser";

const BASE = process.env.X1337_BASE_URL ?? "https://1337x.to";

const CATEGORY_SLUG: Record<string, string> = {
  anime: "Anime",
  movies: "Movies",
  tv: "TV",
  music: "Music",
  apps: "Apps",
  games: "Games",
  // 1337x files ebooks, audiobooks and comics under "Other" rather than giving
  // books a category of their own. Omitting the key entirely would fall through
  // to an unscoped search, which is strictly worse than the site's own bucket.
  books: "Other",
};

/**
 * 1337x adapter — HTML scrape with plain fetch first, Playwright fallback.
 * Note: Cloudflare often returns 403 to datacenter/residential IPs for both.
 * No API key exists for 1337x; blocks are anti-bot, not missing credentials.
 */
export class X1337Adapter implements TorrentSourceAdapter {
  readonly id = "1337x" as const;
  readonly name = "1337x";

  async search(options: SearchOptions): Promise<TorrentResult[]> {
    const limit = Math.min(options.limit ?? 30, 40);
    const q = options.query.trim();
    if (!q) return [];

    const category = options.category ?? "all";
    let url: string;

    if (category !== "all" && CATEGORY_SLUG[category]) {
      url = `${BASE}/category-search/${encodeURIComponent(q)}/${CATEGORY_SLUG[category]}/1/`;
    } else {
      url = `${BASE}/search/${encodeURIComponent(q)}/1/`;
    }

    const html = await this.loadSearchHtml(url);
    const rows = parseSearchTable(html).slice(0, limit);

    if (!rows.length) {
      // Empty table after a successful load — site layout change or soft block
      if (
        html.includes("Just a moment") ||
        html.includes("cf-browser-verification") ||
        html.includes("Performing security verification")
      ) {
        throw new Error(
          "1337x blocked by Cloudflare (403 challenge). No API key will fix this — the site is refusing automated access from this network. Use Nyaa / ThePirateBay / TorrentsCSV, a proxy, or set X1337_BASE_URL to a working mirror.",
        );
      }
      return [];
    }

    const withMagnets = await mapPool(rows, 4, async (row) => {
      try {
        const detail = await fetchDetail(row.detailPath);
        return {
          ...row,
          magnet: detail.magnet,
          infoHash: detail.infoHash,
          torrentUrl: detail.torrentUrl,
        };
      } catch {
        return row;
      }
    });

    return withMagnets.map((row, index) => toResult(row, index));
  }

  private async loadSearchHtml(url: string): Promise<string> {
    // 1) Plain fetch (fast path when not blocked)
    try {
      const res = await fetch(url, {
        headers: defaultHeaders(),
        signal: AbortSignal.timeout(14_000),
        next: { revalidate: 0 },
      });

      if (res.ok) {
        return await res.text();
      }

      if (res.status !== 403 && res.status !== 503) {
        throw new Error(`1337x search HTTP ${res.status}`);
      }

      // Fast-fail unless explicitly enabled (Playwright rarely clears CF managed challenges
      // and adds ~30–40s of latency per search).
      if (process.env.X1337_USE_PLAYWRIGHT !== "1") {
        throw new Error(
          `1337x HTTP ${res.status} (Cloudflare bot protection). No API key exists for 1337x. Other sources still work. Set X1337_USE_PLAYWRIGHT=1 to retry with a headless browser (usually still blocked).`,
        );
      }

      console.warn(
        `[1337x] fetch returned ${res.status}, trying Playwright fallback…`,
      );
    } catch (err) {
      if (
        err instanceof Error &&
        (err.message.startsWith("1337x search HTTP") ||
          err.message.startsWith("1337x HTTP"))
      ) {
        throw err;
      }
      if (process.env.X1337_USE_PLAYWRIGHT !== "1") {
        throw err instanceof Error
          ? err
          : new Error(`1337x fetch failed: ${String(err)}`);
      }
      console.warn("[1337x] fetch failed, trying Playwright…", err);
    }

    // 2) Playwright (opt-in) — still often stuck on CF managed challenge
    const browserResult = await fetchWithBrowser(url, {
      timeoutMs: 40_000,
      waitForSelector: "table.table-list tbody tr",
    });

    if (!browserResult) {
      throw new Error(
        "1337x HTTP 403 (Cloudflare). Playwright unavailable or failed. No API key required — the site is bot-protected.",
      );
    }

    if (
      browserResult.status === 403 ||
      browserResult.html.includes("Just a moment") ||
      browserResult.html.includes("Performing security verification")
    ) {
      throw new Error(
        "1337x blocked by Cloudflare (403). Confirmed via Playwright — challenge page never clears. No API key will fix this from this IP/network.",
      );
    }

    return browserResult.html;
  }
}

interface SearchRow {
  title: string;
  detailPath: string;
  seeders: number;
  leechers: number;
  sizeLabel: string;
  publishedLabel?: string;
  uploader?: string;
  magnet?: string;
  infoHash?: string;
  torrentUrl?: string;
}

function defaultHeaders(): HeadersInit {
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    "Upgrade-Insecure-Requests": "1",
  };
}

function parseSearchTable(html: string): SearchRow[] {
  const $ = cheerio.load(html);
  const rows: SearchRow[] = [];

  $("table.table-list tbody tr").each((_, el) => {
    const nameCell = $(el).find("td.coll-1.name");
    const link = nameCell.find("a").last();
    const title = link.text().trim();
    const href = link.attr("href") ?? "";
    if (!title || !href) return;

    const seeders = parseInt($(el).find("td.coll-2.seeds").text().trim(), 10) || 0;
    const leechers = parseInt($(el).find("td.coll-3.leeches").text().trim(), 10) || 0;
    const sizeCell = $(el).find("td.coll-4");
    sizeCell.find("span").remove();
    const sizeLabel = sizeCell.text().trim();
    const publishedLabel = $(el).find("td.coll-date").text().trim();
    const uploader = $(el).find("td.coll-5 a").text().trim();

    rows.push({
      title,
      detailPath: href,
      seeders,
      leechers,
      sizeLabel,
      publishedLabel,
      uploader,
    });
  });

  return rows;
}

async function fetchDetail(detailPath: string): Promise<{
  magnet?: string;
  infoHash?: string;
  torrentUrl?: string;
}> {
  const url = detailPath.startsWith("http") ? detailPath : `${BASE}${detailPath}`;
  const res = await fetch(url, {
    headers: defaultHeaders(),
    signal: AbortSignal.timeout(10_000),
    next: { revalidate: 0 },
  });
  if (!res.ok) return {};

  const html = await res.text();
  const $ = cheerio.load(html);

  const magnet =
    $('a[href^="magnet:"]').first().attr("href") ??
    html.match(/magnet:\?xt=urn:btih:[a-zA-Z0-9]+[^"'<\s]*/)?.[0];

  let infoHash: string | undefined;
  if (magnet) {
    const m = magnet.match(/btih:([a-zA-Z0-9]+)/i);
    infoHash = m?.[1]?.toLowerCase();
  }

  if (!infoHash) {
    const hashText = $(".infohash-box span").last().text().trim();
    if (hashText) infoHash = hashText.toLowerCase();
  }

  const torrentUrl = $('a[href*=".torrent"]').first().attr("href") ?? undefined;

  return { magnet, infoHash, torrentUrl };
}

function toResult(row: SearchRow, index: number): TorrentResult {
  const sizeBytes = parseSizeToBytes(row.sizeLabel);
  const publishedAt = parseLooseDate(row.publishedLabel);

  return {
    id: `1337x-${row.infoHash ?? index}-${Buffer.from(row.title).toString("base64url").slice(0, 12)}`,
    title: row.title,
    magnet: row.magnet,
    torrentUrl: row.torrentUrl,
    infoHash: row.infoHash,
    sizeBytes,
    sizeLabel: row.sizeLabel,
    seeders: row.seeders,
    leechers: row.leechers,
    category: undefined,
    source: "1337x",
    sourceUrl: row.detailPath.startsWith("http")
      ? row.detailPath
      : `${BASE}${row.detailPath}`,
    publishedAt,
    tags: extractTags(row.title),
  };
}

function parseLooseDate(label?: string): string | null {
  if (!label) return null;
  if (/^\d+(am|pm)$/i.test(label.trim())) {
    return new Date().toISOString();
  }
  const cleaned = label
    .replace(/(\d+)(st|nd|rd|th)/gi, "$1")
    .replace(/\./g, "")
    .replace(/'/g, " ");
  const d = new Date(cleaned);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

export const x1337Adapter = new X1337Adapter();
