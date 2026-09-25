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

function isJunkSource(title: string): boolean {
  const t = (title || "").replace(/[._]/g, " ");
  if (JUNK_SOURCE_RE.test(t)) return true;

  const cam = BARE_CAM_RE.exec(t);
  if (!cam) return false;
  const anchor = METADATA_ANCHOR_RE.exec(t);
  return anchor != null && anchor.index < cam.index;
}

/**
 * How the release was captured, as an ordering key. Higher is better.
 *
 * Resolution alone is a lie about quality. Sonarr's quality ladder puts
 * `WEBDL-720p` *above* `HDTV-1080p` because an over-the-air 1080p broadcast rip
 * carries broadcaster bugs, ad-break artefacts and a lower bitrate than a 720p
 * streaming pull. Bucketing purely by pixel count therefore lets an HDTV rip be
 * presented as "the best 1080p" over a WEB-DL that is genuinely better.
 *
 * Two deliberate departures from Sonarr's 18-rung ladder:
 *
 * - **Remux is not promoted above Bluray.** Sonarr ranks it top because its
 *   users pick a profile explicitly. Here there is no profile, so promoting
 *   remuxes would silently start grabbing 40–80 GB files onto a personal disk
 *   for a quality difference the user never asked for.
 * - **Unknown is `WEBRIP`-level, not last.** Plenty of legitimate Nyaa releases
 *   (`[Erai-raws] Show - 05`) name no source at all. Sinking them below HDTV
 *   would starve the primary anime indexer — the same failure mode
 *   {@link parseResolution} documents for unknown resolutions.
 */
export const SOURCE_TIER = {
  HDTV: 1,
  WEBRIP: 2,
  /** No source token in the name. Common and not a defect — see above. */
  UNKNOWN: 2,
  WEBDL: 3,
  BLURAY: 3,
} as const;

const SOURCE_PATTERNS: Array<[RegExp, number]> = [
  [/\b(?:blu[-_. ]?ray|bluray|bdrip|brrip|bd[-_. ]?remux|remux|uhdbd)\b/i, SOURCE_TIER.BLURAY],
  // WEBRip is matched *before* WEB-DL on purpose. A service tag names the
  // provenance, not the capture method: `AMZN WEBRip` is a re-encode of a
  // stream, not a direct pull, and must not be promoted by the word "AMZN".
  [/\b(?:web[-_. ]?rip|webrip)\b/i, SOURCE_TIER.WEBRIP],
  [/\b(?:web[-_. ]?dl|webdl)\b/i, SOURCE_TIER.WEBDL],
  [/\b(?:hdtv|pdtv|sdtv|dsr|dvbs?[-_. ]?rip|tvrip)\b/i, SOURCE_TIER.HDTV],
];

/**
 * Bare `WEB` is the common short form of WEB-DL (`1080p WEB x264`), but `Web`
 * is also an ordinary English word in real titles — *Charlotte's Web*,
 * *Spider-Web*. Same disambiguation as {@link isJunkSource} uses for bare
 * `CAM`: scene metadata always trails the title block, so a bare `WEB` counts
 * only when it appears *after* a year or resolution token.
 *
 *   "Charlotte's Web 1080p x264"  -> title    -> not a source tag
 *   "Show S01E01 1080p WEB x264"  -> metadata -> WEB-DL
 */
const BARE_WEB_RE = /\bweb\b/i;

/**
 * Capture tier for a release name. Never `null` — an unnamed source is a real,
 * common answer, and it is scored neutrally rather than last.
 */
export function parseSourceTier(title: string): number {
  if (!title) return SOURCE_TIER.UNKNOWN;
  const t = title.replace(/[._]/g, " ");
  for (const [re, tier] of SOURCE_PATTERNS) {
    if (re.test(t)) return tier;
  }

  const web = BARE_WEB_RE.exec(t);
  if (web) {
    const anchor = METADATA_ANCHOR_RE.exec(t);
    if (anchor != null && anchor.index < web.index) return SOURCE_TIER.WEBDL;
  }
  return SOURCE_TIER.UNKNOWN;
}

/**
 * The resolution the user actually wants. Everything is judged relative to it.
 *
 * 1080p, because that is what he expected and did not get. Note this is a
 * *target*, not a floor and not a ceiling — see {@link resolutionAffinity}.
 */
const DEFAULT_TARGET_RESOLUTION = 1080;

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
function resolutionAffinity(
  res: number | null,
  target: number = DEFAULT_TARGET_RESOLUTION,
): number {
  if (res == null) return -1; // unknown: below everything known, above nothing
  if (res === target) return 1_000;
  if (res < target) return 500 + Math.round(res / 10); // 720→572, 480→548
  return 100 - Math.round(res / 100); // 2160→78; all above-target sink together
}

// ── Swarm-verdict helpers ────────────────────────────────────────────────────
//
// These three functions were previously duplicated between season-plan.ts and
// prerank.ts.  They live here because quality.ts is the shared, Prisma-free
// module that both the pure planner and the Prisma-aware prewarm code can
// safely import.
