/**
 * Work identity: which *film or series* a release actually belongs to.
 *
 * A search for "dune" returns releases from at least five distinct works:
 *
 *   Dune (1984)                     — film
 *   Children of Dune (2003)         — miniseries
 *   Dune (2021)                     — film
 *   Dune: Part Two (2024)           — film
 *   Dune: Prophecy (2024)           — series
 *
 * The search page collapsed all 127 of them under a single header reading
 * **"DUNE · 2017 · 127 releases"**, with an "S01" tab that interleaved
 * *Dune: Prophecy* episodes with *Children of Dune* episodes. Three things
 * went wrong at once, and they are worth separating because only the third is
 * a judgement call:
 *
 *  1. **The subject was decided by a majority vote on `metadata.title`.** If
 *     60% of the top 16 enriched rows shared a catalog title, the entire page
 *     was declared to be that one show. A page can be 60% one work and 40%
 *     another; the header then speaks confidently for releases it has never
 *     seen. "127 releases" was the size of the *page*, not of the work.
 *  2. **The vote keyed on catalog metadata, which is exactly the thing that
 *     was wrong.** Neither 1984, 2003, 2021 nor 2024 is 2017 — the enrichment
 *     had fuzzy-matched most of the page onto some unrelated catalog row, and
 *     because every downstream decision trusted that title, one bad match
 *     relabelled the whole page. The release names themselves were never
 *     ambiguous: `Children.of.Dune.S01.COMPLETE` says what it is.
 *  3. **Season bucketing ignored the work entirely.** Releases were bucketed
 *     by season number alone, so `Dune.Prophecy.S01E01` and
 *     `Children.of.Dune.S01` landed in the same "S01" list. That is the most
 *     harmful of the three: the user clicks a season and gets episodes from a
 *     different show, with no indication that has happened.
 *
 * So identity is derived from **the release name**, which is the one thing
 * every result carries and the one thing that is self-describing. Catalog
 * metadata is still used — but only to *pretty up the label* of a group it
 * agrees with, never to decide what belongs in it. A wrong catalog match can
 * now make a heading less pretty. It can no longer merge two works.
 *
 * ## Why the year is part of a film's identity but not a series'
 *
 * *Dune* (1984) and *Dune* (2021) share a name and are different films, so a
 * film's key includes its year. A series' releases disagree about the year all
 * the time — `Dune Prophecy (2024) S01` and `Dune.Prophecy.S01E01` are the
 * same show — so including it would shatter one series into several. Season
 * structure is therefore what selects between the two rules, and it is read
 * off the release name rather than guessed from a category.
 */
import { showFolderName, cutAtStructuralMarker } from "@/lib/download/smart-category";
import { parseEpisode } from "@/lib/torrents/episodes";
import type { MediaMetadata } from "@/lib/torrents/types";

export type WorkIdentity = {
  /**
   * Stable grouping key. Two releases share a key exactly when they are the
   * same work. Opaque — do not display it or parse it back apart.
   */
  key: string;
  /** Display name derived from the release name. */
  name: string;
  /** Year, for films that carry one. Always null for series. */
  year: number | null;
  /** Whether releases of this work declare season/episode structure. */
  isSeries: boolean;
};

/**
 * Plausible release years. The upper bound is deliberately near-present:
 * without it, *Blade Runner 2049* and *Death Race 2000* read as future
 * releases and lose their real year, which would merge them with any other
 * yearless print of the same title.
 */
const MIN_YEAR = 1900;
const YEAR_LOOKAHEAD = 2;

/** Tokens that contain digits and are never years. Stripped before the scan. */
const NON_YEAR_NUMERIC_TOKENS =
  /\b(?:\d{3,4}p|x?26[45]|h\.?26[45]|10bit|8bit|5\.1|7\.1|2\.0|ddp?5|dts|aac2|mp3|hdr10\+?|\d+(?:\.\d+)?\s*(?:gb|mb|gib|mib))\b/gi;

