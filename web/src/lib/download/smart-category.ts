import type { MediaMetadata } from "@/lib/torrents/types";
import { mediaAliasAgrees } from "@/lib/torrents/media-alias";
import {
  parseEpisode,
  SEASON_RANGE_RE,
} from "@/lib/torrents/episodes";

/** Re-export for path callers that only import smart-category. */
/** Quality / release tokens stripped for display titles and folder names. */
const QUALITY_TOKEN_RE =
  /\b(1080p|720p|480p|2160p|4k|uhd|hdr10?|dv|dolby\s*vision|hevc|x265|h\s*\.?\s*265|x264|h\s*\.?\s*264|av1|10-?bits?|8-?bits?|web-?dl|webrip|bluray|bdrip|bdr|brrip|hdtv|hdcam|remux|proper|repack|internal|limited|extended|theatrical|imax|aac(?:\s*[25]\.?\d)?|ac3|eac3|ddp?\.?(?:\s*[25]\.?\d)?|dts(?:-?hd)?|truehd|atmos|flac|mp3|opus|vorbis|dual(?:\s*audio)?|multi(?:\s*sub|audio)?|subs?|dub(?:bed)?|softsubs?|hardsubs?|nf|amzn|dsnp|hulu|atvp|pmtp|tver|cr|mkv|mp4|avi|ts|m2ts|webm|ch)\b/gi;

/**
 * Multi-season range or list. Shared with `parseEpisode` so classification and
 * filing can never disagree about what a multi-season pack looks like.
 */
const MULTI_SEASON_RE = SEASON_RANGE_RE;
/** 1x05 style */
const NXNN_RE = /\b(\d{1,2})x(\d{1,4})\b/i;
/**
 * Indexer / site junk prefixes that must never become show folders:
 *   "www.UIndex.org - ONE PIECE …" → strip domain + separator
 */
const SITE_PREFIX_RE =
  /(?:^|[\s|])(?:www\.)?[a-z0-9][a-z0-9-]*\.(?:org|com|net|info|to|me|tv|cc|io|co|ru|in|us|uk|eu|xyz|site|online)\b\s*[-–—:|]*\s*/gi;

