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
import { cleanDisplayTitle } from "@/components/browse/availability";
import { workIdentity } from "@/lib/torrents/work-identity";
import type { MediaMetadata } from "@/lib/torrents/types";

/** Where a title page lives. Exported so nothing hardcodes the route. */
export const TITLE_HREF = "/title";

/**
 * Casefold a work name into a path segment.
 *
 * Diacritics are folded rather than dropped so `Amélie` and `Amelie` reach the
 * same page, and anything left that is not `[a-z0-9]` collapses to a single
 * hyphen. A title written entirely in a non-Latin script (a common case for
 * anime) folds to nothing, so it falls back to percent-encoding the
 * normalised name — still a legal, stable path segment, just not a pretty one.
 */
export function slugifyWorkName(name: string): string {
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
  return workIdentity(cleanDisplayTitle(releaseName ?? ""), metadata);
}

/**
 * The key for a *release name* — the identity path every torrent takes.
 *
 * `metadata` is passed straight through to `workIdentity`, where it may only
 * improve the display name of a group it agrees with. It cannot change the
 * key, which is what makes a wrong catalog match unable to merge two works.
 */
export function workKeyForRelease(
  releaseName: string,
  metadata?: MediaMetadata | null,
): string {
  const identity = workIdentityFor(releaseName, metadata);
  return workKeyFor(identity.name, identity.year);
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
export function workKeyVariants(name: string, year?: number | null): string[] {
  const withYear = workKeyFor(name, year);
  const bare = workKeyFor(name, null);
  return withYear === bare ? [bare] : [withYear, bare];
}

/** Does a row named `name` (optionally dated `year`) answer to `key`? */
export function workKeyMatches(
  key: string,
  name: string,
  year?: number | null,
): boolean {
  const wanted = key.trim().toLowerCase();
  if (!wanted) return false;
  if (workKeyVariants(name, year).includes(wanted)) return true;

  // A row that states no year cannot contradict one.
  //
  // `WatchListItem` and `PlaybackProgress` have no year column at all — a
  // library row is simply "Dune" — while a film's key is `dune-2021`, because
  // the year is what tells the two films apart. Requiring an exact match would
  // therefore mean *no film ever* shows as being in your library and *no film
  // ever* resumes, which is a far larger and more certain defect than the one
  // this admits: two works with the same base name, one of them stored
  // yearless, both answering to the other's page.
  //
  // Bounded on the dangerous side. This cannot manufacture a Play button: that
  // needs a live `EngineTorrent` row, and those are identified from release
  // names, which do carry the year. `Dune.1984.1080p` states 1984 and is
  // rejected from `dune-2021` by the strict test above.
  if (year != null) return false;
  const bare = workKeyFor(name, null);
  return Boolean(bare) && stripTrailingYear(wanted) === bare;
}

/** Plausible release years, matching `work-identity.ts`'s own bounds. */
const TRAILING_YEAR = /-(?:19|20)\d{2}$/;

function stripTrailingYear(key: string): string {
  return key.replace(TRAILING_YEAR, "");
}

/**
 * A display title for a key nothing in the database recognises.
 *
 * Deliberately *not* an attempt to split the year back out: `blade-runner-2049`
 * is a title and `dune-2021` is a title plus a year, and no rule can tell them
 * apart from the string alone. Guessing would print a year the user never
 * gave us, which is exactly the kind of unearned claim this codebase keeps
 * paying for. So the slug is simply spelled back out as words — it is what the
 * URL says, nothing more.
 */
export function displayTitleFromWorkKey(key: string): string {
  let raw = (key ?? "").trim();
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // A malformed escape is not worth failing a page render over.
  }
  const words = raw.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  if (!words) return "";
  const minorWords = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "in", "nor", "of", "on", "or", "the", "to"]);
  return words
    .split(" ")
    .map((w, index) =>
      index > 0 && minorWords.has(w.toLowerCase())
        ? w.toLowerCase()
        : /^[a-z]/.test(w)
          ? w[0].toUpperCase() + w.slice(1)
          : w,
    )
    .join(" ");
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
  provider?: "anilist" | "tmdb" | null;
  providerId?: string | null;
  sourceType?: "anime" | "movie" | "tv" | null;
  format?: string | null;
  series?: boolean | null;
  aliases?: readonly string[];
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
    for (const alias of params.aliases ?? []) {
      const value = alias.trim();
      if (value) search.append("alias", value);
    }
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
 * Null is a real answer: a row with no usable title has no work to open, and
 * the card keeps whatever fallback it already had rather than linking to a
 * page that would render a heading of nothing.
 */
export function titleHrefForItem(item: RailItem): string | null {
  if (item.workKey?.trim()) {
    return titlePath(item.workKey, {
      title: item.title,
      mediaType: item.mediaType,
      season: item.season,
    });
  }
  return titleHrefForName(item.title, {
    mediaType: item.mediaType,
    season: item.season,
  });
}
