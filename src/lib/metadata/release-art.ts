/**
 * Turning the things this app actually stores into artwork queries.
 *
 * Every surface outside Browse holds *release names*, not works: the client
 * table has `Dune.Part.Two.2024.2160p.BluRay.REMUX...`, the activity log has
 * `Severance S02E05 2160p ATVP WEB-DL...`, the download log has the same. None
 * of them carry a poster, so all six of those pages rendered as walls of
 * monospace-looking text while Browse had artwork.
 *
 * This module is the one place that decides what a release name is *about*, so
 * the client table and the activity log cannot disagree about it — and so the
 * cache key is identical across surfaces and three pages showing the same show
 * cost one lookup, not three.
 *
 * Pure and network-free: `release-art.test.ts` drives it as a table.
 */
import { cleanQueryTitle, type ArtworkQuery } from "./artwork";
import { cleanTorrentTitle } from "./clean-torrent-title";
import { normalizeMediaType } from "./media-type";

export interface ReleaseArtworkQuery extends ArtworkQuery {
  /**
   * Stable identity for this *work*, not this release.
   *
   * Two episodes of one show, and the grab row and the history row describing
   * one send, must collapse to a single key — that is what makes a page of 18
   * rows cost 5 lookups.
   */
  key: string;
}

/** `anime` / `movie` / `tv` as the torrent client and grab log spell them. */
function mediaTypeFrom(category: string | null | undefined): ArtworkQuery["mediaType"] {
  const normalized = normalizeMediaType(category);
  return normalized ?? null;
}

/** A fansub group tag, `[SubsPlease]` / `[Erai-raws]`, anywhere in the name. */
const FANSUB_TAG = /\[[a-z][a-z0-9 _.\-]{2,20}\]/i;

/**
 * What a release *looks* like when nothing told us.
 *
 * The download log stores no category at all — it is a list of titles and
 * nothing else — so without this every one of its rows would route through the
 * "unknown" path and could pick a different provider, and therefore a
 * different poster, than the activity row describing the same send. Two pages
 * disagreeing about one show's cover is exactly the kind of small dishonesty
 * that makes an app feel broken.
 *
 * Only structural evidence, never a word list:
 *   - a season/episode token means television;
 *   - a fansub group tag with a `- 29` episode number means anime, which is
 *     how essentially all of it is named;
 *   - a year and no episode marker means a film.
 */
function inferMediaType(name: string): ArtworkQuery["mediaType"] {
  if (SEASON_MARKER.test(name)) return "tv";
  if (EPISODE_DASH.test(name)) return FANSUB_TAG.test(name) ? "anime" : "tv";
  if (findYear(name)) return "movie";
  return null;
}

/**
 * A file name is not a title: strip the container so `…(1080p) [F1D2A9C0].mkv`
 * does not become part of the query. Only extensions this app actually plays.
 */
const CONTAINER = /\.(mkv|mp4|avi|m4v|mov|ts|webm|wmv|flv|mpg|mpeg)$/i;

/**
 * A tracker's own name, stamped on the front of the release.
 *
 * `www.UIndex.org - Rick and Morty S01E01 Pilot 1080p AMZN WEB-DL…` is a real
 * row from this app's torrent list. The site tag is not part of the work, and
 * leaving it in front produced a card captioned "Rick and Morty" wearing a
 * letter tile that said "W". Requires a real TLD, so nothing that merely
 * contains a dot — `Dune.Part.Two`, `S.W.A.T.` — is touched.
 */
const SITE_PREFIX =
  /^\s*[[(]?\s*(?:www\.)?[a-z0-9][a-z0-9-]*\.(?:com|org|net|to|me|cc|tv|io|info|biz|xyz|se|eu|nu|ag|la)\b\s*[\])]?\s*[-\u2013\u2014:]*\s*/i;

/**
 * The first structural marker in a release name, which is where the title ends.
 *
 * Scene names are `Title` + `marker` + noise, and the marker is always either a
 * season/episode token or the year. Everything after it is codecs, sources,
 * channel layouts and group tags — an open set no denylist finishes covering.
 * Cutting at the marker is what makes
 * `Dune.Prophecy.S01E01.The.Hidden.Hand.2160p.MAX.WEB-DL.DDP5.1.Atmos.HDR.H.265-NTb`
 * resolve to *Dune: Prophecy* rather than to nothing: the episode title alone
 * defeats a denylist, because "The Hidden Hand" is not noise, it is just not
 * part of the show's name.
 */
