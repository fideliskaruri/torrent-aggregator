import type { ReleaseGroup, TorrentResult } from "./types";
import { normalizeTitle } from "@/lib/utils";
import { classifySpecialRelease, parseEpisode } from "./episodes";
import { isExtrasRelease } from "./filters";
import {
  metadataAgrees,
  stripTrailingJunkNumber,
  releaseYear,
  workIdentity,
} from "./work-identity";
import {
  compareReleases,
  describeRelease,
  directPlayableRank,
  parseResolution,
  resolutionAffinity,
  DEFAULT_TARGET_RESOLUTION,
  type ReleaseRank,
} from "./quality";

/**
 * Distinct affinity values, ascending, so a rank index can be derived without
 * hardcoding the affinity arithmetic in two places.
 */
function affinitySteps(target: number): number[] {
  return [null, 360, 480, 576, 720, 1080, 2160]
    .map((res) => resolutionAffinity(res, target))
    .sort((a, b) => a - b);
}

function affinityRank(affinity: number, steps: number[]): number {
  const i = steps.indexOf(affinity);
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
function encodeScore(d: ReleaseRank, steps: number[], isExtras: boolean): number {
  const good = 2 - ((d.junk ? 1 : 0) + (d.implausible ? 1 : 0));
  return (
    // I14b: a bonus/extras/sample release sits below the entire main-feature
    // score space, so `score` (which `groupReleases` and the search API sort by)
    // can never disagree with the demotion applied in {@link rankResults}. The
    // multiplier dominates every lower term's maximum combined contribution.
    (isExtras ? 0 : 1) * 1_000_000_000 +
    (d.categoryMatch + 1) * 10_000_000 +
    d.relevance * 1_000_000 +
    good * 100_000 +
    (d.viable ? 1 : 0) * 10_000 +
    affinityRank(d.affinity, steps) * 1_000 +
    directPlayableRank(d.directPlayable) * 300 +
    d.languagePreference * 100 +
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
  target: number = DEFAULT_TARGET_RESOLUTION,
  category: string | null | undefined = "all",
): TorrentResult[] {
  const steps = affinitySteps(target);
  const requestedEpisode = parseEpisode(query);
  const preferNewestEpisode =
    requestedEpisode.season == null && requestedEpisode.episode == null;
  const scored = results.map((r) => {
    const parsedEpisode = r.episode ?? parseEpisode(r.title);
    const specialType = classifySpecialRelease(r.title);
    const episode = {
      ...parsedEpisode,
      ...(specialType ? { specialType } : {}),
    };
    const described = describeRelease(r, query, target, category);
    const queryName = normalizeTitle(query);
    const metadataNames = [
      r.metadata?.title,
      ...(r.metadata?.aliases ?? []),
    ].map((name) => normalizeTitle(name ?? ""));
    const aliasMatch =
      metadataNames.includes(queryName) &&
      metadataAgrees(workIdentity(r.title).name, r.metadata);
    const rank = aliasMatch
      ? { ...described, relevance: Math.max(described.relevance, 3) }
      : described;
    const animeContext =
      category === "anime" ||
      r.route?.kind === "anime" ||
      r.metadata?.mediaType === "anime";
    const isExtras =
      isExtrasRelease(r.title) || (animeContext && specialType != null);
    return {
      rank,
      isExtras,
      animeContext,
      episode,
      episodeOrder:
        (episode.season ?? 0) * 10_000 + (episode.episode ?? 0),
      result: {
        ...r,
        episode,
        releaseGroup: releaseGroupFromTitle(r.title),
        health: computeHealth(r),
        groupKey: buildGroupKey(r.title, episode),
        score: encodeScore(rank, steps, isExtras),
      },
    };
  });

  scored.sort((a, b) => {
    // I14b: a bonus/extras/sample release ranks below the main feature whenever
    // one exists, regardless of quality or seeders — "Play" and the top pick
    // must never land on supplementary material. Only when every candidate is an
    // extra do they fall through to the normal comparator among themselves.
    if (a.isExtras !== b.isExtras) return a.isExtras ? 1 : -1;
    if (
      preferNewestEpisode &&
      sameRankBeforeEpisode(a.rank, b.rank) &&
      comparableEpisodeOrder(a, b)[0] !== comparableEpisodeOrder(a, b)[1]
    ) {
      const [aOrder, bOrder] = comparableEpisodeOrder(a, b);
      return bOrder - aOrder;
    }

    function comparableEpisodeOrder(
      a: {
        animeContext: boolean;
        episode: ReturnType<typeof parseEpisode>;
        episodeOrder: number;
      },
      b: {
        animeContext: boolean;
        episode: ReturnType<typeof parseEpisode>;
        episodeOrder: number;
      },
    ): [number, number] {
      const ordinaryEpisode = (value: typeof a) =>
        !value.episode.isBatch &&
        !value.episode.isSeasonPack &&
        value.episode.specialType == null;
      if (a.animeContext && b.animeContext && ordinaryEpisode(a) && ordinaryEpisode(b)) {
        if (a.episode.absoluteEpisode != null && b.episode.season == null) {
          return [a.episode.absoluteEpisode, b.episode.episode ?? 0];
        }
        if (b.episode.absoluteEpisode != null && a.episode.season == null) {
          return [a.episode.episode ?? 0, b.episode.absoluteEpisode];
        }
      }
      return [a.episodeOrder, b.episodeOrder];
    }
    return compareReleases(a.rank, b.rank);
  });
  return markBestPicks(scored.map((s) => s.result));
}

function sameRankBeforeEpisode(a: ReleaseRank, b: ReleaseRank): boolean {
  const aBad = Number(a.junk) + Number(a.implausible);
  const bBad = Number(b.junk) + Number(b.implausible);
  return (
    a.categoryMatch === b.categoryMatch &&
    a.relevance === b.relevance &&
    aBad === bBad &&
    a.viable === b.viable &&
    a.affinity === b.affinity
  );
}

/** Leading bracket tags are the one release-group convention we can prove. */
export function releaseGroupFromTitle(title: string): string | undefined {
  const group = /^\s*\[([^\]]{1,60})\]/.exec(title)?.[1]?.trim();
  return group || undefined;
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
  // AC3 / E-AC3. Their absence was not merely cosmetic: `Dune ... AC3 ...`
  // grouped as `dune extended ac|E3`, because with the token left in place the
  // episode parser read the trailing "3" of "AC3" as episode 3 and put a film
  // in an episode group.
  "e?-?ac-?3",
  "(?:dual|multi)\\s*audio",
  // Source
  "web\\s*-?\\s*dl",
  "web\\s*-?\\s*rip",
  "web",
  "blu\\s*-?\\s*ray",
  "bd\\s*rip",
  "br\\s*rip",
  "hd\\s*rip",
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
  // Cut/edition tags. None of these is a film title on its own, and each was
  // observed as the only token separating one cut of a film from another in
  // the same group.
  "extended",
  "unrated",
  "theatrical",
  "imax",
  "hybrid",
  "\\d{1,2}\\s*bit",
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
  // A file size baked into the release name: "...1080p.WEBRip.1600MB.DD2.0...".
  // Unambiguous — no title contains "1600MB" — and it was observed live
  // splitting Dune Part Two into its own group on `/search?q=dune`, because it
  // was the only token distinguishing that release's key from its siblings'.
  "\\d+(?:[.,]\\d+)?\\s*[mg]b",
  // Language/region packaging tags. Deliberately only the ones that are never
  // a word in a title: "NORDiC" was observed live producing the group
  // `dune part two 2024 nordic` alongside `dune part two`. Bare language names
  // ("german", "french") are NOT listed — "The German Doctor" is a real film,
  // and stripping those would merge or truncate real titles.
  "nordic",
  "multi",
  "multisubs?",
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
  if (
    episode.absoluteEpisode != null &&
    episode.absoluteEpisode !== episode.episode
  ) {
    base = base.replace(
      new RegExp(`\\b0*${episode.absoluteEpisode}\\b`, "g"),
      " ",
    );
  }

  base = base.replace(/\s+/g, " ").trim();

  // An indexer's trailing suffix, e.g. `Dune Part Two (2024) [1080p] [WEBRip] 88`.
  // Without this the film groups under `dune part two 88` and renders as a
  // second work beside the real one, with no poster. Shares its rule with
  // `workIdentity` so the two grouping paths cannot disagree about how many
  // films "Dune Part Two" is. See `stripTrailingJunkNumber`'s own notes for
  // why a title that legitimately ends in a number is left alone.
  base = stripTrailingJunkNumber(title, base);

  base = base.replace(/\s+/g, " ").trim();

  // The release year, handled exactly the way the episode number above is:
  // removed from the base and carried in the key's suffix instead.
  //
  // It has to be one or the other consistently, and leaving it in the base was
  // observed live on `/search?q=dune` splitting single films across groups.
  // A year written in brackets — `Dune Part Two (2024) [1080p]` — is erased by
  // `normalizeTitle`, while the same film's dotted print —
  // `Dune.Part.Two.2024.2160p...` — keeps it, so the two prints keyed as
  // `dune part two` and `dune part two 2024` and rendered as two works.
  //
  // Moving it to the suffix rather than deleting it is deliberate: deleting it
  // would merge *Dune* (1984) into *Dune* (2021), which is a worse bug than
  // the one being fixed. `releaseYear` is reused rather than a fresh regex
  // because it already refuses to read `1080p`/`2160p`/`x264` as years, and
  // only the year it actually parsed is removed, so `1917` and `2012` keep
  // their titles.
  const year = releaseYear(title);
  if (year != null) {
    base = base.replace(new RegExp(`(?<![\\d.])${year}(?![\\d.])`, "g"), " ");
    base = base.replace(/\s+/g, " ").trim();
  }

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
  // A film's year distinguishes it; a series' does not, which is why this sits
  // below every episode branch rather than being appended unconditionally.
  return year != null ? `${base}|Y${year}` : base;
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
