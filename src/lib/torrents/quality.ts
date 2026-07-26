/**
 * What a release *is*, judged from its name, and how two releases compare.
 *
 * This module exists because ranking used to be an additive score:
 *
 *     score += Math.log10(seeders + 1) * 25;   // ~92 at 5,000 seeders
 *     if (tags.includes("1080p")) score += 6;  // a rounding error
 *
 * A well-seeded 480p therefore beat a modestly-seeded 1080p, and automation
 * grabbed it. Badly-encoded small files are exactly what thousands of people
 * seed, so this was not a rare tie — it was the common case.
 *
 * The tempting fix is to raise `+6` to `+60`. That is the wrong fix. Every
 * weighted sum has a crossover point: whatever constant is chosen, some seeder
 * count buys a resolution downgrade, and public indexers reliably produce it.
 *
 * So quality is not a term in a sum here. Releases are compared by a chain of
 * predicates where the **first non-zero comparison wins outright**, which is
 * how Sonarr, Radarr, FlexGet, autodl-irssi and qBittorrent's RSS engine all
 * do it — five independent implementations across three languages.
 *
 * Nothing in this file *rejects* a release. Ordering cannot return an empty
 * list, so it cannot starve a monitored show, cannot trip the season-rollover
 * miss counter in `advanceCursorAfterMiss`, and needs no blocklist or stall
 * handling to be safe. Rejection is reserved for a floor the user sets
 * explicitly, which lives in the caller.
 */
import type { TorrentResult } from "./types";
import { normalizeTitle } from "@/lib/utils";

/**
 * Resolution patterns, most specific first.
 *
 * Ported from Sonarr's `QualityParser.ResolutionRegex`
 * (Sonarr/src/NzbDrone.Core/Parser/QualityParser.cs, GPL-3.0) with its
 * deliberate quirks kept:
 *
 * - `1440p` and `FHD` fold into 1080. Sonarr treats them as 1080-class rather
 *   than inventing a tier nobody encodes to.
 * - `4kto1080p` is 1080, not 2160 — it is a downscale, and matching `4k` first
 *   would read it as the opposite of what it says.
 * - bare `4k` is **not** a resolution token. It is marketing text that appears
 *   in titles of 1080p files. Only `[4K]` and `4k-UHD`/`4k-HEVC` count.
 * - standalone `UHD` **is** 2160. Unlike bare `4k` it is an encoder/disc term,
 *   not marketing, so reading it as unknown would sink a real 4K disc below
 *   360p (unknown ranks last).
 */
const RESOLUTION_PATTERNS: Array<[RegExp, number]> = [
  [/\b(?:4kto1080p)\b/i, 1080],
  [/\b(?:2160p|3840x2160|uhd|4k[-_. ]?(?:uhd|hevc|bd|h ?265)|(?:uhd|hevc|bd|h ?265)[-_. ]4k)\b/i, 2160],
  [/\[4k\]/i, 2160],
  [/\b(?:1080p|1920x1080|1440p|fhd|1080i)\b/i, 1080],
  [/\b(?:720p|1280x720|960p)\b/i, 720],
  [/\b(?:576p|576i)\b/i, 576],
  [/\b(?:480p|480i|640x480|848x480)\b/i, 480],
  [/\b(?:360p|240p)\b/i, 360],
];

/**
 * Vertical resolution in pixels, or `null` when the name does not say.
 *
 * `null` is a normal, common answer — plenty of Nyaa releases
 * (`[Erai-raws] Show - 05`) carry no resolution token at all. Callers must
 * rank unknowns low rather than discard them, or the primary anime indexer
 * starves.
 */
export function parseResolution(title: string): number | null {
  if (!title) return null;
  const t = title.replace(/[._]/g, " ");
  for (const [re, value] of RESOLUTION_PATTERNS) {
    if (re.test(t)) return value;
  }
  return null;
}

/**
 * Camcorder and screener rips.
 *
 * These are worse than any resolution is good: a `2160p HDCAM` is a phone
 * recording of a cinema screen, and under the old additive score it outranked
 * a proper `480p WEB-DL` outright. FlexGet models this as a `modifier` that
 * "affects sorting above all other components"; the same idea here is a single
 * demotion flag consulted before resolution.
 *
 * `\bTS\b` is deliberately absent — it collides with too many real words and
 * fansub tags. `TELESYNC` and `HDTS` carry the same meaning unambiguously.
 */
