import type { ReleaseGroup, TorrentResult } from "./types";
import { normalizeTitle } from "@/lib/utils";
import { parseEpisode } from "./episodes";
import {
  compareReleases,
  describeRelease,
  parseResolution,
  resolutionAffinity,
  DEFAULT_TARGET_RESOLUTION,
  type ReleaseRank,
} from "./quality";

/**
 * Distinct affinity values, ascending, so a rank index can be derived without
 * hardcoding the affinity arithmetic in two places.
 */
const AFFINITY_STEPS = [null, 360, 480, 576, 720, 1080, 2160]
  .map((res) => resolutionAffinity(res, DEFAULT_TARGET_RESOLUTION))
  .sort((a, b) => a - b);

function affinityRank(affinity: number): number {
  const i = AFFINITY_STEPS.indexOf(affinity);
  return i < 0 ? 0 : i;
}

/**
 * A single number that reproduces {@link compareReleases} exactly.
 *
 * This is a *positional* encoding, not a weighted sum: each field's multiplier
 * exceeds the largest total every lower-priority field can contribute, so a
 * lower-priority field can never compensate for a higher-priority one. That is
 * the property the old additive score lacked, and the reason a 5,000-seeder
 * 480p used to beat a 1080p.
 *
 * It exists so that `score` — which `groupReleases` sorts by, and which the
 * search API exposes — can never disagree with the comparator. Anything that
 * sorts by descending `score` gets the same order as the comparator, minus the
 * size tiebreak, which only ever splits otherwise-equal releases.
 */
function encodeScore(d: ReleaseRank): number {
  const good = 2 - ((d.junk ? 1 : 0) + (d.implausible ? 1 : 0));
  return (
    d.relevance * 100_000 +
    good * 10_000 +
    (d.viable ? 1 : 0) * 1_000 +
    affinityRank(d.affinity) * 100 +
    Math.min(d.seeders, 9) * 10 +
    d.recency
  );
}

/**
 * Order results best-first.
 *
 * Ordering is delegated wholesale to {@link compareReleases}; see `quality.ts`
 * for why this is a comparison chain rather than a score. Nothing here filters:
 * every input release appears in the output.
 */
export function rankResults(
  results: TorrentResult[],
  query: string,
): TorrentResult[] {
  const scored = results.map((r) => {
    const episode = r.episode ?? parseEpisode(r.title);
    const rank = describeRelease(r, query);
    return {
      rank,
      result: {
        ...r,
        episode,
        health: computeHealth(r),
        groupKey: buildGroupKey(r.title, episode),
        score: encodeScore(rank),
      },
    };
  });

  scored.sort((a, b) => compareReleases(a.rank, b.rank));
  return markBestPicks(scored.map((s) => s.result));
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

/**
 * Human-readable chips for the UI.
 *
 * The resolution chip comes from {@link parseResolution} — the *same* function
 * the comparator uses — so the badge on a card can never disagree with the
 * order the card was placed in. When those two drifted apart the UI showed
 * "1080p" on a release the ranker had read as unknown, which is how a quality
 * bug hides in plain sight.
 */
export function extractTags(title: string): string[] {
  const found: string[] = [];

  const res = parseResolution(title);
  if (res != null) found.push(res === 2160 ? "2160p" : `${res}p`);

  // Substring matching is fine for these — they are long enough to be
  // unambiguous. The short, collision-prone ones below need word boundaries.
  const substrings = [
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
    "Atmos",
    "FLAC",
    "Batch",
  ];
  const upper = title.toUpperCase();
  for (const p of substrings) {
    if (upper.includes(p.toUpperCase())) found.push(p);
  }

  // `DV` must not match "DVDRip", `Sub` must not swallow "Subtitle", and `DTS`
  // must not fire on "DTS-HD" twice. Anchored to word boundaries instead.
  const anchored: Array<[string, RegExp]> = [
    ["DV", /\bd(?:olby ?)?v(?:ision)?\b/i],
    ["DTS", /\bdts(?:-?hd|-?x)?\b/i],
    ["AAC", /\baac\d?(?:\.\d)?\b/i],
    ["Dual", /\bdual(?:[- ]?audio)?\b/i],
    ["Multi", /\bmulti(?:ple)?\b/i],
    ["Sub", /\bsubs?(?:titles?|bed)?\b/i],
    ["Dub", /\bdub(?:bed)?\b/i],
  ];
  for (const [label, re] of anchored) {
    if (re.test(title)) found.push(label);
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
