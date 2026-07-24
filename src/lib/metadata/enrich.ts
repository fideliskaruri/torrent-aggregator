import type { MediaMetadata, TorrentResult } from "@/lib/torrents/types";
import { normalizeTitle } from "@/lib/utils";
import { searchAniList } from "./anilist";
import { searchTmdb } from "./tmdb";
import {
  getMemoryQueryCache,
  setCachedMetadata,
  setMemoryQueryCache,
} from "./cache";

/**
 * Strip common torrent noise from titles to improve metadata matching.
 */
export function cleanTorrentTitle(title: string): string {
  return title
    .replace(/[\[\(].*?[\]\)]/g, " ")
    .replace(
      /\b(S\d{1,2}E\d{1,3}|E\d{1,3}|EP?\s*\d{1,3}|Season\s*\d+|Complete|Batch)\b/gi,
      " ",
    )
    .replace(
      /\b(1080p|720p|480p|2160p|4K|UHD|HDR|DV|HEVC|x265|x264|AV1|WEB-?DL|WEBRip|BluRay|BDRip|HDTV|REMUX|AAC|FLAC|DTS|Atmos|10bit|Dual|Multi|Sub|Dub|NF|AMZN|DSNP|CR)\b/gi,
      " ",
    )
    .replace(/[._\-–—|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreMatch(query: string, candidateTitle: string): number {
  const q = normalizeTitle(query);
  const c = normalizeTitle(candidateTitle);
  if (!q || !c) return 0;
  if (q === c) return 100;
  if (c.includes(q) || q.includes(c)) return 80;
  const qTokens = q.split(" ").filter((t) => t.length > 1);
  const hits = qTokens.filter((t) => c.includes(t)).length;
  return (hits / Math.max(qTokens.length, 1)) * 70;
}

/**
 * Resolve the best media metadata for a search query / torrent title.
 */
export async function resolveMetadata(
  rawTitle: string,
  category?: string,
): Promise<MediaMetadata | null> {
  const cleaned = cleanTorrentTitle(rawTitle);
  if (!cleaned) return null;

  const memKey = `${category ?? "all"}:${cleaned.toLowerCase()}`;
  const cached = getMemoryQueryCache(memKey);
  if (cached !== undefined) return cached;

  const preferAnime =
    category === "anime" ||
    /\b(anime|subbed|dubbed|bd\s*box|ova|ona)\b/i.test(rawTitle);

  let best: MediaMetadata | null = null;
  let bestScore = 0;

  try {
    if (preferAnime || category === "all" || !category) {
      const animeHits = await searchAniList(cleaned, 5);
      for (const hit of animeHits) {
        const s = scoreMatch(cleaned, hit.title);
        if (s > bestScore) {
          bestScore = s;
          best = hit;
        }
      }
    }
  } catch {
    // AniList optional
  }

  // Also try TMDB for non-anime or weak anime matches
  if (!preferAnime || bestScore < 55) {
    try {
      const tmdbHits = await searchTmdb(cleaned, 5);
      for (const hit of tmdbHits) {
        const s = scoreMatch(cleaned, hit.title);
        // slight preference for anime when category is anime
        const adjusted = preferAnime && hit.mediaType !== "anime" ? s - 5 : s;
        if (adjusted > bestScore) {
          bestScore = adjusted;
          best = hit;
        }
      }
    } catch {
      // TMDB optional
    }
  }

  // Require a minimum match quality
  const result = bestScore >= 40 ? best : null;
  setMemoryQueryCache(memKey, result);

  if (result) {
    void setCachedMetadata(result);
  }

  return result;
}

/**
 * Attach metadata per-result only when the catalog title matches the torrent name.
 * Never stamp the search-query match onto unrelated releases (that caused
 * "Atlantis S01-S02" to inherit anime metadata and route to Anime).
 */
export async function enrichResultsWithMetadata(
  results: TorrentResult[],
  query: string,
  category?: string,
): Promise<TorrentResult[]> {
  if (!results.length) return results;

  const primary = await resolveMetadata(query, category);

  const top = results.slice(0, 16);
  const uniqueTitles = [
    ...new Set(top.map((r) => cleanTorrentTitle(r.title)).filter(Boolean)),
  ].slice(0, 6);

  const titleMeta = new Map<string, MediaMetadata | null>();
  await Promise.all(
    uniqueTitles.map(async (t) => {
      // Prefer a title-specific lookup; fall back to primary only if it matches
      let meta = await resolveMetadata(t, category);
      if (!meta && primary && titlesRoughlyMatch(t, primary.title)) {
        meta = primary;
      }
      titleMeta.set(t, meta);
    }),
  );

  return results.map((r, i) => {
    if (i >= 16) return r;
    const key = cleanTorrentTitle(r.title);
    let meta = titleMeta.get(key) ?? null;

    // Last resort: use query metadata only if it matches this torrent
    if (!meta && primary && titlesRoughlyMatch(r.title, primary.title)) {
      meta = primary;
    }

    // Drop metadata that doesn't belong on this release
    if (meta && !titlesRoughlyMatch(r.title, meta.title)) {
      meta = null;
    }

    return { ...r, metadata: meta };
  });
}

function titlesRoughlyMatch(torrentTitle: string, catalogTitle: string): boolean {
  const a = cleanTorrentTitle(torrentTitle).toLowerCase();
  const b = catalogTitle.toLowerCase().trim();
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const aTok = a.split(/\s+/).filter((t) => t.length > 2);
  const bTok = b.split(/\s+/).filter((t) => t.length > 2);
  if (!bTok.length) return false;
  const hits = bTok.filter((t) => aTok.some((x) => x.includes(t) || t.includes(x))).length;
  return hits / bTok.length >= 0.6;
}