const SEASON_MARKER =
  /[\s._\-[(]+(S\d{1,2}E\d{1,3}|S\d{1,2}\b|Season\s*\d+|E\d{1,3}\b)/i;
/**
 * The fansub convention, `Title - 28`, which is how nearly all anime arrives
 * and the only episode marker that is not an `SxxExx`.
 */
const EPISODE_DASH = /\s[-\u2013\u2014]\s*\d{1,4}(?=\s|$|[[(])/;
/**
 * The resolution / source token, which is where the technical tail begins.
 *
 * Needed because a release is allowed to declare no year and no episode:
 * `Blade Runner 2049 2160p UHD BluRay x265-TERMiNAL` has neither, and without
 * this rule the group tag survives into the query as
 * "Blade Runner 2049 TERMiNAL". Nothing after a resolution is ever part of a
 * title, so this is a safe last structural cut.
 */
const QUALITY_MARKER =
  /[\s._\-[(]+(\d{3,4}[pi]\b|4K\b|UHD\b|BluRay\b|BDRip\b|BRRip\b|WEB[-._]?DL\b|WEBRip\b|HDTV\b|DVDRip\b|HDRip\b|REMUX\b)/i;
/** Every `19xx`/`20xx` in the name; the *first plausible* one ends the title. */
const YEAR_MARKERS = /[\s._\-[(]+((?:19|20)\d{2})(?![\d\w])/g;

function plausible(year: number): boolean {
  return year >= 1900 && year <= new Date().getFullYear() + 5;
}

/** Where the release year sits, if it declared one at all. */
function findYear(name: string): { year: number; index: number } | null {
  for (const match of name.matchAll(YEAR_MARKERS)) {
    const year = Number(match[1]);
    // `Blade Runner 2049 2017 2160p…` has two: 2049 belongs to the title and
    // 2017 is the release. Only a year that could actually be a release date
    // is allowed to end the title — the regression this repo already has.
    if (plausible(year) && typeof match.index === "number") {
      return { year, index: match.index };
    }
  }
  return null;
}

/**
 * What a release name is about: the work, and the year if it declared one.
 *
 * Falls back through four rules, strongest evidence first, because each one
 * only fires when the release actually carries that evidence:
 *   1. season/episode marker  — `The.Bear.S03E06.1080p…`  -> "The Bear"
 *   2. fansub episode dash    — `Sousou no Frieren - 28…` -> "Sousou no Frieren"
 *   3. plausible year         — `Arrival.2016.1080p…`     -> "Arrival", 2016
 *   4. first token with a digit, after the standard denylist
 */
function titleAndYear(raw: string): { title: string; year: number | null } {
  const name = raw.replace(CONTAINER, "").replace(SITE_PREFIX, "").trim();

  const found = findYear(name);
  const year = found?.year ?? null;

  const seasonAt = name.match(SEASON_MARKER)?.index;
  const episodeAt = name.match(EPISODE_DASH)?.index;
  const qualityAt = name.match(QUALITY_MARKER)?.index;
  // A season marker beats a year even when the year comes first, because
  // `Shogun.2024.S01.COMPLETE…` is still just "Shogun" — but the year is worth
  // keeping, since a series year is useful evidence and never a hard filter.
  const cutAt = [seasonAt, episodeAt, found?.index, qualityAt]
    .filter((i): i is number => typeof i === "number" && i > 0)
    .sort((a, b) => a - b)[0];

  if (cutAt !== undefined) {
    const head = cleanTorrentTitle(name.slice(0, cutAt));
    if (head) return { title: head, year };
  }

  // No marker at all: lean on the shared denylist, then stop at the first
  // token carrying a digit. A four-digit number from 1900 on is exempt — it is
  // far more likely to be part of the title (*Blade Runner 2049*, *1917*,
  // *2012*) than a stray, and a release year would have been caught above.
  const cleaned = cleanTorrentTitle(name);
  const words = cleaned.split(/\s+/).filter(Boolean);
  const firstNumeric = words.findIndex(
    (w) => /\d/.test(w) && !(/^\d{4}$/.test(w) && Number(w) >= 1900),
  );
  if (firstNumeric > 0) {
    return { title: words.slice(0, firstNumeric).join(" "), year };
  }

  const fallback = cleanQueryTitle(cleaned);
  return { title: fallback.title || cleaned, year: year ?? fallback.year };
}

export function artworkQueryForRelease(
  name: string,
  category?: string | null,
): ReleaseArtworkQuery {
  const raw = name ?? "";
  const { title, year } = titleAndYear(raw);
  // What the row says it is beats what it looks like; inference only fills a
  // gap, it never overrules a stored category.
  const mediaType = mediaTypeFrom(category) ?? inferMediaType(raw);
  return {
    title,
    year,
    mediaType,
    key: artworkKey(title, year),
  };
}

/**
 * The key two different surfaces must agree on.
 *
 * Lower-cased and stripped of anything that is not a letter or digit, so
 * `The Bear` and `the.bear` are one entry. The year is part of it because two
 * films can share a name — collapsing *Dune* (1984) into *Dune* (2021) is the
 * wrong-poster bug this project already had.
 *
 * Media type is deliberately *not* part of it. The activity log proves why: a
 * grab row carries a category and the download-log row describing the very
 * same send does not, so keying on media type split one work into
 * `tv:severance` and `any:severance` — two lookups, two cache entries, and two
 * chances to disagree about the poster on one screen.
 */
export function artworkKey(
  title: string,
  year: number | null | undefined,
): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${slug}:${year ?? ""}`;
}

/**
 * Collapse a list of release names to the distinct works they describe.
 *
 * Order-preserving on first appearance, so a caller can zip the result back
 * onto its rows, and de-duplicated, which is the entire point: the seeded
 * client table is 8 rows and 8 works, but the activity log is 19 rows and 10.
 *
 * A row that knows what it is teaches the rows that do not: the download log
 * stores no category, so `Severance S02E04…` arrives with `mediaType: null`
 * while the grab row for the same send arrives as `tv`. Whichever comes first,
 * the typed one wins — routing the lookup at TVmaze instead of guessing.
 */
export function distinctArtworkQueries(
  releases: readonly { name: string; category?: string | null }[],
): ReleaseArtworkQuery[] {
  const seen = new Map<string, ReleaseArtworkQuery>();
  for (const release of releases) {
    const query = artworkQueryForRelease(release.name, release.category);
    // A name that parses to nothing — blank, or pure release noise — is not a
    // work, and asking a provider about "" costs a request to learn that.
    if (!query.title) continue;
    const existing = seen.get(query.key);
    if (!existing) {
      seen.set(query.key, query);
    } else if (!existing.mediaType && query.mediaType) {
      seen.set(query.key, { ...existing, mediaType: query.mediaType });
    }
  }
  return [...seen.values()];
}