function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(SITE_PREFIX_RE, " ")
    .replace(/[\[\](){}]/g, " ")
    .replace(
      /\b(s\d{1,3}e\d{1,4}|s\d{1,3}|1080p|720p|480p|2160p|bluray|webrip|web-?dl|hevc|x265|x264|bone|yts)\b/gi,
      " ",
    )
    // Catalogs keep punctuation that release names drop: TMDB says
    // "Frieren: Beyond Journey's End", the torrent says "Frieren Beyond
    // Journeys End". Apostrophes close up (journey's → journeys), every
    // other separator becomes a gap. Unicode-aware so non-latin titles
    // keep their characters instead of normalizing to an empty string.
    .replace(/['’`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Stable show/movie folder name shared by ALL episodes of a series.
 *
 * Fixes the per-episode folder mess:
 *   ✗ Anime/One Piece 1170 mkv
 *   ✗ Anime/One Piece EP1170 AAC2 0
 *   ✗ TV/Extreme Makeover Homer Edition   ← episode subtitle, not the show
 *   ✓ Anime/One Piece
 *   ✓ TV/The Simpsons
 *
 * Priority: catalog title only when it matches the *show* segment of the
 * release (pre-episode cut) — never episode-name metadata that merely
 * token-overlaps the full torrent title.
 */
export function showFolderName(
  title: string,
  metadata?: MediaMetadata | null,
): string {
  const fromRelease = showNameFromRelease(title);

  if (metadata?.title?.trim()) {
    const metaFolder = sanitizeFolderSegment(metadata.title.trim());
    const metaNorm = normalizeForMatch(metaFolder);
    // Compare against the pre-episode show segment, not the full torrent
    // title — otherwise "Extreme Makeover Homer Edition" matches S37E16.
    const showNorm = normalizeForMatch(
      fromRelease || cutAtStructuralMarker(title),
    );
    if (
      metaNorm &&
      showNorm &&
      ((showNorm === metaNorm ||
        showNorm.includes(metaNorm) ||
        metaNorm.includes(showNorm)) ||
        mediaAliasAgrees(fromRelease, metadata))
    ) {
      return metaFolder;
    }
  }

  return fromRelease;
}

/** Clean show folder purely from the release title (no catalog metadata). */
function showNameFromRelease(title: string): string {
  const ep = parseEpisode(title);
  let cleaned = cleanReleaseTitle(title);

  // Remove the detected episode number so all eps share one folder
  if (ep.episode != null) {
    const n = String(ep.episode);
    cleaned = cleaned
      .replace(new RegExp(`\\b0*${n}\\b`, "gi"), " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  // Trailing absolute ep residue: "One Piece 1170"
  cleaned = cleaned.replace(/\s+\d{1,4}$/g, "").trim();
  cleaned = cleaned
    .replace(/\b(complete|batch|pack|extras?|uncensored)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  const folder = sanitizeFolderSegment(cleaned);
  // Final invariant: never ship site-domain folder names
  if (!folder || /^www\./i.test(folder) || /\.(org|com|net)$/i.test(folder)) {
    return sanitizeFolderSegment(
      cleaned
        .replace(/\bwww\.[^\s]+/gi, " ")
        .replace(/\b[a-z0-9-]+\.(org|com|net)\b/gi, " ")
        .replace(/\s+/g, " ")
        .trim(),
    );
  }
  return folder;
}

/**
 * Cut release title at the first season/episode structural marker so
 * episode names ("Tall Stewie") and scene tags never become the show folder.
 */
export function cutAtStructuralMarker(title: string): string {
  const patterns: RegExp[] = [
    /\bS\d{1,3}\s*E\d{1,4}\b/i,
    SEASON_RANGE_RE,
    /\b\d{1,2}x\d{1,4}\b/i,
    /\bSeasons?\s*\d{1,3}\b/i,
    /\bS\d{1,3}\b/i,
    /\b(?:episode|ep)\s*\.?\s*\d{1,4}\b/i,
    // Bare E12 only when not part of a word (scene often uses "E12")
    /(?<![A-Za-z])\bE\d{1,4}\b/i,
    // Anime absolute: "Show - 1170" or "Show - 1170 ["
    /[-–—]\s*\d{1,4}(?=\s|[\[\(]|$)/,
  ];
  let cut = title.length;
  for (const re of patterns) {
    const m = re.exec(title);
    if (m && m.index != null && m.index < cut && m.index > 0) {
      cut = m.index;
    }
  }
  return title.slice(0, cut);
}

function cleanReleaseTitle(title: string): string {
  if (!title) return "";

  let t = title
    // HTML entities from scrapers
    .replace(/&amp;/gi, "and")
    .replace(/&[a-z]+;/gi, " ")
    // Indexer site prefixes: "www.UIndex.org - ONE PIECE …"
    // Also spaced variants: "www.UIndex.org    -    The Simpsons"
    .replace(SITE_PREFIX_RE, " ")
    .replace(
      /(?:^|\s)(?:www\.)?[a-z0-9][a-z0-9-]*\.(?:org|com|net|info|to|me|tv|cc|io)\b(?:\s*[-–—:|]+\s*|\s+)/gi,
      " ",
    );

  // Normalize dots/underscores early so markers match
  t = t.replace(/[._]+/g, " ");

  // Drop bracketed / parenthetical release-group, hashes, resolution tags
  t = t.replace(/[\[\(][^\]\)]{0,48}[\]\)]/g, " ");

  // CRITICAL: cut at SxxEyy / Season / Ep so episode titles never stick
  // "Family Guy S24E11 Tall Stewie 1080p…" → "Family Guy "
  t = cutAtStructuralMarker(t);

  t = t
    // Residual multi-season / episode wording if cut missed
    .replace(MULTI_SEASON_RE, " ")
    .replace(/\bS(\d{1,3})\s*E(\d{1,4})\b/gi, " ")
    .replace(NXNN_RE, " ")
    .replace(/\bS\d{1,3}\b/gi, " ")
    .replace(/\b(?:season|episode|ep|e)\s*\.?\s*(\d{1,4})\b/gi, " ")
    .replace(/[-–—]\s*\d{1,4}(?=\s|$)/g, " ")
    .replace(
      /\b(complete(?:\s*(?:series|season|collection))?|season\s*pack|batch|uncensored)\b/gi,
      " ",
    )
    // Year (standalone)
    .replace(/\b(19|20)\d{2}\b/g, " ")
    // Quality / codec / container / audio residue
    .replace(QUALITY_TOKEN_RE, " ")
    // Spaced channel / bitrate junk: "5 1", "DD 5 1", "10 bits"
    .replace(/\b(?:dd|ddp|aac|dts)\s*\d(?:\s*\d)?\b/gi, " ")
    .replace(/\b\d+\s+\d+\b/g, " ") // orphan "5 1" pairs
    .replace(/\b\d+(?:\.\d+)?\s*(?:ch|kbps|mbps|fps|bits?)\b/gi, " ")
    // Trailing scene/release group tokens (mixed case ok): playWEB, ELiTE, PSA, Rapta, NTb
    .replace(
      /\s+(?:playWEB|ELiTE|PSA|Rapta|NTb|FLUX|KITSU[Nn]e|STC|BONE|RARBG|YTS|YIFY|SPARKS|FGT|DIMENSION|KILLERS|COAST|METCON|THRONE|EVO|ION10|XEBEC|ION265|TGx|EtHD|CtrlHD|NTb)(?:\s|$)/gi,
      " ",
    )
    // Single trailing all-caps/group-like token (not multi-word show names)
    .replace(/\s+[A-Za-z][A-Za-z0-9]{1,12}$/g, (m) => {
      const w = m.trim();
      // Keep if it looks like a normal title word (has lowercase run of 3+ and is common?)
      // Drop scene-style: all caps, or CamelCase scene groups, or short codes
      if (/^[A-Z]{2,12}$/.test(w)) return " ";
      if (/^[A-Z]{2,}[a-z]+[A-Z]/.test(w)) return " "; // playWEB-ish already handled
      if (/^(?:x265|x264|h264|h265|web|dl|rip)$/i.test(w)) return " ";
      return m;
    })
    .replace(/[.\-–—|+]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Title-case pure ALL-CAPS show names for nicer folders
  if (t && t === t.toUpperCase() && /[A-Z]/.test(t)) {
    t = t
      .toLowerCase()
      .replace(/\b([a-z])/g, (c) => c.toUpperCase());
  }

  return t;
}

function sanitizeFolderSegment(name: string): string {
  let s = name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 120);

  // Never allow indexer domains as the whole folder name
  if (/^www\./i.test(s)) return "";
  if (/^[a-z0-9-]+\.(org|com|net|info|io|to|me|cc|tv)\b/i.test(s) && !/\s/.test(s)) {
    return "";
  }
  // Strip residual site brand if it still leads the name
  s = s.replace(/^www\.[^\s]+\s*/i, "").trim();
  s = s.replace(/^[a-z0-9-]+\.(org|com|net)\s*[-–—:]?\s*/i, "").trim();

  return s.slice(0, 120);
}
