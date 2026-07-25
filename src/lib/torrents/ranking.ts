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

/**
 * Strips the release-group tag so different encodes of the same episode share
 * a key.
 *
 * `normalizeTitle` turns brackets into spaces but keeps what was inside them,
 * so `[SubsPlease] One Piece - 1170` and `[Erai-raws] One Piece - 1170` hashed
 * to different keys. Every result then formed a group of one and every row was
 * badged "Best", which made the badge meaningless.
 *
 * Bracketed segments are dropped whole, along with the trailing `-GROUP`
 * suffix scene releases use. If that removes everything (a title that is
 * nothing but tags) the original is kept rather than collapsing unrelated
 * releases together.
 */
export function stripReleaseGroup(title: string): string {
  const withoutBrackets = title
    .replace(/[[({【][^\])}】]*[\])}】]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const base = withoutBrackets || title;

  // Scene suffix: "...1080p.WEB-DL.x264-NTb" → drop "-NTb".
  //
  // Only fires when the rest of the name carries release tokens (resolution,
  // codec, source). A plain title has none, so "Spider-Man" keeps its hyphen
  // instead of becoming "Spider" and colliding with an unrelated show.
  if (!looksLikeSceneRelease(base)) return base;

  const stripped = base
    .replace(/(?<=\S)-([A-Za-z0-9]{2,12})\s*$/, " ")
    .replace(/\s+/g, " ")
    .trim();

  return stripped || base;
}

/**
 * Tokens that describe *how* a release was encoded, not *what* it is. Two rows
 * differing only by these are the same logical release and belong in one group.
 *
 * Written as a table because the failure mode here is always a missing token,
 * and a list is the only shape that makes the gap obvious. Spaces are written
 * as `\s*` since `normalizeTitle` turns dots into spaces (`H.264` → `h 264`).
 */
const RELEASE_TOKEN_PATTERNS = [
  // Resolution
  "\\d{3,4}p",
  "4k",
  "8k",
  "uhd",
  "hd",
  "sd",
  // Video codec
  "hevc",
  "x\\s*26[45]",
  "h\\s*26[45]",
  "avc",
  "av1",
  "xvid",
  "divx",
  "hi10p",
  "10\\s*bit",
  "8\\s*bit",
  // Audio. Channel layouts arrive as separate tokens once dots become spaces
  // (`AAC2.0` → `aac2 0`, `DDP5.1` → `ddp5 1`), so the trailing channel digit
  // is part of the token — otherwise a stray "0" survives into the group base.
  "aac\\s*\\d*(?:\\s*\\d)?",
  "e?ac3\\s*\\d*(?:\\s*\\d)?",
  "ddp?\\s*\\d*(?:\\s*\\d)?",
  "dts(?:\\s*hd)?(?:\\s*ma)?\\s*\\d*(?:\\s*\\d)?",
  "flac\\s*\\d*(?:\\s*\\d)?",
  "opus\\s*\\d*(?:\\s*\\d)?",
  "truehd\\s*\\d*(?:\\s*\\d)?",
  "atmos",
  "mp3",
  "(?:dual|multi)\\s*audio",
  // Source
  "web\\s*-?\\s*dl",
  "web\\s*-?\\s*rip",
  "web",
  "blu\\s*-?\\s*ray",
  "bd\\s*rip",
  "br\\s*rip",
  "bd",
  "hdtv",
  "dvd\\s*rip",
  "dvd",
  "remux",
  "hdr\\d*",
  "dv",
  "sdr",
  "cam",
  "ts",
  // Release qualifiers
  "repack",
  "proper",
  "rerip",
  "internal",
  "uncensored",
  "batch",
  "complete",
  "subbed",
  "dubbed",
  "raw",
  // Platforms / distributors
  "amzn",
  "dsnp",
  "atvp",
  "hulu",
  "hmax",
  "nf",
  "cr",
  "funi",
  "tver",
  "yts",
  "rarbg",
  // Asian streaming platforms — these appear as the only differing token in
  // otherwise identical anime releases, so omitting them split one episode
  // into a group (and therefore a "Best" badge) per platform.
  "bili",
  "bilibili",
  "b-global",
  "bglobal",
  "iq",
  "iqiyi",
  "viki",
  "wetv",
  "abema",
  "baha",
  // Containers
  "mkv",
  "mp4",
  "avi",
  "m4v",
];

const RELEASE_TOKEN_RE = new RegExp(
  `\\b(?:${RELEASE_TOKEN_PATTERNS.join("|")})\\b`,
  "gi",
);

/**
 * Does this name carry encoding metadata? Separate non-global regex so the
 * shared `lastIndex` of {@link RELEASE_TOKEN_RE} cannot make this flaky.
 */
const RELEASE_TOKEN_TEST_RE = new RegExp(
  `\\b(?:${RELEASE_TOKEN_PATTERNS.join("|")})\\b`,
  "i",
);

function looksLikeSceneRelease(name: string): boolean {
  return RELEASE_TOKEN_TEST_RE.test(name.replace(/[._]/g, " "));
}

/**
 * Season/episode markers. The episode number is allowed up to four digits —
 * long-running anime is numbered past 1000, and a three-digit cap meant
 * `One Piece - 1170` kept its number in the group base, so the same episode
 * split into a separate group per release. The key already carries the parsed
 * episode, so the number is redundant in the base either way.
 */
const EPISODE_MARKER_RE =
  /\b(s\d{1,2}\s*e\d{1,4}|\d{1,2}x\d{1,4}|ep?\s*\d{1,4}|season\s*\d+|episode\s*\d+)\b/gi;

function buildGroupKey(
  title: string,
  episode: ReturnType<typeof parseEpisode>,
): string {
  const normalized = normalizeTitle(stripReleaseGroup(title));

  let base = normalized
    .replace(EPISODE_MARKER_RE, " ")
    .replace(RELEASE_TOKEN_RE, " ");

  // Drop a bare episode number too (`One Piece 1170`). Only the number we
  // actually parsed, so a number that is part of the title survives.
  if (episode.episode != null) {
    base = base.replace(
      new RegExp(`\\b0*${episode.episode}\\b`, "g"),
      " ",
    );
  }

  base = base.replace(/\s+/g, " ").trim();

  // Stripping everything would collapse unrelated releases into one group,
  // which is worse than the over-splitting this is meant to fix.
  if (!base) base = normalized.replace(/\s+/g, " ").trim() || title;

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
