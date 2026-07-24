import type { MediaMetadata, TorrentResult } from "@/lib/torrents/types";
import {
  parseEpisode,
  seasonFolderSegment,
  type EpisodeInfo,
} from "@/lib/torrents/episodes";

/** Re-export for path callers that only import smart-category. */
export { seasonFolderSegment };
export type { EpisodeInfo };

export type ContentKind =
  | "anime"
  | "movies"
  | "tv"
  | "music"
  | "games"
  | "software"
  | "books"
  | "other";

/** Canonical kind → preferred category label order (matched against user's list). */
const KIND_ALIASES: Record<ContentKind, string[]> = {
  anime: ["Anime", "アニメ", "animation"],
  movies: ["Movies", "Movie", "Films", "Film", "Cinema"],
  tv: ["TV", "Television", "Series", "Shows", "TV Shows"],
  music: ["Music", "Audio", "FLAC", "MP3", "Albums"],
  games: ["Games", "Gaming", "PC Games", "Nintendo", "Xbox", "PS4", "PS5"],
  software: ["Software", "Apps", "Applications", "Programs"],
  books: ["Books", "eBooks", "Ebook", "Comics", "Manga"],
  other: ["Other", "Misc", "General"],
};

/** Quality / release tokens stripped for display titles and folder names. */
const QUALITY_TOKEN_RE =
  /\b(1080p|720p|480p|2160p|4k|uhd|hdr10?|dv|dolby\s*vision|hevc|x265|h\s*\.?\s*265|x264|h\s*\.?\s*264|av1|10-?bits?|8-?bits?|web-?dl|webrip|bluray|bdrip|bdr|brrip|hdtv|hdcam|remux|proper|repack|internal|limited|extended|theatrical|imax|aac(?:\s*[25]\.?\d)?|ac3|eac3|ddp?\.?(?:\s*[25]\.?\d)?|dts(?:-?hd)?|truehd|atmos|flac|mp3|opus|vorbis|dual(?:\s*audio)?|multi(?:\s*sub|audio)?|subs?|dub(?:bed)?|softsubs?|hardsubs?|nf|amzn|dsnp|hulu|atvp|pmtp|tver|cr|mkv|mp4|avi|ts|m2ts|webm|ch)\b/gi;

/** Western SxxEyy episode marker (up to 3-digit season) */
const SXXEYY_RE = /\bS(\d{1,3})\s*E(\d{1,4})\b/i;
/** Multi-season range: S01-S02, S01 – S05, Season 1-3, Seasons 1-3 */
const MULTI_SEASON_RE =
  /\bS(?:easons?)?\s*(\d{1,3})\s*[-–—~]\s*S?(?:easons?)?\s*(\d{1,3})\b/i;
/** 1x05 style */
const NXNN_RE = /\b(\d{1,2})x(\d{1,4})\b/i;
/**
 * Indexer / site junk prefixes that must never become show folders:
 *   "www.UIndex.org - ONE PIECE …" → strip domain + separator
 */
const SITE_PREFIX_RE =
  /(?:^|[\s|])(?:www\.)?[a-z0-9][a-z0-9-]*\.(?:org|com|net|info|to|me|tv|cc|io|co|ru|in|us|uk|eu|xyz|site|online)\b\s*[-–—:|]*\s*/gi;

/** Known anime fansub / encoder groups — weak signal only */
const ANIME_GROUP_RE =
  /\b(subsplease|erai-?raws|horrible\s*subs|judas|asw|ember|toonsouth|commie|doki|horriblesubs|nyaa|animetosho|ohys|gsd|fog|sallysubs|hanime|anime)\b/i;

/** Japanese anime cues beyond generic Animation genre */
const JP_ANIME_SIGNAL_RE =
  /\b(anime|ova|ona|oad|subbed|dubbed|dual\s*audio|vostfr|raws?|bd\s*box|tv\s*complete)\b/i;