/**
 * The year a *film* release declares, or null.
 *
 * Takes the last plausible year rather than the first: scene names put the
 * title before the year, and a title can itself be a number. `2012.2009.1080p`
 * is the 2009 film *2012*, and only "last" gets that right.
 */
export function releaseYear(title: string): number | null {
  if (!title) return null;
  const scrubbed = title
    .replace(/[._]+/g, " ")
    .replace(NON_YEAR_NUMERIC_TOKENS, " ");

  const ceiling = new Date().getFullYear() + YEAR_LOOKAHEAD;
  let found: number | null = null;
  for (const m of scrubbed.matchAll(/(?<![\d.])((?:19|20)\d{2})(?![\d.])/g)) {
    const year = Number(m[1]);
    if (year >= MIN_YEAR && year <= ceiling) found = year;
  }
  return found;
}

/** Casefold a display name down to something safe to compare and key on. */
function normalizeForKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * May a catalog title be borrowed as the display name for this work?
 *
 * The catalog is allowed to *refine* a name, never to blur one. So the test is
 * one-directional: accept when the catalog title is at least as specific as
 * the name the release itself states.
 *
 *   release "Dune Prophecy"     catalog "Dune: Prophecy"  → accept (equal once
 *                                                           punctuation is
 *                                                           normalised)
 *   release "The Office"        catalog "The Office (US)" → accept (refines)
 *   release "Children of Dune"  catalog "Dune"            → REJECT (blurs)
 *
 * The last line is the whole point. Bidirectional containment used to accept
 * it, and a single mis-enriched row titled "Dune" then contains-matched
 * *Dune Prophecy*, *Children of Dune* and *Dune Part Two* at once. Grouping
 * stayed correct — identity never comes from metadata — but all five works
 * came back named "Dune" and wearing Dune's poster. Five identical headings
 * under five copies of one poster is exactly the illegibility that splitting
 * the works was meant to remove, so a correct split rendered as an obviously
 * broken page.
 *
 * Rejecting the vaguer title costs nothing: the release-derived name is
 * already accurate, just less pretty.
 */
export function catalogAgrees(releaseName: string, catalogTitle: string): boolean {
  const a = normalizeForKey(releaseName);
  const b = normalizeForKey(catalogTitle);
  if (!a || !b) return false;
  if (a === b) return true;
  // `b` (catalog) must contain `a` (release), not the other way round.
  return b.includes(a);
}

/**
 * Strip a trailing year from a display name.
 *
 * "Dune 2021" is the film *Dune*; the year belongs in the `year` field, not in
 * the name, or the same film shows up twice under near-identical headings.
 * A name that is *only* a year keeps it — the film *2012* is called 2012.
 */
