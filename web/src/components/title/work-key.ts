/**
 * `workKey` — the URL-safe name of a *work*, and the only thing `/title/[…]`
 * needs to know about it.
 *
 * Identity itself is not re-derived here. `src/lib/torrents/work-identity.ts`
 * already answers "which film or series is this release?", including the two
 * hard-won rules that keep *Dune* (1984) apart from *Dune* (2021) and stop
 * `Breaking Bad` being truncated to `Breaking` — so this module only takes the
 * answer and makes it fit in a path segment.
 *
 * Shape: `dune-2021`, `breaking-bad`, `dune-prophecy`. A film carries its year
 * because that is part of its identity; a series does not, because its
 * releases disagree about the year and including it would shatter one show
 * into several. That is the same rule `workIdentity` applies, and the same
 * `normalised title + year` the `CatalogEntry.workKey` column documents.
 *
 * **The key is opaque and must never be parsed back apart.** A slug cannot be
 * inverted — `blade-runner-2049` is a title, `dune-2021` is a title and a
 * year, and nothing in the string distinguishes them. So a lookup goes the
 * other way: compute the key of each candidate row and compare. See
 * {@link workKeyMatches}, which accepts the yearless variant too, because a
 * library row stores no year while the release it matches states one.
 *
 * Pure and DOM-free: `title.test.ts` drives it as a table, and the browse card
 * imports it into the client bundle (nothing here reaches Node APIs).
 */
import type { RailItem } from "@/lib/browse";
import { cleanDisplayTitle } from "@/lib/title/display-title";
import { isSeriesMediaType, normalizeMediaType } from "@/lib/metadata/media-type";
import { workIdentity } from "@/lib/torrents/work-identity";
import type { MediaMetadata } from "@/lib/torrents/types";

/** Where a title page lives. Exported so nothing hardcodes the route. */
const TITLE_HREF = "/title";

/**
 * Casefold a work name into a path segment.
 *
 * Diacritics are folded rather than dropped so `Amélie` and `Amelie` reach the
 * same page, and anything left that is not `[a-z0-9]` collapses to a single
 * hyphen. A title written entirely in a non-Latin script (a common case for
 * anime) folds to nothing, so it falls back to percent-encoding the
 * normalised name — still a legal, stable path segment, just not a pretty one.
 */