function hasStrongTvStructure(title: string, ep: ReturnType<typeof parseEpisode>): boolean {
  if (SXXEYY_RE.test(title)) return true;
  if (MULTI_SEASON_RE.test(title)) return true;
  if (NXNN_RE.test(title)) return true;
  if (ep.isSeasonPack) return true;
  if (ep.season != null && ep.episode != null) return true;
  // Season N without episode (season pack style)
  if (/\bSeasons?\s*\d{1,3}\b/i.test(title) && !/\bEpisode\b/i.test(title)) {
    return true;
  }
  // Single Sxx without requiring "complete" (e.g. "Severance S01 1080p")
  if (/\bS\d{1,3}\b/i.test(title)) {
    return true;
  }
  return false;
}

function isExplicitAniListAnime(metadata?: MediaMetadata | null): boolean {
  return metadata?.source === "anilist" && metadata.mediaType === "anime";
}

/**
 * True when catalog title matches the SHOW portion of the torrent name
 * (text before SxxEyy / Ep markers), not the episode subtitle.
 * Prevents "Extreme Makeover Homer Edition" metadata from hijacking
 * "The Simpsons S37E16 Extreme Makeover…" folders.
 */
export function metadataMatchesTitle(
  torrentTitle: string,
  metadata?: MediaMetadata | null,
): boolean {
  if (!metadata?.title) return false;
  // Match against show-head only so episode titles never count as series id
  const showHead = cutAtStructuralMarker(
    torrentTitle.replace(/[._]+/g, " ").replace(SITE_PREFIX_RE, " "),
  );
  const a = normalizeForMatch(showHead || torrentTitle);
  const b = normalizeForMatch(metadata.title);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const aTokens = a.split(" ").filter((t) => t.length > 2);
  const bTokens = b.split(" ").filter((t) => t.length > 2);
  if (!aTokens.length || !bTokens.length) return false;
  const hits = bTokens.filter((t) => aTokens.includes(t)).length;
  return hits / bTokens.length >= 0.6;
}

