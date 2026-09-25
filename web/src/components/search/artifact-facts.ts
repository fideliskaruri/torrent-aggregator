/**
 * What a release row says when the release is **not** video.
 *
 * `release-facts.ts` answers "which print of this episode is this?" — episode,
 * resolution, source tier. Every one of those is meaningless here. An album has
 * no resolution, a program has no season, and "WEB-DL" says nothing about a
 * PDF. Reusing that module for music would have produced rows that look
 * informative and state nothing true, which is worse than a bare filename.
 *
 * So this is a separate vocabulary for a genuinely different question: **what
 * exactly am I about to download?** For non-video artifacts the answer is
 * almost always the *format* — the difference between a 90 MB MP3 rip and a
 * 900 MB FLAC rip, or between an EPUB and a 12-hour audiobook, is the whole
 * decision. Size and swarm health still matter and are shared with the video
 * path (`sizeFact`, `seedStrength`), so they are not duplicated here.
 *
 * Everything is derived from the release title, because that is genuinely all
 * the indexers give us. Where a fact cannot be read, it is **omitted** rather
 * than guessed — a row with two honest facts beats a row with four where one is
 * invented. That rule is what the tests actually pin.
 *
 * Pure and DOM-free on purpose: `artifact-facts.test.ts` drives it as a table.
 */
import type { TorrentResult } from "@/lib/torrents/types";

/**
 * A separator-aware word boundary.
 *
 * `\b` is the obvious choice and it is wrong for this corpus. Regex counts `_`
 * as a *word* character, so in the real result `stardew_valley_windows_gog_
 * (78674)` there is no boundary around `gog` and `\bgog\b` simply does not
 * match — the row silently loses the one fact (DRM-free) that makes that
 * release worth choosing.
 *
 * Underscore-separated names are routine from several indexers, so this is a
 * whole class of missed facts rather than one bad pattern. Normalising the
 * title once, here, fixes every pattern at the same time and keeps each one
 * readable; the alternative — hand-writing `(?:^|[\W_])` around a dozen
 * alternations — is where the next one gets forgotten.
 *
 * Only separators are touched. Letters, digits and case are untouched, so
 * patterns that rely on them (version numbers, years) behave identically.
 */
function separable(title: string): string {
  return title.replace(/_/g, " ");
}

/**
 * Format families, most specific first.
 *
 * Order is load-bearing in two places. Lossless is tested before lossy so a
 * "FLAC + MP3" bundle reads as FLAC (the reason to pick it). Audiobook is
 * tested before the plain ebook formats because an audiobook release routinely
 * mentions "epub" for the bundled companion text, and calling a 12-hour listen
 * an "EPUB" is the single most misleading thing this module could do.
 */
const FORMAT_PATTERNS: Array<[RegExp, string]> = [
  // ── Audio ──────────────────────────────────────────────────────────────
  [/\b(?:flac|alac|ape|wav|dsd|24[-_ ]?bit|hi[-_ ]?res)\b/i, "FLAC"],
  [/\b(?:mp3|aac|ogg|opus|m4a)\b/i, "MP3"],
  [/\b\d{3}\s?kbps\b/i, "MP3"],
  // ── Books ──────────────────────────────────────────────────────────────
  [/\b(?:audiobook|audio[-_ ]?book|unabridged|abridged|m4b)\b/i, "Audiobook"],
  [/\bepub\b/i, "EPUB"],
  [/\b(?:pdf|azw3?|mobi|djvu)\b/i, "PDF/eBook"],
  [/\b(?:cbr|cbz|comic)\b/i, "Comic"],
  // ── Games / software ───────────────────────────────────────────────────
  [/\b(?:fitgirl|dodi|repack|rg[-_ ]?mechanics)\b/i, "Repack"],
  [/\b(?:gog|drm[-_ ]?free)\b/i, "GOG"],
  [/\b(?:portable)\b/i, "Portable"],
  [/\b(?:iso|dmg|pkg)\b/i, "Disc image"],
];

/** The format family a release states, or null when it states none. */
export function formatLabel(title: string): string | null {
  const t = separable(title);
  for (const [re, label] of FORMAT_PATTERNS) {
    if (re.test(t)) return label;
  }
  return null;
}

/**
 * Which platform a game or program targets.
 *
 * Only recognised from explicit, unambiguous markers. "Mac" is deliberately
 * absent as a bare word — it appears inside ordinary titles (*Mac Miller*,
 * *Macbeth*) far more often than it means macOS in this corpus, and a music
 * album labelled "macOS" would be nonsense. macOS/OSX are matched instead.
 */
