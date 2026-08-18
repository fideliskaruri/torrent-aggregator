/**
 * Textual detail with no API key: synopsis, score, genres, dates, runtime.
 *
 * ## Why this exists
 *
 * `artwork.ts` already states the rule this module extends: **the product must
 * survive having no keys at all**, so every media type has a keyless fallback
 * (AniList for anime, TVmaze for TV, iTunes for film). That was only ever true
 * of *images*. `work-detail.ts` gated every text field on a usable
 * `TMDB_API_KEY`, so on an install without one — this one — every title page
 * showed a letter tile, a title and nothing else: measured 0% overview coverage
 * across all 120 catalog rows.
 *
 * That is not a missing key, it is a missing fallback. *That Time I Got
 * Reincarnated as a Slime* has a synopsis, a score, genres, a start date and an
 * episode count on AniList, which needs no key at all.
 *
 * ## Saying no is still the hard part
 *
 * A wrong synopsis is worse than no synopsis, exactly as a wrong poster is
 * worse than no poster — and worse to *notice*, because prose looks
 * authoritative. So this module does not match titles itself: it builds the
 * same `Candidate` rows `artwork.ts` builds and hands the decision to
 * `chooseBest`, which is the matcher that keeps "Dune" off *Dune: Part Two*
 * while letting "Frieren" match *Frieren: Beyond Journey's End*. `requireArt`
 * is off because a work with no poster still has a real synopsis, and this is
 * the one surface that can show it. Anything the matcher will not vouch for
 * resolves to `null`.
 *
 * ## Honesty
 *
 * Nothing is invented to fill a slot. iTunes publishes no rating, so a film
 * resolved from iTunes has `rating: null` rather than a number derived from
 * chart position. HTML summaries are converted to text, never rendered as
 * markup. Absent stays absent.
 */
import {
  chooseBest,
  type Candidate,
  type NormalizedQuery,
} from "./artwork";
import { searchAniListWorks } from "./anilist";
import { searchItunes } from "./itunes";
import { searchTvmazeShows } from "./tvmaze";

/**
 * What a keyless provider can honestly say about a work.
 *
 * A deliberate subset of `WorkDetail`: no cast, no crew, no certification, no
 * per-season listing, because none of these providers carries them on the
 * endpoints that need no key. Missing is `null`/`[]`, never a placeholder.
 */
export interface KeylessDetail {
  source: "anilist" | "tvmaze" | "itunes";
  /** The provider's own title for the work it matched, not the query. */
  title: string;
  /**
   * Shape, not catalog: an anime series is `tv` and an anime film is `movie`,
   * because that is what the title page switches on.
   */
  mediaType: "movie" | "tv";
  year: number | null;
  posterUrl: string | null;
  backdropUrl: string | null;
  overview: string | null;
  /** 0–10, the scale the hero prints. Null when the provider has no score. */
  rating: number | null;
  runtimeMinutes: number | null;
  genres: string[];
  /** `YYYY-MM-DD` premiere / release date. */
  releaseDate: string | null;
  /** Total episodes when the provider states one. Films and unknowns: 0. */
  episodeCount: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

function timeoutMs(): number {
  const raw = Number(process.env.ARTWORK_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "\u2019",
  lsquo: "\u2018",
  ldquo: "\u201c",
  rdquo: "\u201d",
};

/**
 * A provider's HTML summary as plain text.
 *
 * TVmaze stores `<p>…</p>` and AniList's `description` carries `<br>`, `<i>`
 * and source notes. The page renders this as text, so raw markup would either
 * print as literal angle brackets or — far worse if a component ever changed
 * to `dangerouslySetInnerHTML` — inject provider markup into the page.
 *
 * Block-ish tags become newlines so paragraphs survive; everything else is
 * dropped, entities are decoded, and runs of whitespace collapse. Decoding
 * happens *after* tag removal so an encoded `&lt;p&gt;` in the prose can never
 * be re-interpreted as a tag.
 */
export function stripHtmlToText(html: string | null | undefined): string | null {
  if (typeof html !== "string") return null;

  const text = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&#(\d+);/g, (_m, code: string) => codePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) => codePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name: string) =>
      NAMED_ENTITIES[name.toLowerCase()] ?? match,
    )
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text || null;
}

function codePoint(value: number): string {
  return Number.isFinite(value) && value > 0 && value <= 0x10ffff
    ? String.fromCodePoint(value)
    : "";
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function cleanGenres(values: readonly unknown[] | null | undefined): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const name = typeof value === "string" ? value.trim() : "";
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  return out;
}

/** Distinct, non-empty names for one work. Order is the provider's. */
function uniqueTitles(values: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const name = value?.trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  return out;
}

/** A score the hero can print: 0–10, one decimal, never a fabricated zero. */
function rating10(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value <= 0 || value > 10) return null;
  return Math.round(value * 10) / 10;
}