function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(SITE_PREFIX_RE, " ")
    .replace(/[\[\](){}]/g, " ")
    .replace(
      /\b(s\d{1,3}e\d{1,4}|s\d{1,3}|1080p|720p|480p|2160p|bluray|webrip|web-?dl|hevc|x265|x264|bone|yts)\b/gi,
      " ",
    )
    .replace(/[._\-–—|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isJapaneseAnimeSignal(
  title: string,
  tags: string[],
  metadata?: MediaMetadata | null,
): boolean {
  const hay = `${title} ${tags.join(" ")}`;
  if (JP_ANIME_SIGNAL_RE.test(hay)) return true;
  if (ANIME_GROUP_RE.test(hay)) return true;
  if (isExplicitAniListAnime(metadata)) return true;
  // Bracketed short release groups + bare episode numbers (classic anime naming)
  const ep = parseEpisode(title);
  if (
    /[\[\(][A-Za-z0-9_-]{2,12}[\]\)]/.test(title) &&
    ep.episode != null &&
    ep.season == null &&
    !SXXEYY_RE.test(title)
  ) {
    return true;
  }
  return false;
}

/** Strong non-video domain signals — must beat search category + year-as-movie noise. */
const SOFTWARE_RE =
  /\b(windows\s*(7|8|10|11)|macos|mac\s*os|osx|software|installer|portable|keygen|nullsoft|nsis|msi\b|setup\.exe|winrar|7-?zip|vmware|virtualbox|parallels|photoshop|premiere|illustrator|lightroom|after\s*effects|indesign|acrobat|creative\s*cloud|autodesk|autocad|solidworks|sketchup|coreldraw|microsoft\s*office|office\s*20\d{2}|visio|visual\s*studio|intellij|pycharm|android\s*studio|xcode|final\s*cut|logic\s*pro|ableton|fl\s*studio|cubase|pro\s*tools|davinci|resolve|notion|obsidian|slack|zoom\s*client|chrome|firefox|edge\s*browser|adobe|plugin|plugins|addon|add-on|crack(?:ed)?|pre-?activated|activated|full\s*version|retail\s*multilingual)\b/i;

// Note: bare "repack" is NOT enough (anime "REPACK" releases are common).
const GAMES_RE =
  /\b(gog|steam|fitgirl|dodi|(?:fitgirl|dodi|gog|steam)\s*repack|pc\s*repack|nsw|xci|nsp|ps[345]|xbox|switch|roms?|iso\s*game|pc\s*game|game\s*of\s*the\s*year|goty|denuvo)\b/i;

const MUSIC_RE =
  /\b(flac|alac|320kbps|vinyl|discography|ost|soundtrack|album|single|lossless|cd\s*rip)\b/i;

const BOOKS_RE =
  /\b(epub|mobi|azw3|ebook|audiobook|comic|cbr|cbz)\b/i;

/** Product/version style common on app releases (v25.5.1, v2024.1) */
const APP_VERSION_RE = /\bv\d{1,2}(?:\.\d{1,3}){1,3}\b/i;

export function isStrongSoftwareSignal(title: string, tags: string[] = []): boolean {
  const hay = `${title} ${tags.join(" ")}`;
  if (SOFTWARE_RE.test(hay)) return true;
  // Adobe / Microsoft product lines without the brand word alone
  if (
    /\b(photoshop|premiere\s*pro|illustrator|lightroom|after\s*effects)\b/i.test(
      hay,
    )
  ) {
    return true;
  }
  // "Name v25.5.1 + Fix (macOS|Windows)" style
  if (
    APP_VERSION_RE.test(title) &&
    /\b(fix|crack|keygen|activated|portable|installer|macos|windows|win\s*10|win\s*11)\b/i.test(
      hay,
    )
  ) {
    return true;
  }
  return false;
}

export function isStrongGamesSignal(title: string, tags: string[] = []): boolean {
  return GAMES_RE.test(`${title} ${tags.join(" ")}`);
}

/**
 * Infer content kind from torrent title, tags, metadata, and optional search category.
 *
 * Priority:
 * 1. Strong TV structure (SxxEyy, S01-S02, season packs) → TV unless AniList anime
 * 2. Strong domain signals: software / games / music / books
 *    (must beat searchCategory=movies and year-only movie scores —
 *     e.g. "Adobe Photoshop 2024 v25.5.1 + Fix (macOS)" is Software, not Movies)
 * 3. Metadata when it matches THIS title (AniList / TMDB)
 * 4. Source bias: YTS → movies; Nyaa → anime (with exceptions)
 * 5. Search category hint (weak)
 * 6. Score-based residual heuristics
 */
export function detectContentKind(input: {
  title: string;
  tags?: string[];
  metadata?: MediaMetadata | null;
  searchCategory?: string | null;
  source?: string | null;
}): ContentKind {
  const title = input.title || "";
  const lower = title.toLowerCase();
  const tags = (input.tags ?? []).map((t) => t.toLowerCase());
  const hay = `${lower} ${tags.join(" ")}`;
  const ep = parseEpisode(title);
  const meta = input.metadata ?? null;
  const strongTv = hasStrongTvStructure(title, ep);
  const strongSoftware = isStrongSoftwareSignal(title, tags);
  const strongGames = isStrongGamesSignal(title, tags);

  // Metadata only counts if it plausibly matches THIS torrent title
  // (enrichment used to stamp the query match onto every result)
  const metaBelongsToTitle = metadataMatchesTitle(title, meta);

  // --- Strong structural season markers ---
  // Western packs on TPB/etc: "Atlantis 2013 S01-S02 ... BONE" → TV
  // Nyaa + season markers: still anime-first (fansub SxxEyy is normal)
  if (strongTv) {
    if (
      metaBelongsToTitle &&
      (isExplicitAniListAnime(meta) || meta?.mediaType === "anime")
    ) {
      return "anime";
    }
    // Matching TMDB TV + Animation + JP anime cues (dual audio / subbed / groups)
    if (metaBelongsToTitle && meta?.mediaType === "tv") {
      const genres = (meta.genres ?? []).map((g) => g.toLowerCase());
      const isAnimation = genres.some(
        (g) => g === "animation" || g === "anime",
      );
      if (isAnimation && isJapaneseAnimeSignal(title, tags, meta)) {
        return "anime";
      }
    }
    if (input.source === "nyaa" && !/\b(live\s*action)\b/i.test(title)) {
      // Nyaa is anime-first: SxxEyy / season packs on Nyaa are anime unless
      // explicitly live-action. (Western TV rarely appears on Nyaa.)
      return "anime";
    }
    // apibay / 1337x / torrentscsv / unknown → TV for S01-S02 packs
    return "tv";
  }

  // --- Domain signals BEFORE search category / weak metadata ---
  // "Adobe Photoshop 2024 … (macOS)" must never become Movies via year or
  // because the user had Movies selected in the search filter.
  if (strongSoftware) return "software";
  if (strongGames) return "games";

  if (
    MUSIC_RE.test(hay) &&
    !/\b(game|iso|bluray|1080p|web-?dl|720p|2160p|x264|x265)\b/i.test(hay)
  ) {
    return "music";
  }

  if (
    /\b(epub|mobi|azw3|ebook|audiobook|comic|cbr|cbz)\b/i.test(hay) &&
    !/\b(1080p|720p|bluray|webrip|x264|x265)\b/i.test(hay)
  ) {
    return "books";
  }

  // --- Metadata (only when it matches this release title) ---
  // Skip movie metadata when software/games signals already handled above.
  if (metaBelongsToTitle) {
    if (isExplicitAniListAnime(meta) || meta?.mediaType === "anime") {
      return "anime";
    }
    if (meta?.mediaType === "movie") return "movies";
    if (meta?.mediaType === "tv") {
      const genres = (meta.genres ?? []).map((g) => g.toLowerCase());
      const isAnimation = genres.some(
        (g) => g === "animation" || g === "anime",
      );
      if (isAnimation && isJapaneseAnimeSignal(title, tags, meta)) {
        return "anime";
      }
      return "tv";
    }
  }

  // --- Source bias ---
  if (input.source === "yts") return "movies";

  if (input.source === "nyaa") {
    if (/\b(live\s*action|drama)\b/i.test(title)) return "tv";
    if (MUSIC_RE.test(hay)) return "music";
    // Strong movie cues without TV structure
    if (
      /\b(19|20)\d{2}\b/.test(title) &&
      /\b(bluray|bdrip|remux|web-?dl|hdtv)\b/i.test(hay) &&
      !strongTv &&
      ep.episode == null
    ) {
      return "movies";
    }
    // Anime bias only when no strong TV/movie structural signals
    return "anime";
  }

  // --- Search category hint (weaker than domain / structure / metadata) ---
  const sc = (input.searchCategory ?? "").toLowerCase();
  if (sc === "apps" || sc === "software") return "software";
  if (sc === "games") return "games";
  if (sc === "music") return "music";
  if (sc === "anime" && !strongTv) return "anime";
  // movies/tv search filters are hints only — never override domain signals
  // (already handled). Still respect them when no domain signal.
  if (sc === "movies") return "movies";
  if (sc === "tv") return "tv";

  // --- Score-based (TV ranges / packs already handled; this is residual) ---
  let animeScore = 0;
  if (ANIME_GROUP_RE.test(hay) || JP_ANIME_SIGNAL_RE.test(hay)) animeScore += 2;
  if (
    /[\[\(][A-Za-z0-9_-]{2,12}[\]\)]/.test(title) &&
    ep.episode != null &&
    ep.season == null &&
    !SXXEYY_RE.test(title)
  ) {
    animeScore += 1;
  }
  if (/\b(ova|ona|specials?)\b/i.test(hay)) animeScore += 1;
  // Do NOT score HEVC/x265/BluRay/release-group-looking tokens as anime —
  // those are universal and caused false positives (e.g. BONE / HEVC packs).

  let tvScore = 0;
  if (strongTv) tvScore += 4; // must beat anime heuristics
  if (MULTI_SEASON_RE.test(title)) tvScore += 2;
  if (SXXEYY_RE.test(title) || NXNN_RE.test(title)) tvScore += 2;
  if (ep.isSeasonPack || /\b(complete\s*series|season\s*\d+)\b/i.test(hay)) {
    tvScore += 2;
  }
  if (ep.season != null && ep.episode != null) tvScore += 2;

  let movieScore = 0;
  // Year alone is a weak movie signal — do not use it when the title looks
  // like an app version release (v25.x, + Fix, portable, etc.)
  const looksLikeAppRelease =
    APP_VERSION_RE.test(title) ||
    /\b(fix|portable|installer|keygen|pre-?activated)\b/i.test(hay);

  if (
    !looksLikeAppRelease &&
    /\b(19|20)\d{2}\b/.test(title) &&
    !SXXEYY_RE.test(title) &&
    !MULTI_SEASON_RE.test(title) &&
    ep.episode == null &&
    !strongTv
  ) {
    movieScore += 1;
  }
  if (
    !looksLikeAppRelease &&
    /\b(bluray|bdrip|remux|web-?dl|hddvd|theatrical|imax)\b/i.test(hay) &&
    !SXXEYY_RE.test(title) &&
    !MULTI_SEASON_RE.test(title) &&
    !strongTv
  ) {
    movieScore += 1;
  }
  if (
    !looksLikeAppRelease &&
    /\b(1080p|2160p|720p)\b/i.test(hay) &&
    !/\bS\d{1,2}|season|episode|ep\s*\d/i.test(hay) &&
    !strongTv
  ) {
    movieScore += 1;
  }

  // TV season structure always outranks anime when both present
  if (tvScore >= 2 && tvScore >= animeScore) return "tv";
  if (animeScore >= 2 && animeScore > tvScore) return "anime";
  if (movieScore >= 2 && movieScore > tvScore && movieScore > animeScore) {
    return "movies";
  }
  if (tvScore >= 1) return "tv";
  if (animeScore >= 1 && tvScore === 0) return "anime";
  if (movieScore >= 1) return "movies";

  return "other";
}

/**
 * Map detected kind to a category name from the user's category list.
 */
export function pickCategoryLabel(
  kind: ContentKind,
  userCategories: string[],
): string {
  const aliases = KIND_ALIASES[kind];
  const list = userCategories.length
    ? userCategories
    : Object.values(KIND_ALIASES).flat();

  for (const alias of aliases) {
    const hit = list.find((c) => c.toLowerCase() === alias.toLowerCase());
    if (hit) return hit;
  }

  for (const alias of aliases) {
    const hit = list.find((c) =>
      c.toLowerCase().includes(alias.toLowerCase()),
    );
    if (hit) return hit;
  }

  return aliases[0] || "Other";
}

/**
 * Strip quality / codec / episode markers from a torrent title for display.
 * Prefer {@link showFolderName} for download folders (episode-stable).
 */
export function segmentTitle(title: string): string {
  return cleanReleaseTitle(title);
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
      (showNorm === metaNorm ||
        showNorm.includes(metaNorm) ||
        metaNorm.includes(showNorm))
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
function cutAtStructuralMarker(title: string): string {
  const patterns: RegExp[] = [
    /\bS\d{1,3}\s*E\d{1,4}\b/i,
    /\bS(?:easons?)?\s*\d{1,3}\s*[-–—~]\s*S?(?:easons?)?\s*\d{1,3}\b/i,
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

export interface ResolveSmartPathOptions {
  /** Full release title (used when metadata missing). */
  title?: string | null;
  /** Catalog title — preferred for stable show folders. */
  metadata?: MediaMetadata | null;
  /** When true (default for TV/anime), nest under show folder. */
  nestShowFolder?: boolean;
  /**
   * When true (default for TV and anime with a known season), append
   * Season XX under the show. Absolute-only anime eps stay flat.
   * Multi-season packs stay at show root.
   */
  nestSeasonFolder?: boolean;
  /** Path separator override (defaults to /; Windows callers may pass \\). */
  separator?: string;
}

/**
 * Build a download path (Sonarr/Radarr-style):
 *   base/Category
 *   base/Category/Show Name                 (anime absolute ep / multi-season pack)
 *   base/Category/Show Name/Season 23       (TV or anime when season known)
 *   base/Category/Movie Name                (movies)
 *
 * Episodes of the same show always share the same show folder.
 * Never use indexer site names (www.UIndex.org - …) as folder names.
 */
export function resolveSmartPath(
  basePath: string,
  kind: ContentKind,
  category: string,
  options?: ResolveSmartPathOptions,
): string {
  const sep = options?.separator ?? "/";
  const base = (basePath || "").replace(/[/\\]+$/, "");
  // Empty string means "base is already the category root" (pathRules) — do not fill in
  const catRaw =
    category === ""
      ? ""
      : (category ?? pickCategoryLabel(kind, []));
  const cat = catRaw.replace(/^[/\\]+|[/\\]+$/g, "");

  if (!base) return cat || "";

  // cat may be empty when `base` is already a category root (pathRules)
  let path = cat ? `${base}${sep}${cat}` : base;

  const shouldNestShow =
    options?.nestShowFolder !== false &&
    (kind === "tv" || kind === "anime" || kind === "movies") &&
    (options?.title || options?.metadata?.title);

  if (shouldNestShow) {
    const show = showFolderName(
      options?.title || options?.metadata?.title || "",
      options?.metadata,
    );
    if (show) {
      path = `${path}${sep}${show}`;

      // Season folder for TV + anime when a single season is known
      // (SxxEyy, EP+S hybrid, single-season pack). Multi-season → show root.
      // Absolute-only anime (no season) stays flat under show.
      const nestSeason =
        options?.nestSeasonFolder !== false &&
        (kind === "tv" || kind === "anime");
      if (nestSeason && options?.title) {
        const ep = parseEpisode(options.title);
        const seasonSeg = seasonFolderSegment(ep);
        if (seasonSeg) {
          path = `${path}${sep}${seasonSeg}`;
        }
      }
    }
  }

  return path;
}

export function smartCategorize(
  torrent: {
    title: string;
    tags?: string[];
    metadata?: MediaMetadata | null;
    source?: TorrentResult["source"] | null;
  },
  userCategories: string[],
  searchCategory?: string | null,
): {
  kind: ContentKind;
  category: string;
  confidence: "high" | "medium" | "low";
} {
  const kind = detectContentKind({
    title: torrent.title,
    tags: torrent.tags,
    metadata: torrent.metadata,
    searchCategory,
    source: torrent.source,
  });

  const category = pickCategoryLabel(kind, userCategories);

  let confidence: "high" | "medium" | "low" = "medium";
  const title = torrent.title || "";
  const ep = parseEpisode(title);
  const strongTv = hasStrongTvStructure(title, ep);

  if (kind === "software" && isStrongSoftwareSignal(title, torrent.tags ?? [])) {
    confidence = "high";
  } else if (kind === "games" && isStrongGamesSignal(title, torrent.tags ?? [])) {
    confidence = "high";
  } else if (torrent.metadata?.mediaType && metadataMatchesTitle(title, torrent.metadata)) {
    confidence = "high";
  } else if (strongTv && kind === "tv") confidence = "high";
  else if (torrent.source === "yts" && kind === "movies") confidence = "high";
  else if (torrent.source === "nyaa" && kind === "anime") confidence = "high";
  else if (kind === "other") confidence = "low";

  return { kind, category, confidence };
}