const JUNK_SOURCE_RE =
  /\b(?:hdcam|cam-?rip|camrip|telesync|hdts|telecine|tele-?cine|dvdscr|dvd-?screener|screener|workprint|hdtc)\b/i;

/**
 * Bare `CAM` is a real scene tag, but `Cam` (2018) is a real film — and junk is
 * the comparator's second key, so a false positive buries a legitimate 1080p
 * release below every 480p on the page.
 *
 * Scene naming disambiguates them by *position*: metadata always trails the
 * title block (`Title.YEAR.SOURCE.CODEC`). So bare `cam` counts as junk only
 * when it appears after a year or a resolution token — never when it is part
 * of the title itself.
 *
 *   "Cam 2018 1080p WEB-DL"   -> title    -> not junk
 *   "The Cam 1080p"           -> title    -> not junk
 *   "Movie 2024 CAM XviD"     -> metadata -> junk
 *   "Movie 1080p CAM"         -> metadata -> junk
 */
const BARE_CAM_RE = /\bcam\b(?![a-z])/i;
const METADATA_ANCHOR_RE = /\b(?:19|20)\d{2}\b|\b\d{3,4}[pi]\b/i;

export function isJunkSource(title: string): boolean {
  const t = (title || "").replace(/[._]/g, " ");
  if (JUNK_SOURCE_RE.test(t)) return true;

  const cam = BARE_CAM_RE.exec(t);
  if (!cam) return false;
  const anchor = METADATA_ANCHOR_RE.exec(t);
  return anchor != null && anchor.index < cam.index;
}

/** Sample clips and extras masquerading as the release. */
const SAMPLE_RE = /\bsample\b/i;

/**
 * A size that cannot be what the name claims.
 *
 * Deliberately *very* permissive. A flat "1080p must exceed 300 MB" rule
 * misfires on legitimately short content — a 12-minute anime episode or an OVA
 * at 1080p can sit around 150–250 MB — and wrongly discarding a real release is
 * worse than ranking a fake one low. Runtime is not stored anywhere in this
 * app, so a proper MB-per-minute bound (Sonarr's approach) cannot be computed
 * honestly; pretending otherwise with a hardcoded 45-minute assumption would
 * reject every movie and every season pack.
 *
 * So this only catches the egregious case: something claiming HD in under
 * 50 MB is a sample, a fake, or a link file. And even then the result is a
 * demotion, never a rejection.
 */
const IMPLAUSIBLE_HD_BYTES = 50 * 1024 * 1024;

export function isImplausible(r: Pick<TorrentResult, "title" | "sizeBytes">): boolean {
  if (SAMPLE_RE.test(r.title || "")) return true;
  const res = parseResolution(r.title);
  if (res == null || res < 720) return false;
  // Unknown size is normal on several indexers and must not count against it.
  if (r.sizeBytes == null || r.sizeBytes <= 0) return false;
  return r.sizeBytes < IMPLAUSIBLE_HD_BYTES;
}

/**
 * The resolution the user actually wants. Everything is judged relative to it.
 *
 * 1080p, because that is what he expected and did not get. Note this is a
 * *target*, not a floor and not a ceiling — see {@link resolutionAffinity}.
 */
export const DEFAULT_TARGET_RESOLUTION = 1080;

/**
 * How well a resolution answers a target, higher is better.
 *
 * The naive rule — "more pixels is better" — is the opposite bug to the one
 * being fixed. It makes a 10-seeder 2160p beat a 900-seeder 1080p, and a 4K
 * release is routinely 15–60 GB: on a home connection that is hours of
 * downloading and tens of gigabytes of disk for a file the user never asked
 * for. Grabbing 2160p when 1080p was wanted is just as wrong as grabbing 480p,
 * it simply fails in the expensive direction instead of the ugly one.
 *
 * So this models Sonarr's quality-profile idea: the target wins outright, and
 * everything else degrades away from it. Below-target ranks by closeness
 * (720 > 576 > 480 > 360) because those are graceful downgrades of the same
 * content. Above-target ranks below *all* of them, because oversized is a
 * deliberate choice the user should opt into by raising the target, not
 * something automation does on his behalf.
 *
 * A user who wants 4K sets the target to 2160 and 2160 becomes the exact
 * match. The rule needs no special case for that.
 */