function positiveInt(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/**
 * A provider result paired with the `Candidate` the shared matcher judges.
 *
 * The pairing is the whole trick: matching happens on exactly the fields
 * `artwork.ts` matches on, and the detail only travels with the row that won.
 */
interface Judged<T> {
  candidate: Candidate;
  row: T;
}

async function anilistDetail(
  query: NormalizedQuery,
): Promise<KeylessDetail | null> {
  const works = await searchAniListWorks(query.title, 8);

  // One candidate per *name*, not per work. AniList exposes english, romaji and
  // native titles and `metadata.title` collapses them to one — English when it
  // exists. Match on the collapsed title alone and a release-name query like
  // "Tensei Shitara Slime Datta Ken" scores 0 against "That Time I Got
  // Reincarnated as a Slime" (the same work), while a spin-off short that
  // carries only the romaji name scores 100. Observed exactly that: the page
  // filled with a YouTube shorts blurb. Every alias competes; the row that owns
  // the winning name is the answer.
  const judged: Judged<(typeof works)[number]>[] = [];
  works.forEach((work, i) => {
    const names = uniqueTitles([
      work.metadata.title,
      ...(work.metadata.aliases ?? []),
    ]);
    for (const name of names) {
      judged.push({
        candidate: {
          title: name,
          year: work.metadata.year ?? null,
          posterUrl: work.metadata.posterUrl ?? null,
          backdropUrl: work.metadata.backdropUrl ?? null,
          // A film on AniList is still an anime work; `kind` drives the year
          // weighting, and a series' year is the weak signal here.
          kind: work.isSeries ? "tv" : "movie",
          // AniList returns SEARCH_MATCH order and no popularity on this query,
          // so search rank is the only tie-break available — and it is what
          // keeps the main series ahead of its own shorts and recap editions.
          popularity: works.length - i,
          provider: "anilist",
        },
        row: work,
      });
    }
  });

  const winner = pick(query, judged);
  if (!winner) return null;

  const { metadata } = winner.row;
  return {
    source: "anilist",
    title: metadata.title,
    mediaType: winner.row.isSeries ? "tv" : "movie",
    year: metadata.year ?? null,
    posterUrl: metadata.posterUrl ?? null,
    backdropUrl: metadata.backdropUrl ?? null,
    // AniList's `description` is HTML even with `asHtml: false`.
    overview: stripHtmlToText(metadata.synopsis),
    // Already divided down from AniList's 0–100 by `anilistScoreTo10`.
    rating: rating10(metadata.rating),
    runtimeMinutes: null,
    genres: cleanGenres(metadata.genres),
    releaseDate: nonEmpty(metadata.releaseDate),
    episodeCount: winner.row.episodeCount ?? 0,
  };
}

async function tvmazeDetail(
  query: NormalizedQuery,
): Promise<KeylessDetail | null> {
  const shows = await searchTvmazeShows(query.title, { timeoutMs: timeoutMs() });
  const judged: Judged<(typeof shows)[number]>[] = shows.map((show) => ({
    candidate: {
      title: show.title,
      year: show.year,
      posterUrl: show.posterUrl,
      backdropUrl: show.backdropUrl,
      kind: "tv",
      popularity: show.score,
      provider: "tvmaze",
    },
    row: show,
  }));

  const winner = pick(query, judged);
  if (!winner) return null;

  const show = winner.row;
  return {
    source: "tvmaze",
    title: show.title,
    mediaType: "tv",
    year: show.year,
    posterUrl: show.posterUrl,
    backdropUrl: show.backdropUrl,
    overview: stripHtmlToText(show.summary),
    // TVmaze already publishes 0–10; it is not rescaled.
    rating: rating10(show.rating),
    runtimeMinutes: positiveInt(show.runtimeMin),
    genres: cleanGenres(show.genres),
    releaseDate: nonEmpty(show.premiered),
    episodeCount: 0,
  };
}

async function itunesDetail(
  query: NormalizedQuery,
): Promise<KeylessDetail | null> {
  const films = await searchItunes(query.title, { timeoutMs: timeoutMs() });
  const judged: Judged<(typeof films)[number]>[] = films.map((film, i) => ({
    candidate: {
      title: film.title,
      year: film.year,
      posterUrl: film.posterUrl,
      backdropUrl: film.backdropUrl,
      kind: "movie",
      popularity: films.length - i,
      provider: "itunes",
    },
    row: film,
  }));

  const winner = pick(query, judged);
  if (!winner) return null;

  const film = winner.row;
  return {
    source: "itunes",
    title: film.title,
    mediaType: "movie",
    year: film.year,
    posterUrl: film.posterUrl,
    backdropUrl: film.backdropUrl,
    overview: stripHtmlToText(film.description),
    // The store publishes no critic or user score. A number here would have to
    // be invented, so there is none.
    rating: null,
    runtimeMinutes: positiveInt(film.runtimeMin),
    genres: cleanGenres(film.genre ? [film.genre] : []),
    releaseDate: nonEmpty(film.releaseDate),
    episodeCount: 0,
  };
}

/**
 * The winning row, judged by `artwork.ts`'s matcher.
 *
 * `requireArt: false` because detail is useful without images — that is the
 * only rule relaxed here. The title rules are not touched.
 */
function pick<T>(
  query: NormalizedQuery,
  judged: Judged<T>[],
): Judged<T> | null {
  const best = chooseBest(
    query,
    judged.map((j) => j.candidate),
    { requireArt: false },
  );
  if (!best) return null;
  return judged.find((j) => j.candidate === best) ?? null;
}

/**
 * Which keyless providers can speak for a media type, best first.
 *
 * Mirrors `artwork.ts`'s chain minus TMDB, which by definition cannot answer
 * here, with one addition it needs: AniList is asked last for `tv`, `movie`
 * and unknown types too. A title page reached from a browse card carries
 * `type=series`, not `type=anime` — the proof case, *Tensei Shitara Slime
 * Datta Ken*, arrives that way — and AniList is the only keyless provider that
 * knows those works under the romaji names releases use. It is last because it
 * only ever answers for anime, and it still has to satisfy the same matcher.
 *
 * Each provider refuses a title it cannot vouch for, so a wrong guess costs one
 * bounded call and never a wrong synopsis.
 */
function providerChain(
  mediaType: NormalizedQuery["mediaType"],
): Array<(q: NormalizedQuery) => Promise<KeylessDetail | null>> {
  switch (mediaType) {
    case "anime":
      return [anilistDetail, tvmazeDetail];
    case "movie":
      return [itunesDetail, anilistDetail];
    case "tv":
      return [tvmazeDetail, anilistDetail];
    default:
      return [itunesDetail, tvmazeDetail, anilistDetail];
  }
}

/**
 * Keyless detail for one already-normalised query, or null.
 *
 * Never throws: a provider that fails is a provider that had nothing to say,
 * and the next one is asked. Callers add the timeout and the caching — see
 * `work-detail.ts`, which owns both.
 */
export async function resolveKeylessDetail(
  query: NormalizedQuery,
): Promise<KeylessDetail | null> {
  for (const provider of providerChain(query.mediaType)) {
    try {
      const detail = await provider(query);
      if (detail && hasContent(detail)) return detail;
    } catch {
      // Try the next provider; a dead one must not end the chain.
    }
  }
  return null;
}

/**
 * Did this actually learn anything?
 *
 * A matched work with no synopsis, no score, no genres and no date is the same
 * as no match at all, and returning it would let a caller cache and report an
 * "enriched" row that fills nothing on the page.
 */
export function hasContent(detail: KeylessDetail): boolean {
  return Boolean(
    detail.overview ||
      detail.rating != null ||
      detail.genres.length > 0 ||
      detail.releaseDate ||
      detail.runtimeMinutes != null,
  );
}