function stripTrailingYear(name: string, year: number | null): string {
  if (!year) return name;
  const stripped = name
    .replace(new RegExp(`\\b${year}\\b`, "g"), " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped || name;
}

/**
 * Tokens that begin the technical half of a scene release name. Everything
 * from the first one onward describes the *encode*, never the work.
 */
const QUALITY_TOKEN_RE =
  /\b(?:\d{3,4}p|4k|uhd|web-?dl|web-?rip|web|blu-?ray|bd-?rip|bd-?remux|remux|hdtv|dvd-?rip|hd-?rip|cam|ts|x26[45]|h\.?26[45]|hevc|avc|xvid|divx|hdr10\+?|hdr|dv|sdr|10bit|8bit|aac|ac3|eac3|ddp?5|dts(?:-hd)?|truehd|atmos|flac|mp3|imax|proper|repack|extended|unrated|remastered|directors?\.?cut)\b/i;

/**
 * The name of a *film* as stated by its release.
 *
 * `showFolderName` is tuned for series: it cuts at a season/episode marker, so
 * a film — which has no such marker — keeps its whole technical tail and comes
 * out as "Dune HDR SWTYBLZ" or "Dune RARBG". Those key apart from each other
 * and from "Dune", so three prints of one film became three works.
 *
 * Scene naming is strictly ordered — title, then year, then quality, source,
 * codec, audio, and finally the group — so the title is everything before
 * whichever of the year or the first technical token appears first. Taking the
 * earlier of the two matters: *Blade Runner 2049* keeps its 2049 because the
 * real year (2017) comes after it, while *2012* keeps its name for the same
 * reason.
 */
function filmNameFromRelease(title: string, year: number | null): string {
  let t = title
    .replace(/[._]+/g, " ")
    // Bracketed group/quality blocks: "Dune (2021) [1080p] [YTS.MX]"
    .replace(/[\[\(][^\]\)]{0,48}[\]\)]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const cuts: number[] = [];
  if (year) {
    const at = t.search(new RegExp(`(?<![\\d.])${year}(?![\\d.])`));
    if (at > 0) cuts.push(at);
  }
  const quality = t.search(QUALITY_TOKEN_RE);
  if (quality > 0) cuts.push(quality);

  if (cuts.length) t = t.slice(0, Math.min(...cuts));

  t = t
    // A trailing scene group: "...x264-RARBG", "...Atmos-SWTYBLZ".
    //
    // The delimiter must be a hyphen or underscore. Accepting a bare space
    // here — as this once did — truncates real titles every time neither cut
    // fires, because the last word of an ordinary title is indistinguishable
    // from a group name by shape alone. Observed live on a "breaking bad"
    // search: the plain torrent `Breaking Bad` became the work "Breaking",
    // and `El Camino A Breaking Bad Movie (2019) [1080p] [WEBRip]` lost its
    // "Movie" and keyed apart from the same film's other prints, so one film
    // rendered as two works. Scene groups are always joined with a hyphen or
    // underscore, so requiring one keeps `-RARBG` working and leaves titles
    // alone.
    .replace(/[-–—_]+[a-z0-9]{2,20}$/i, "")
    // An opening bracket whose closing partner never arrived within the
    // 48-character cap on the block-strip above. The quality cut then fires
    // inside the block and leaves the opener stranded on the end of the name,
    // e.g. "...Movie (1080p BluRay x265 HEVC 10bit AAC 5.1 Tigole QxR)" cuts
    // at "1080p" and yields "El Camino - A Breaking Bad Movie (".
    .replace(/\s*[[({]\s*$/g, "")
    .replace(/[\s\-–—_:|.]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return stripTrailingJunkNumber(title, t);
}

/**
 * A bare number stranded on the end of a name by an indexer.
 *
 * Observed live on a "dune" search: `Dune Part Two (2024) [1080p] [WEBRip] 88`
 * became the work **"Dune Part Two 88"**. Both cut anchors — the year and the
 * quality token — lived *inside* bracketed blocks, so the block-strip removed
 * them before the cuts could be computed, no cut fired, and the trailing token
 * survived into the title. The damage is worse than a cosmetic caption: it
 * keys as `film:dune part two 88:2024`, so the film rendered as a second,
 * separate work alongside the real `film:dune part two:2024`, and no artwork
 * provider could match it, so that work was a grey letter-tile.
 *
 * Stripping trailing digits unconditionally is not an option, because a great
 * many real titles end in one: *Toy Story 5*, *Alien 3*, *Ocean's 11*, *300*,
 * *1917*, *2012*. Every one of those would key apart from itself and lose its
 * poster — the same bug, aimed at more titles.
 *
 * The distinguishing signal is *positional*, and it is in the original string
 * rather than the cleaned one: junk digits appear **after a closing bracket**,
 * because that is what they are — an indexer's suffix appended past the end of
 * the release's own bracketed metadata. A number that is genuinely part of a
 * title comes before all of that. So the number is only dropped when the raw
 * release name ends with `) 88` / `] 88`, and `Toy Story 5 (2026) [1080p]` —
 * whose trailing character is a bracket, not a digit — is left alone.
 *
 * Exported because search groups releases through a completely separate path
 * (`groupReleases` in `ranking.ts`, keyed on `normalizeTitle`) which had the
 * identical defect. One rule, stated once, used by both — otherwise the two
 * groupings disagree about how many films "Dune Part Two" is.
 */
export function stripTrailingJunkNumber(
  rawTitle: string,
  cleaned: string,
): string {
  // Anchored on the RAW name: digits after the final closing bracket.
  if (!/[\]\)]\s*\d{1,4}\s*$/.test(rawTitle)) return cleaned;

  const stripped = cleaned.replace(/\s+\d{1,4}$/, "").trim();
  // Never let this empty the name: a release called literally "(2024) 88" has
  // nothing else to be, and a blank work title is worse than a noisy one.
  return stripped.length > 0 ? stripped : cleaned;
}

/**
 * Identify the work a single release belongs to.
 *
 * `metadata` is optional and only ever improves the display name. Passing a
 * wrong catalog match cannot change the key, which is the property that makes
 * the "DUNE · 2017" failure unreachable.
 */
export function workIdentity(
  title: string,
  metadata?: MediaMetadata | null,
): WorkIdentity {
  const episode = parseEpisode(title);
  const isSeries =
    episode.season != null ||
    episode.episode != null ||
    episode.isSeasonPack === true ||
    episode.isMultiSeason === true;

  // A film's year distinguishes it; a series' does not.
  const year = isSeries ? null : releaseYear(title);

  let name: string;
  if (isSeries) {
    // `showFolderName` already exists to give every episode of a series one
    // stable folder, which is the same question asked in a different place —
    // so it is reused rather than reimplemented. Series names can still carry
    // a year ("Dune Prophecy (2024) S01"); it is not part of identity, so it
    // must not be part of the name either or two spellings would key apart.
    name = showFolderName(title) || cutAtStructuralMarker(title).trim();
    name = stripTrailingYear(name, releaseYear(title));
  } else {
    name = filmNameFromRelease(title, year);
  }

  if (!name) name = title.trim();

  const normalized = normalizeForKey(name);

  // Borrow the catalog's spelling only where it agrees with the release.
  let display = name;
  const catalogTitle = metadata?.title?.trim();
  if (catalogTitle && catalogAgrees(name, catalogTitle)) display = catalogTitle;

  return {
    key: isSeries ? `series:${normalized}` : `film:${normalized}:${year ?? ""}`,
    name: display,
    year,
    isSeries,
  };
}

export type WorkGroup<T> = {
  key: string;
  /** Best display name available across the group's releases. */
  name: string;
  year: number | null;
  isSeries: boolean;
  /** Poster from the first release whose catalog match agreed with the name. */
  posterUrl: string | null;
  /** Releases in the order they arrived, i.e. still rank-ordered. */
  items: T[];
};

/**
 * Split a rank-ordered result list into one group per work.
 *
 * Input order is preserved inside each group, and groups are emitted in the
 * order their best-ranked release appeared — so the work the user most likely
 * meant stays first without anything having to score "relevance" a second
 * time.
 */
export function groupReleasesByWork<T>(
  items: readonly T[],
  getTitle: (item: T) => string,
  getMetadata?: (item: T) => MediaMetadata | null | undefined,
): WorkGroup<T>[] {
  const groups = new Map<string, WorkGroup<T>>();

  for (const item of items) {
    const title = getTitle(item);
    const metadata = getMetadata?.(item) ?? null;
    const identity = workIdentity(title, metadata);

    let group = groups.get(identity.key);
    if (!group) {
      group = {
        key: identity.key,
        name: identity.name,
        year: identity.year,
        isSeries: identity.isSeries,
        posterUrl: null,
        items: [],
      };
      groups.set(identity.key, group);
    }
    group.items.push(item);

    // Take artwork from a release whose catalog match agrees with the group
    // name. A poster is a strong visual claim about identity, so it may not
    // come from a row we only *suspect* belongs here.
    if (!group.posterUrl && metadata?.posterUrl && catalogAgrees(group.name, metadata.title ?? "")) {
      group.posterUrl = metadata.posterUrl;
      // The agreeing catalog title is also the better label.
      if (metadata.title?.trim()) group.name = metadata.title.trim();
    }
  }

  return [...groups.values()];
}