export function resolutionAffinity(
  res: number | null,
  target: number = DEFAULT_TARGET_RESOLUTION,
): number {
  if (res == null) return -1; // unknown: below everything known, above nothing
  if (res === target) return 1_000;
  if (res < target) return 500 + Math.round(res / 10); // 720→572, 480→548
  return 100 - Math.round(res / 100); // 2160→78; all above-target sink together
}

/**
 * Can this realistically finish?
 *
 * Ordering by resolution alone would hand a 1-seeder 1080p victory over a
 * 5,000-seeder 720p, trading "grabbed the wrong quality" for "never finishes" —
 * a worse bug, because the old behaviour at least produced a watchable file.
 * Sonarr can ignore this because a stalled grab is removed, blocklisted and
 * re-hunted; this app has no such loop, so a dead torrent sits at 0% forever
 * while the dedupe check reports "Already sent this release".
 *
 * Viability is therefore compared *before* resolution: among releases that can
 * actually complete, quality decides; a release that cannot complete loses to
 * every one that can, whatever its resolution. It is still ranked, never
 * dropped, so a show whose only release is thinly seeded remains grabbable.
 */
export const MIN_VIABLE_SEEDERS = 3;

export function isViable(r: Pick<TorrentResult, "seeders">): boolean {
  return (r.seeders ?? 0) >= MIN_VIABLE_SEEDERS;
}

/**
 * Order-of-magnitude swarm size, quantised exactly as Sonarr does
 * (`Math.Round(Math.Log10(seeders))`).
 *
 * 500 and 1,200 seeders both bucket to 3, so a 10x swarm advantage is worth one
 * point. That is the point: seeders break ties between comparable releases and
 * are never allowed to express a preference strong enough to cross a quality
 * boundary.
 */
export function seedersBucket(seeders: number | null | undefined): number {
  const s = seeders ?? 0;
  if (s <= 0) return 0;
  return Math.round(Math.log10(s));
}

/** Freshness in coarse steps; exact timestamps would dominate as a tiebreak. */
export function recencyBucket(publishedAt: string | null | undefined): number {
  if (!publishedAt) return 0;
  const ms = new Date(publishedAt).getTime();
  if (Number.isNaN(ms)) return 0;
  const ageHours = (Date.now() - ms) / 3_600_000;
  if (ageHours < 0) return 0;
  if (ageHours < 24) return 4;
  if (ageHours < 72) return 3;
  if (ageHours < 168) return 2;
  if (ageHours < 720) return 1;
  return 0;
}

/**
 * Episode selectors that automation appends to a query.
 *
 * `resolveHuntCursor` builds `"One Piece S01E05"`, but the primary anime
 * indexer names that file `[SubsPlease] One Piece - 05 (1080p)` — which does
 * not contain `s01e05`. Left in, the token drags every real Nyaa release down
 * a relevance tier while a scene-formatted `One Piece S01E05 480p` sits a tier
 * above, and relevance is the *first* comparator key. The 480p would win on
 * naming coincidence alone — reintroducing the exact bug being fixed.
 *
 * The episode is already matched properly by `parseEpisode` in the runner, so
 * relevance only needs the show name.
 */
const EPISODE_QUERY_TOKEN_RE =
  /\b(?:s\d{1,3}\s?e\d{1,4}|season\s*\d{1,3}|episode\s*\d{1,4})\b/gi;

/**
 * `1x05`-style episode tokens, stripped **only when they don't lead the query**.
 *
 * `3x3 Eyes` and `5x5` are real titles. Stripping a leading `NxN` turns them
 * into `"Eyes"` / `""`, and relevance is the comparator's highest-priority key
 * — so a generic word (or nothing at all) would decide ordering, re-creating
 * the exact "wins on a naming coincidence" failure this module exists to kill.
 * A genuine episode token always follows a show name, so requiring a preceding
 * word costs nothing.
 */
const LOOSE_EPISODE_TOKEN_RE = /(?<=\S\s+)\b\d{1,3}x\d{1,3}\b/gi;