function slugifyWorkName(name: string): string {
  const folded = (name ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['’`]/g, "")
    .toLowerCase();

  const slug = folded.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (slug) return slug;

  const compact = (name ?? "").trim().toLowerCase().replace(/\s+/g, "-");
  return compact ? encodeURIComponent(compact) : "";
}

/** The key for a work already named and (for films) dated. */
export function workKeyFor(name: string, year?: number | null): string {
  const slug = slugifyWorkName(name ?? "");
  if (!slug) return "";
  return year ? `${slug}-${year}` : slug;
}

/**
 * The identity every part of the title page keys off — one funnel, so the
 * card, the API and the grabber cannot disagree about what a name means.
 *
 * `cleanDisplayTitle` runs first because `workIdentity` reads a *release*
 * name, and an indexer that glues its own domain on the front
 * (`www.1TamilMV.com - Jawan (2023) 1080p HQ HDRip`) makes that name lie: the
 * work comes out called "www 1TamilMV com Jawan", and every print from a
 * different indexer keys apart from it. Stripping the prefix is exactly what
 * the browse card already does before *displaying* the same string, so this
 * reuses that rule rather than growing a second one. `workIdentity` itself is
 * untouched — it is shared with search and carries hard-won fixes (the
 * Dune/Breaking Bad cases) that must not be forked.
 */
export function workIdentityFor(
  releaseName: string,
  metadata?: MediaMetadata | null,
) {
  const raw = releaseName ?? "";
  const cleaned = cleanDisplayTitle(raw);
  const identity = workIdentity(cleaned, metadata);
  const marker = raw.match(SEASON_EPISODE_MARKER);
  if (identity.isSeries || !marker) return identity;
  // The release states SxxEyy but the cleaned name lost it (`[SubsPlease]
  // Frieren - S02E03 (1080p)` cleans to "Sousou no Frieren") or the parser
  // missed a suffix (`S01E01v2`). Such a name is never a film: classifying it
  // as one split a single anime into a film row and a series row.
  const base = cleaned.split(SEASON_EPISODE_MARKER)[0].replace(/[\s\-–—_:|.]+$/, "").trim() || cleaned;
  return workIdentity(`${base} S${marker[1].padStart(2, "0")}E${marker[2].padStart(2, "0")}`, metadata);
}

/** An explicit season+episode marker: `S01E05`, `s2e103`, `S01.E03`, `S01E01v2`. */
const SEASON_EPISODE_MARKER =
  /(?<![a-z0-9])s(\d{1,2})[\s._-]?e(\d{1,4})(?:v\d)?(?![a-z0-9])/i;

/** Does this release name state an explicit season and episode? */
export function hasSeasonEpisodeMarker(releaseName: string): boolean {
  return SEASON_EPISODE_MARKER.test(releaseName ?? "");
}

/**
 * Every key a row with this name/year could legitimately be addressed by.
 *
 * Two, not one: a `WatchListItem` stores `"Dune"` with no year and its
 * releases state `Dune.2021.2160p…`, so the row's own key is `dune` while the
 * key a browse card links to may be `dune-2021`. Accepting both means a
 * library row still matches its downloads. It cannot over-match in the
 * dangerous direction — asking for `dune-2021` never returns the 1984 film.
 */
function workKeyVariants(name: string, year?: number | null): string[] {
  const withYear = workKeyFor(name, year);
  const bare = workKeyFor(name, null);
  return withYear === bare ? [bare] : [withYear, bare];
}

/** Does a row named `name` (optionally dated `year`) answer to `key`? */
function workKeyMatches(
  key: string,
  name: string,
  year?: number | null,
): boolean {
  const wanted = key.trim().toLowerCase();
  if (!wanted) return false;
  const variants = workKeyVariants(name, year);
  // The second spelling is the pre-cleanup one, so a link or a row saved when
  // the release suffix was still part of the key still reaches its own work.
  const candidates = workKeyAliases(wanted);
  if (candidates.some((candidate) => variants.includes(candidate))) return true;

  // A row that states no year cannot contradict one.
  //
  // `WatchListItem` has no year column at all — a library row is simply
  // "Dune" — while a film's key is `dune-2021`, because the year is what tells
  // the two films apart. Requiring an exact match would therefore mean *no
  // film ever* shows as being in your library, which is a far larger and more
  // certain defect than the one this admits: two works with the same base
  // name, one of them stored yearless, both answering to the other's page.
  //
  // Bounded on the dangerous side. This cannot manufacture a Downloaded status:
  // that needs a live `EngineTorrent` row, and those are identified from release
  // names, which do carry the year. `Dune.1984.1080p` states 1984 and is
  // rejected from `dune-2021` by the strict test above.
  if (year != null) return false;
  const bare = workKeyFor(name, null);
  return (
    Boolean(bare) &&
    candidates.some((candidate) => stripTrailingYear(candidate) === bare)
  );
}

/** Plausible release years, matching `work-identity.ts`'s own bounds. */
const TRAILING_YEAR = /-(?:19|20)\d{2}$/;

function stripTrailingYear(key: string): string {
  return key.replace(TRAILING_YEAR, "");
}

/**
 * A size-and-group run left inside a key written before the title cleanup.
 *
 * `cleanDisplayTitle` used to walk past the size an indexer glues into a
 * spaced release name (`Ninja Assassin (2009) 1080p BrRip x264 - 1.4GB -
 * YIFY`), so the identity — and therefore the *persisted* key — came out as
 * `ninja-assassin-1-4gb-yify-2009`. Those rows exist in real databases and in
 * real bookmarks.
 *
 * Nothing is rewritten to fix them: a migration would have to merge two `Work`
 * rows on a guess, and a guess that merges the wrong two works is unrecoverable.
 * Instead the *read* accepts the old spelling, so an old link resolves to the
 * same work as the new one and the row quietly stops being reachable once
 * nothing points at it.
 *
 * Deliberately narrow. It fires only on a digits→byte-unit run (`-1-4gb-`),
 * which is not a shape any real title produces, and only immediately before
 * the year or the end of the key. It cannot shorten a title to another title:
 * `children-of-dune` has no byte unit in it to strip.
 */
const LEGACY_SIZE_GROUP =
  /-\d+(?:-\d+)?-?[kmgt]i?b(?:-(?!(?:19|20)\d{2}$)[a-z0-9]{2,20})?(?=-(?:19|20)\d{2}$|$)/;

/**
 * The kind tag a key takes when a stored work of the other kind already holds
 * its plain spelling (`the-flash-2023-tv`, `family-guy-film`; the server's
 * `WorkKeySlug.KindKey`), or that tag plus the record's own catalog id when
 * another work holds that too (`the-flash-2023-tv-tmdb200`). The name and year
 * before it still name the work.
 */
const KIND_SUFFIX =
  /((?:-(?:19|20)\d{2})?)-(?:tv|film)(?:-(?:tmdb|tvmaze|anilist|imdb|cinemeta|itunes|mal)[a-z0-9]+)?$/;

/**
 * Every spelling of `key` a stored row may legitimately answer to.
 *
 * The key itself first, then the pre-cleanup spelling with its size/group run
 * and any kind tag removed. Never more than these two, and never a guess that
 * drops a word.
 */
function workKeyAliases(key: string): string[] {
  const wanted = (key ?? "").trim().toLowerCase();
  if (!wanted) return [];
  const legacy = wanted.replace(LEGACY_SIZE_GROUP, "").replace(KIND_SUFFIX, "$1");
  return legacy === wanted ? [wanted] : [wanted, legacy];
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

export interface TitleLinkParams {
  title: string;
  year?: number | null;
  mediaType?: string | null;
  /** Accepted for caller compatibility; season persistence lives in a cookie. */
  season?: number | null;
  provider?: "anilist" | "tmdb" | "tvmaze" | "cinemeta" | "itunes" | null;
  providerId?: string | null;
  sourceType?: "anime" | "movie" | "tv" | null;
  format?: string | null;
  series?: boolean | null;
}

/**
 * The path for a work, with the little the caller already knows attached.
 *
 * The key alone is enough to render the page whenever the work is in the
 * database. The query string exists for the case where it is not — a card for
 * something we hold no catalog row for still knows its own title, and passing
 * it forward is the difference between a page with a heading and a page that
 * has to guess one from a slug.
 */
export function titlePath(key: string, params: TitleLinkParams): string {
  const search = new URLSearchParams();
  const title = params.title?.trim() ?? "";
  if (title) search.set("t", title);
  if (params.year) search.set("y", String(params.year));
  const mediaType = params.mediaType?.trim();
  if (mediaType) search.set("type", mediaType);
  const provider = params.provider;
  const providerId = params.providerId?.trim();
  const sourceType = params.sourceType?.trim();
  if (
    provider &&
    providerId &&
    sourceType &&
    params.series != null &&
    (provider !== "anilist" || Boolean(params.format))
  ) {
    search.set("provider", provider);
    search.set("providerId", providerId);
    search.set("sourceType", sourceType);
    if (params.format) search.set("format", params.format);
    search.set("series", params.series ? "1" : "0");
  }
  const qs = search.toString();
  const segment = encodeKeySegment(key);
  return qs ? `${TITLE_HREF}/${segment}?${qs}` : `${TITLE_HREF}/${segment}`;
}

/**
 * A path segment that is already legal, or a percent-encoded one.
 *
 * `workKeyFor` normally yields `[a-z0-9-]+`, which needs no encoding, and its
 * non-Latin fallback yields a string that is *already* percent-encoded — so a
 * blanket `encodeURIComponent` would double-escape that case into a key the
 * route cannot match. But a caller may hand us a raw work identity instead
 * (`workIdentity()` produces `film:dune part two:2024`), and colons and spaces
 * in a path segment are how a link silently 404s. So: encode only what is not
 * already safe, treating a valid `%XX` escape as safe.
 */
const SAFE_SEGMENT = /^(?:[A-Za-z0-9\-._~]|%[0-9A-Fa-f]{2})*$/;

export function encodeKeySegment(key: string): string {
  const raw = key ?? "";
  return SAFE_SEGMENT.test(raw) ? raw : encodeURIComponent(raw);
}

/**
 * Where a card should go, or null when there is not enough to go on.
 *
 * The one funnel every surface uses — rails, library, search, the client list,
 * the download log. The user's rule is that *any* card opens the page about
 * the work, so every one of those surfaces has to agree about which page that
 * is; deriving the href in five places is how two of them drift apart.
 *
 * `name` may be a catalog title or a raw release name: `workIdentityFor`
 * cleans and identifies it either way, which is what lets a download-history
 * row (`Dune.Part.Two.2024.2160p…`) land on the same page as the poster in a
 * rail.
 *
 * Null is a real answer: a row with no usable title has no work to open, and
 * the caller should stay unclickable rather than link to a page that would
 * render a heading of nothing.
 */
export function titleHrefForName(
  name: string,
  params: { mediaType?: string | null; season?: number | null } = {},
): string | null {
  const raw = name?.trim();
  if (!raw) return null;

  const identity = workIdentityFor(raw);
  const key = workKeyFor(identity.name, identity.year);
  if (!key) return null;

  return titlePath(key, {
    title: identity.name || raw,
    year: identity.year,
    mediaType: params.mediaType ?? null,
    season: params.season ?? null,
  });
}

/**
 * Where a browse card should go, or null when there is not enough to go on.
 *
 * A card the server keyed carries its catalog id too, so the page it opens can
 * request the work without a search first.
 *
 * Null is a real answer: a row with no usable title has no work to open, and
 * the card keeps whatever fallback it already had rather than linking to a
 * page that would render a heading of nothing.
 */
export function titleHrefForItem(item: RailItem): string | null {
  if (item.workKey?.trim()) {
    const sourceType = normalizeMediaType(item.mediaType);
    return titlePath(item.workKey, {
      title: item.title,
      year: item.year,
      mediaType: item.mediaType,
      season: item.season,
      provider: item.provider,
      providerId: item.providerId,
      sourceType,
      series: sourceType ? isSeriesMediaType(sourceType) : null,
    });
  }
  return titleHrefForName(item.title, {
    mediaType: item.mediaType,
    season: item.season,
  });
}