const PLATFORM_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:mac[-_ ]?os|osx|os[-_ ]?x)\b/i, "macOS"],
  [/\b(?:windows|win(?:32|64)|win\d{1,2})\b/i, "Windows"],
  [/\b(?:linux|ubuntu|debian|appimage)\b/i, "Linux"],
  [/\b(?:android|apk)\b/i, "Android"],
  [/\b(?:nintendo[-_ ]?switch|\bnsp\b|\bxci\b)\b/i, "Switch"],
  [/\b(?:ps[45]|playstation)\b/i, "PlayStation"],
];

export function platformLabel(title: string): string | null {
  const t = separable(title);
  for (const [re, label] of PLATFORM_PATTERNS) {
    if (re.test(t)) return label;
  }
  return null;
}

/**
 * A stated version number, for software where "which build?" is the question.
 *
 * Requires a `v` prefix or at least two dotted parts, so a year (2024) and a
 * lone track number never masquerade as a version. Capped in length because a
 * scene name can carry a very long build string that would blow out the row.
 */
/**
 * A stated version number, for software where "which build?" is the question.
 *
 * Requires a `v` prefix or at least two dotted parts, so a year (2024) and a
 * lone track number never masquerade as a version. Capped in length because a
 * scene name can carry a very long build string that would blow out the row.
 *
 * Audio channel layouts are excluded outright. Seen rendering live on
 * *"Daft Punk - Discovery - 5.1 Surround Sound"*, which the dotted-pair rule
 * read as **v5.1** — a version number for an album, which is meaningless, and
 * exactly the "looks informative, says nothing true" failure this module exists
 * to prevent. `5.1`, `7.1`, `2.0` and `2.1` are speaker configurations wherever
 * they appear in this corpus; none of them is ever a build.
 */
const CHANNEL_LAYOUTS = new Set(["1.0", "2.0", "2.1", "4.0", "5.0", "5.1", "6.1", "7.1", "9.1"]);

export function versionLabel(title: string): string | null {
  const t = separable(title);
  const m =
    /\bv(\d+(?:\.\d+){0,3})\b/i.exec(t) ??
    /\b(\d+\.\d+(?:\.\d+){0,2})\b/.exec(t);
  if (!m) return null;
  const v = m[1];
  if (v.length > 12) return null;
  if (CHANNEL_LAYOUTS.has(v)) return null;
  return `v${v}`;
}

/**
 * A stated year, e.g. an album's release year.
 *
 * Bounded to plausible values so a bitrate (320) or a resolution never reads as
 * a year. The upper bound is generous rather than "now" so a pre-release does
 * not lose its year the moment the clock disagrees.
 */
export function yearLabel(title: string): string | null {
  const matches = separable(title).match(/\b(19\d{2}|20\d{2})\b/g);
  if (!matches) return null;
  const year = matches[0];
  const n = Number(year);
  return n >= 1900 && n <= 2100 ? year : null;
}

/**
 * The facts for one artifact row, in render order.
 *
 * Deliberately capped at three. A row is scanned, not read, and the fourth fact
 * is always the one nobody needed — past three the eye stops distinguishing
 * rows, which defeats the entire point of a chooser.
 *
 * @param title release name
 * @param size  pre-formatted size from the shared `sizeFact`, when known
 */
export function artifactFacts(title: string, size?: string | null): string[] {
  const facts: string[] = [];
  const format = formatLabel(title);
  if (format) facts.push(format);
  const platform = platformLabel(title);
  if (platform) facts.push(platform);
  // Version and year compete for the same slot and never both help: software
  // wants the build, an album wants the year, and neither wants both.
  if (facts.length < 2) {
    const version = versionLabel(title);
    if (version) facts.push(version);
    else {
      const year = yearLabel(title);
      if (year) facts.push(year);
    }
  }
  if (size) facts.push(size);
  return facts.slice(0, 3);
}

/**
 * A short accessible name for an artifact row's Download action.
 *
 * Falls back to the release title rather than a generic word: for an artifact
 * the title *is* the identity, so "Download" alone would leave a screen-reader
 * user choosing between identical buttons.
 */
export function artifactActionName(title: string, size?: string | null): string {
  const facts = artifactFacts(title, size);
  return facts.length ? `${title} — ${facts.join(" · ")}` : title;
}

/** Convenience wrapper for callers holding a whole result. */
export function artifactFactsFor(
  torrent: TorrentResult,
  size?: string | null,
): string[] {
  return artifactFacts(torrent.title, size);
}
