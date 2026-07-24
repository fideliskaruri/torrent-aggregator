import type { ReleaseGroup, TorrentResult } from "./types";
import { normalizeTitle } from "@/lib/utils";
import { parseEpisode } from "./episodes";

/**
 * Rank torrent results by seeders, recency, size sanity, and query relevance.
 * Higher score = better placement.
 */
export function rankResults(
  results: TorrentResult[],
  query: string,
): TorrentResult[] {
  const q = normalizeTitle(query);

  const scored = results.map((r) => {
    let score = 0;
    const episode = r.episode ?? parseEpisode(r.title);
    const health = computeHealth(r);

    // Seeders (log scale so mega-seeded releases don't dominate forever)
    score += Math.log10((r.seeders ?? 0) + 1) * 25;

    // Leechers slightly positive (active swarm)
    score += Math.log10((r.leechers ?? 0) + 1) * 4;

    // Recency boost (last 7 days strong, then decay)
    if (r.publishedAt) {
      const ageHours =
        (Date.now() - new Date(r.publishedAt).getTime()) / (1000 * 60 * 60);
      if (!Number.isNaN(ageHours) && ageHours >= 0) {
        if (ageHours < 24) score += 18;
        else if (ageHours < 72) score += 12;
        else if (ageHours < 168) score += 6;
        else if (ageHours < 720) score += 2;
      }
    }

    // Query relevance
    const title = normalizeTitle(r.title);
    if (title === q) score += 40;
    else if (title.includes(q)) score += 22;
    else {
      const tokens = q.split(" ").filter(Boolean);
      const hits = tokens.filter((t) => title.includes(t)).length;
      score += (hits / Math.max(tokens.length, 1)) * 18;
    }

    // Prefer known good quality tags
    const tags = r.tags.map((t) => t.toLowerCase());
    if (tags.includes("1080p") || tags.includes("bluray")) score += 6;
    if (tags.includes("2160p") || tags.includes("4k")) score += 4;
    if (tags.includes("hevc") || tags.includes("x265")) score += 2;

    // Mild source preference
    if (r.source === "nyaa") score += 1;
    if (r.source === "yts") score += 2;

    // Penalize zero-seed dead torrents
    if ((r.seeders ?? 0) === 0) score -= 15;

    // Health contributes lightly
    score += health / 20;

    const groupKey = buildGroupKey(r.title, episode);

    return {
      ...r,
      episode,
      health,
      groupKey,
      score: Math.round(score * 10) / 10,
    };
  });

  const sorted = scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return markBestPicks(sorted);
}

export function computeHealth(r: TorrentResult): number {
  const seeds = r.seeders ?? 0;
  const leech = r.leechers ?? 0;
  if (seeds <= 0) return Math.min(15, leech > 0 ? 10 : 0);

  // Log seeders to 0–70, ratio bonus to 30
  const seedScore = Math.min(70, Math.log10(seeds + 1) * 28);
  const ratio = seeds / Math.max(leech, 1);
  const ratioScore = Math.min(30, Math.log10(ratio + 1) * 20);
  return Math.round(Math.min(100, seedScore + ratioScore));
}

function buildGroupKey(
  title: string,
  episode: ReturnType<typeof parseEpisode>,
): string {
  let base = normalizeTitle(title)
    .replace(
      /\b(s\d{1,2}e\d{1,3}|\d{1,2}x\d{1,3}|ep?\s*\d{1,3}|season\s*\d+)\b/gi,
      " ",
    )
    .replace(
      /\b(1080p|720p|480p|2160p|4k|hevc|x265|x264|web-?dl|webrip|bluray|bdrip|hdtv|remux|yts)\b/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();

  if (episode.isSeasonPack) {
    return `${base}|S${episode.season ?? "X"}-pack`;
  }
  if (episode.season != null && episode.episode != null) {
    return `${base}|S${episode.season}E${episode.episode}`;
  }
  if (episode.episode != null) {
    return `${base}|E${episode.episode}`;
  }
  return base;
}

function markBestPicks(results: TorrentResult[]): TorrentResult[] {
  const seen = new Set<string>();
  return results.map((r) => {
    const key = r.groupKey ?? r.id;
    if (!seen.has(key)) {
      seen.add(key);
      return { ...r, bestPick: true };
    }
    return { ...r, bestPick: false };
  });
}

/** Group ranked results for UI collapse of alternate encodes */
export function groupReleases(results: TorrentResult[]): ReleaseGroup[] {
  const map = new Map<string, TorrentResult[]>();
  for (const r of results) {
    const key = r.groupKey ?? r.id;
    const list = map.get(key) ?? [];
    list.push(r);
    map.set(key, list);
  }

  const groups: ReleaseGroup[] = [];
  for (const [key, list] of map) {
    const sorted = [...list].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const best = sorted[0];
    groups.push({
      key,
      label: best.episode?.label
        ? `${best.metadata?.title || best.title.slice(0, 40)} · ${best.episode.label}`
        : best.title.slice(0, 60),
      best,
      alternatives: sorted.slice(1),
    });
  }

  return groups.sort(
    (a, b) => (b.best.score ?? 0) - (a.best.score ?? 0),
  );
}

/** Extract quality / codec tags from a torrent title */
export function extractTags(title: string): string[] {
  const patterns = [
    "2160p",
    "4K",
    "1080p",
    "720p",
    "480p",
    "HEVC",
    "x265",
    "x264",
    "AV1",
    "WEB-DL",
    "WEBRip",
    "BluRay",
    "BDRip",
    "HDTV",
    "REMUX",
    "HDR",
    "DV",
    "Atmos",
    "DTS",
    "AAC",
    "FLAC",
    "Dual",
    "Multi",
    "Sub",
    "Dub",
    "Batch",
  ];
  const found: string[] = [];
  const upper = title.toUpperCase();
  for (const p of patterns) {
    if (upper.includes(p.toUpperCase())) found.push(p);
  }
  return found;
}

/**
 * Deduplicate near-identical releases (same info hash, or very similar title+size).
 */
export function dedupeResults(results: TorrentResult[]): TorrentResult[] {
  const seenHash = new Set<string>();
  const seenKey = new Set<string>();
  const out: TorrentResult[] = [];

  for (const r of results) {
    if (r.infoHash) {
      const h = r.infoHash.toLowerCase();
      if (seenHash.has(h)) continue;
      seenHash.add(h);
    }

    const key = `${normalizeTitle(r.title)}|${r.sizeBytes ?? r.sizeLabel ?? ""}`;
    if (seenKey.has(key)) continue;
    seenKey.add(key);
    out.push(r);
  }

  return out;
}