export function stripEpisodeTokens(query: string): string {
  const stripped = (query || "")
    .replace(EPISODE_QUERY_TOKEN_RE, " ")
    .replace(LOOSE_EPISODE_TOKEN_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Never let stripping erase the query. An empty relevance key scores every
  // release identically, which is strictly worse than not stripping at all.
  return stripped || (query || "").trim();
}

/**
 * How well the release name answers the query, in coarse tiers.
 *
 * This outranks everything, including resolution: a 2160p copy of the wrong
 * show is not a better answer than a 720p copy of the right one. Tiers rather
 * than a continuous score, so near-identical relevance falls through to the
 * quality comparisons instead of being decided by token-count noise.
 *
 * There is deliberately **no "exact title" tier**. `normalizeTitle` already
 * strips resolution, codec and episode tokens, so "exact" would only mean
 * "carries no release-group prefix" — a scene-naming convention, not evidence
 * of relevance. Rewarding it ranked `One Piece S01E05 480p WEBRip` (normalises
 * to exactly "one piece") above `[SubsPlease] One Piece - 05 (1080p)`
 * (normalises to "subsplease one piece 05"), handing the 480p a win on the
 * strength of its filename format. Containment is the real signal.
 */
export function relevanceTier(title: string, query: string): number {
  const q = normalizeTitle(stripEpisodeTokens(query));
  if (!q) return 0; // no query (browse/RSS): everything is equally relevant
  const t = normalizeTitle(title || "");
  if (t.includes(q)) return 3; // the show name appears contiguously
  const tokens = q.split(" ").filter(Boolean);
  if (tokens.length === 0) return 0;
  const hits = tokens.filter((tok) => t.includes(tok)).length;
  if (hits === tokens.length) return 2; // all words present, scattered
  if (hits / tokens.length >= 0.5) return 1;
  return 0;
}

/** Everything the comparator needs, computed once per release. */
export type ReleaseRank = {
  relevance: number;
  junk: boolean;
  implausible: boolean;
  viable: boolean;
  /** Raw parsed resolution, kept for display and tests. */
  resolution: number | null;
  /** Ordering key derived from {@link resolutionAffinity}. */
  affinity: number;
  seeders: number;
  recency: number;
  sizeBytes: number;
};

export function describeRelease(
  r: TorrentResult,
  query: string,
  target: number = DEFAULT_TARGET_RESOLUTION,
): ReleaseRank {
  const resolution = parseResolution(r.title);
  return {
    relevance: relevanceTier(r.title, query),
    junk: isJunkSource(r.title),
    implausible: isImplausible(r),
    viable: isViable(r),
    resolution,
    affinity: resolutionAffinity(resolution, target),
    seeders: seedersBucket(r.seeders),
    recency: recencyBucket(r.publishedAt),
    sizeBytes: r.sizeBytes ?? 0,
  };
}

/**
 * Compare two releases. Negative means `a` sorts first (i.e. `a` is better).
 *
 * The chain is deliberate and its order is the whole design:
 *
 *  1. **relevance** — the wrong show is always wrong, at any quality.
 *  2. **junk / implausible** — a camcorder rip or a 40 MB "1080p" is worse
 *     than anything legitimate, at any resolution or swarm size.
 *  3. **viability** — a release that cannot finish is worth less than one that
 *     can. This sits *above* resolution on purpose (see {@link isViable}).
 *  4. **resolution** — the reported bug. Compared as affinity to the user's
 *     target, above seeders, so no swarm size can ever buy a quality change in
 *     either direction. Unknown resolution ranks below every known one.
 *  5. **seeders**, bucketed by order of magnitude.
 *  6. **recency**, then **size** as final tiebreaks.
 *
 * Returns on the first non-zero comparison; nothing is summed, so no term can
 * ever compensate for another.
 */
export function compareReleases(a: ReleaseRank, b: ReleaseRank): number {
  // Higher is better.
  if (a.relevance !== b.relevance) return b.relevance - a.relevance;

  // Lower is better: false (0) sorts ahead of true (1).
  const aBad = (a.junk ? 1 : 0) + (a.implausible ? 1 : 0);
  const bBad = (b.junk ? 1 : 0) + (b.implausible ? 1 : 0);
  if (aBad !== bBad) return aBad - bBad;

  if (a.viable !== b.viable) return a.viable ? -1 : 1;

  if (a.affinity !== b.affinity) return b.affinity - a.affinity;

  if (a.seeders !== b.seeders) return b.seeders - a.seeders;
  if (a.recency !== b.recency) return b.recency - a.recency;
  return b.sizeBytes - a.sizeBytes;
}
