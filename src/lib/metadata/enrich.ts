import type { MediaMetadata, TorrentResult } from "@/lib/torrents/types";
import { normalizeTitle } from "@/lib/utils";
import { searchAniList } from "./anilist";
import { resolveArtwork } from "./artwork";
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
      // A bare season token (`S03`, `S01-S03`) is by far the most common thing
      // a person types after a show name, and catalogs match it literally:
      // TMDB returns nothing at all for "The Bear S03", so every result in a
      // season search rendered without artwork.
      /\b(S\d{1,2}\s*-\s*S?\d{1,2}|S\d{1,2}E\d{1,3}(?:\s*-\s*E?\d{1,3})?|S\d{1,2}|E\d{1,3}|EP?\s*\d{1,3}|Season\s*\d+|Complete|Batch)\b/gi,
      " ",
    )
    .replace(
      /\b(1080p|720p|480p|2160p|4K|UHD|HDR10?\+?|DV|HEVC|x265|x264|H\.?26[45]|AV1|WEB-?DL|WEBRip|BluRay|BDRip|BRRip|DVDRip|HDTV|REMUX|PROPER|REPACK|FINAL|INTERNAL|LIMITED|AAC\d?|FLAC|DTS(?:-HD)?|DDP?\d?(?:\.\d)?|EAC3|AC3|Atmos|TrueHD|\d+bit|Dual|Multi|Sub|Dub|NF|AMZN|DSNP|HULU|HMAX|ATVP|iP|CR)\b/gi,
      " ",
    )
    .replace(/[._\-–—|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Progressively shorter things to ask a catalog, best first.
 *
 * Release names carry noise no denylist will ever fully cover — scene groups,
 * codecs nobody has heard of, "FINAL". Catalogs match literally, so one stray
 * token is the difference between a poster and a grey box. Rather than grow
 * the denylist forever, fall back to a shorter prefix: everything up to the
 * first token containing a digit, then the first three words.
 */
function titleCandidates(cleaned: string): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    const v = s.trim();
    if (v.length > 1 && !out.includes(v)) out.push(v);
  };

  push(cleaned);

  const words = cleaned.split(/\s+/);
  const firstNoisy = words.findIndex((w) => /\d/.test(w));
  if (firstNoisy > 0) push(words.slice(0, firstNoisy).join(" "));
  if (words.length > 3) push(words.slice(0, 3).join(" "));
  if (words.length > 2) push(words.slice(0, 2).join(" "));

  return out;
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

function metadataNames(metadata: MediaMetadata): string[] {
  return [...new Set(
    [metadata.title, ...(metadata.aliases ?? [])]
      .map((name) => name?.trim())
      .filter((name): name is string => Boolean(name)),
  )];
}

function identityTokens(value: string): string[] {
  return normalizeTitle(value)
    .split(" ")
    .filter(
      (token) =>
        token.length > 1 &&
        !/^(?:season|series|episode|episodes|part|cour|\d+(?:st|nd|rd|th))$/.test(
          token,
        ),
    );
}

function nameCompatible(subject: string, catalogName: string): boolean {
  const comparableName = (value: string) =>
    normalizeTitle(value)
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  const normalizedSubject = comparableName(subject);
  const normalizedCatalog = comparableName(catalogName);
  if (!normalizedSubject || !normalizedCatalog) return false;
  if (
    normalizedSubject === normalizedCatalog ||
    normalizedSubject.includes(normalizedCatalog) ||
    normalizedCatalog.includes(normalizedSubject)
  ) {
    return true;
  }

  const subjectTokens = new Set(identityTokens(normalizedSubject));
  const catalogTokens = identityTokens(normalizedCatalog);
  if (catalogTokens.length === 0) return false;
  const matches = catalogTokens.filter((token) => subjectTokens.has(token)).length;
  return matches >= 2 && matches / catalogTokens.length >= 0.8;
}

function explicitQualifierYear(value: string, catalogNames: string[]): number | null {
  const titleNumbers = new Set(
    catalogNames.flatMap((name) =>
      [...name.matchAll(/\b((?:19|20)\d{2})\b/g)].map((match) =>
        Number(match[1]),
      ),
    ),
  );
  for (const match of value.matchAll(/\b((?:19|20)\d{2})\b/g)) {
    const year = Number(match[1]);
    if (!titleNumbers.has(year)) return year;
  }
  return null;
}

/**
 * Metadata may decorate a release only when its title/aliases, year and media
 * type remain compatible with both the release and the owner's search intent.
 */
export function metadataIdentityCompatible(
  rawTitle: string,
  metadata: MediaMetadata,
  query = rawTitle,
  category?: string,
): boolean {
  const expected = category ? EXPECTED_MEDIA_TYPES[category] : undefined;
  if (expected && !expected.includes(metadata.mediaType)) return false;

  const names = metadataNames(metadata);
  const queryYear = explicitQualifierYear(query, names);
  if (queryYear != null && metadata.year != null && queryYear !== metadata.year) {
    return false;
  }
  const releaseYear = explicitQualifierYear(rawTitle, names);
  if (
    metadata.mediaType === "movie" &&
    releaseYear != null &&
    metadata.year != null &&
    releaseYear !== metadata.year
  ) {
    return false;
  }

  const releaseSubject = cleanTorrentTitle(rawTitle);
  if (!names.some((name) => nameCompatible(releaseSubject, name))) return false;

  const querySubject = cleanTorrentTitle(query);
  return (
    !querySubject ||
    names.some((name) => nameCompatible(querySubject, name))
  );
}

/**
 * Media types that plausibly answer a request for `category`.
 *
 * Catalogs are full of a film and a series sharing a name — "Severance" is a
 * 2015 horror comedy and a 2022 Apple TV series, both an exact title match, so
 * whichever the catalog listed first used to win. Getting this wrong is not
 * cosmetic: the id is stored on the library row, and every later lookup
 * (episode hunts, recommendations) is then made against the wrong title.
 * Anime is deliberately permissive — anime exists as both series and films.
 */
const EXPECTED_MEDIA_TYPES: Record<string, MediaMetadata["mediaType"][]> = {
  anime: ["anime", "tv", "movie"],
  tv: ["tv", "anime"],
  movies: ["movie", "anime"],
  movie: ["movie", "anime"],
};

const WRONG_MEDIA_TYPE_PENALTY = 25;

function mediaTypePenalty(
  category: string | undefined,
  mediaType: MediaMetadata["mediaType"],
): number {
  if (!category) return 0;
  const expected = EXPECTED_MEDIA_TYPES[category];
  if (!expected) return 0;
  return expected.includes(mediaType) ? 0 : WRONG_MEDIA_TYPE_PENALTY;
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

  for (const candidate of titleCandidates(cleaned)) {
    const hit = await lookupOnce(candidate, category, preferAnime);
    if (hit.score > bestScore) {
      bestScore = hit.score;
      best = hit.best;
    }
    // A shorter prefix is a guess; stop as soon as one is convincing.
    if (bestScore >= 55) break;
  }

  // Require a minimum match quality
  const matched = bestScore >= 40 ? best : null;
  const result = matched ? await withArtwork(matched) : null;
  // Negative answers are often a rate limit or a blip upstream. Remembering
  // "no artwork" for half an hour turns a five-second outage into a page of
  // grey boxes long after it has passed.
  setMemoryQueryCache(memKey, result, result ? undefined : 1000 * 60 * 3);

  if (result) {
    void setCachedMetadata(result);
  }

  return result;
}

/**
 * Fill in art the catalog that answered did not have.
 *
 * A record with no poster is a grey letter tile, which is what the whole app
 * looked like while TMDB was gated on a placeholder key. The artwork resolver
 * has keyless providers this module does not (TVmaze, iTunes) and its own
 * cache, so asking it is cheap and only happens when something is actually
 * missing. AniList in particular answers with a cover and no banner far more
 * often than not, and the title-detail hero needs the banner.
 *
 * `resolveArtwork` never throws and never returns art it cannot vouch for, so
 * the worst case here is the record passing through unchanged.
 */
async function withArtwork(meta: MediaMetadata): Promise<MediaMetadata> {
  if (meta.posterUrl && meta.backdropUrl) return meta;

  const art = await resolveArtwork({
    title: meta.title,
    year: meta.year ?? null,
    mediaType: meta.mediaType,
  });
  if (!art.posterUrl && !art.backdropUrl) return meta;

  return {
    ...meta,
    posterUrl: meta.posterUrl ?? art.posterUrl,
    backdropUrl: meta.backdropUrl ?? art.backdropUrl,
  };
}

/** One pass over both catalogs for a single candidate string. */
async function lookupOnce(
  cleaned: string,
  category: string | undefined,
  preferAnime: boolean,
): Promise<{ best: MediaMetadata | null; score: number }> {
  let best: MediaMetadata | null = null;
  let bestScore = 0;

  try {
    if (preferAnime || category === "all" || !category) {
      const animeHits = await searchAniList(cleaned, 5);
      for (const hit of animeHits) {
        if (!metadataIdentityCompatible(cleaned, hit, cleaned, category)) continue;
        const s =
          Math.max(
            ...metadataNames(hit).map((name) => scoreMatch(cleaned, name)),
          ) - mediaTypePenalty(category, hit.mediaType);
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
        if (!metadataIdentityCompatible(cleaned, hit, cleaned, category)) continue;
        const s =
          Math.max(
            ...metadataNames(hit).map((name) => scoreMatch(cleaned, name)),
          ) - mediaTypePenalty(category, hit.mediaType);
        // slight preference for anime when category is anime
        const adjusted = preferAnime && hit.mediaType !== "anime" ? s - 5 : s;
        // TMDB wins ties unless the request actually points at anime. Both
        // catalogs carry same-named shows — "The Bear" is an FX drama on TMDB
        // and a separate anime on AniList — and they score identically, so
        // whichever is queried first used to win by accident. The general
        // catalog is the safer default; a genuinely Japanese animated show
        // still resolves to anime from its TMDB origin + Animation genre.
        if (adjusted > bestScore || (!preferAnime && adjusted === bestScore)) {
          bestScore = adjusted;
          best = hit;
        }
      }
    } catch {
      // TMDB optional
    }
  }

  return { best, score: bestScore };
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

  // Two different limits, deliberately. TMDB/AniList *lookups* are the scarce,
  // rate-limited resource, so we resolve metadata for at most 6 unique titles
  // drawn from the top 16 results. *Attaching* that already-resolved metadata,
  // by contrast, costs nothing — it is a Map read plus a string match — so it
  // runs for every result below, not just the top 16. Capping attachment too
  // was a bug: an unreleased work whose best release ranked past 16 came back
  // with `metadata: null`, so grouping never saw its release date and the
  // "not out yet" gate silently failed. Reading the cached map for all rows
  // fixes that without a single extra network call.
  const top = results.slice(0, 16);
  const uniqueTitles = [
    ...new Set(top.map((r) => cleanTorrentTitle(r.title)).filter(Boolean)),
  ].slice(0, 6);

  const titleMeta = new Map<string, MediaMetadata | null>();
  await Promise.all(
    uniqueTitles.map(async (t) => {
      // Prefer a title-specific lookup; fall back to primary only if it matches
      let meta = await resolveMetadata(t, category);
      if (
        !meta &&
        primary &&
        metadataIdentityCompatible(t, primary, query, category)
      ) {
        meta = primary;
      }
      titleMeta.set(t, meta);
    }),
  );

  return results.map((r) => {
    const key = cleanTorrentTitle(r.title);
    let meta = titleMeta.get(key) ?? null;

    // Drop metadata that doesn't belong on this release
    if (
      meta &&
      !metadataIdentityCompatible(r.title, meta, query, category)
    ) {
      meta = null;
    }

    // A title-specific lookup can be led astray by a release-group prefix. Once
    // rejected, reuse the query identity only when it independently matches the
    // full release and the requested media/year context.
    if (
      !meta &&
      primary &&
      metadataIdentityCompatible(r.title, primary, query, category)
    ) {
      meta = primary;
    }

    return { ...r, metadata: meta };
  });
}
