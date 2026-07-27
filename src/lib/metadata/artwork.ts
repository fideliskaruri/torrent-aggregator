/**
 * Artwork resolution: a title in, a poster and a backdrop out.
 *
 * ## Why this module exists
 *
 * Cards rendered as grey tiles with a single letter because TMDB — the only
 * provider for movies and TV — was gated on `process.env.TMDB_API_KEY` being
 * truthy, and `.env` carried the two-character placeholder `xx`. TMDB looked
 * configured, every request 401'd, and the failure was silent. AniList needs no
 * key, so anime had covers and nothing else did.
 *
 * The fix is not "add the key". It is that **artwork must survive having no
 * keys at all**: TMDB rate-limits under a browse-heavy UI, keys get revoked,
 * and a fresh clone of this repo has no key. So every media type has a keyless
 * fallback (TVmaze for TV, iTunes for film, AniList for anime), and the key
 * gate now treats a placeholder as absent so a misconfiguration degrades to the
 * fallbacks instead of to nothing.
 *
 * ## The hard part is saying no
 *
 * A wrong poster is worse than no poster. This repo has already shipped a card
 * wearing a different film's poster, and it makes the whole app look broken.
 * Returning the provider's first result is therefore not acceptable: a search
 * for "Dune" that lands on *Dune: Part Two* is a bug, while a search for
 * "Frieren" that lands on *Frieren: Beyond Journey's End* is correct. The
 * difference is not string distance — it is whether the extra words name a
 * different instalment or merely describe the same work. `matchTier` encodes
 * exactly that, and anything it cannot vouch for resolves to `null`.
 *
 * ## Cost
 *
 * Every lookup is memoised in-process (positive *and* negative), concurrent
 * lookups of the same title share one promise, every provider call is bounded
 * by a timeout, and batches run with bounded concurrency. A dead network
 * degrades to letter tiles; it never throws and never hangs a page.
 *
 * Persistence is deliberately in-memory only: durable caching would need a
 * `prisma/schema.prisma` change, which this module is not allowed to make.
 */
import { searchAniList } from "./anilist";
import { searchItunes } from "./itunes";
import { hasTmdbKey, searchTmdbCandidates } from "./tmdb";
import { searchTvmazeShows } from "./tvmaze";

// ---------------------------------------------------------------------------
// Public contract — other modules are written against this exact shape.
// ---------------------------------------------------------------------------

export interface ArtworkQuery {
  title: string;
  year?: number | null;
  mediaType: "movie" | "tv" | "anime" | null;
}

export interface Artwork {
  posterUrl: string | null;
  backdropUrl: string | null;
}

/**
 * A resolved TMDB handle. The join between "which work is this card about" and
 * every richer field the title page wants.
 */
export interface TmdbRef {
  id: number;
  mediaType: "movie" | "tv";
}

const NO_ARTWORK: Artwork = Object.freeze({
  posterUrl: null,
  backdropUrl: null,
});

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Per-provider budget. A page must not wait on artwork. */
const DEFAULT_TIMEOUT_MS = 5000;
/** Parallel lookups in a batch. A browse page can ask for 100 at once. */
const BATCH_CONCURRENCY = 6;
/** Hits are stable; a poster does not change. */
const POSITIVE_TTL_MS = 1000 * 60 * 60 * 24;
/**
 * Misses are remembered too, or every render re-queries every title with no
 * art. Kept far shorter than a hit because a miss can also be a rate limit or
 * a five-second outage, and that must not become an hour of grey boxes.
 */
const NEGATIVE_TTL_MS = 1000 * 60 * 15;
/** Bound memory in a long-lived server. Oldest insertion is evicted first. */
const MAX_CACHE_ENTRIES = 2000;

function timeoutMs(): number {
  const raw = Number(process.env.ARTWORK_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

// ---------------------------------------------------------------------------
// Title normalisation
// ---------------------------------------------------------------------------

/**
 * Comparable form of a title: no case, no accents, no punctuation.
 *
 * `&`/`and` and `’`/`'` differ freely between catalogs, and "Journey's End"
 * must equal "Journeys End".
 */
export function normalizeTitleForMatch(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['\u2018\u2019`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const LEADING_ARTICLE = /^(the|a|an)\s+/;

/** "The Odyssey" and "Odyssey" are the same work in different catalogs. */
function stripArticle(normalized: string): string {
  const stripped = normalized.replace(LEADING_ARTICLE, "");
  return stripped || normalized;
}

function comparableTokens(title: string): string[] {
  const t = stripArticle(normalizeTitleForMatch(title));
  return t ? t.split(" ") : [];
}

const CURRENT_YEAR = new Date().getFullYear();

/** A plausible release year. 2049 is part of a title, not a year. */
function plausibleYear(value: number): boolean {
  return value >= 1900 && value <= CURRENT_YEAR + 5;
}

const RELEASE_NOISE =
  /\b(1080p|720p|480p|2160p|4k|uhd|hdr10?\+?|hevc|x26[45]|h\.?26[45]|av1|web-?dl|webrip|bluray|bdrip|brrip|dvdrip|hdtv|remux|proper|repack|multi|dual|subbed|dubbed|complete|batch)\b/gi;
const SEASON_EPISODE =
  /\b(s\d{1,2}\s*-\s*s?\d{1,2}|s\d{1,2}e\d{1,3}(?:\s*-\s*e?\d{1,3})?|s\d{1,2}|e\d{1,3}|ep\s*\d{1,3}|season\s*\d+|part\s+\d+\s*$)\b/gi;

/**
 * Trim a caller's title down to the work's name, and recover a year if one is
 * sitting in it.
 *
 * This deliberately overlaps `enrich.cleanTorrentTitle` rather than importing
 * it: `enrich` imports *this* module, and a cycle between them is not worth the
 * dozen lines saved. The two jobs also differ — this one only has to make two
 * titles comparable and produce a stable cache key, so that three episodes of
 * one show collapse to a single lookup.
 *
 * A bare trailing year is only treated as a year when it is plausible as one,
 * so `Blade Runner 2049` keeps its digits (the exact regression `enrich`
 * documents) while `Dune 2021` yields `Dune` + 2021.
 */
export function cleanQueryTitle(raw: string): { title: string; year: number | null } {
  let year: number | null = null;

  const bracketedYear = raw.match(/[([](\d{4})[)\]]/);
  if (bracketedYear && plausibleYear(Number(bracketedYear[1]))) {
    year = Number(bracketedYear[1]);
  }

  let title = raw
    .replace(/[([][^)\]]*[)\]]/g, " ")
    .replace(SEASON_EPISODE, " ")
    .replace(RELEASE_NOISE, " ")
    .replace(/[._\-\u2013\u2014|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const trailing = title.match(/^(.*\S)\s+(\d{4})$/);
  if (trailing && plausibleYear(Number(trailing[2]))) {
    const head = trailing[1].trim();
    // A single-token title *is* the year ("1917", "2012"). Never strip that.
    if (head && head.split(/\s+/).length >= 1 && normalizeTitleForMatch(head)) {
      title = head;
      year = year ?? Number(trailing[2]);
    }
  }

  title = dropTrailingListNoise(raw, title);

  return { title: title.trim(), year };
}

/**
 * Drop a stray number left dangling after the technical groups.
 *
 * Observed live on this repo's own search page: APIBAY returns
 * `Dune Part Two (2024) [1080p] [WEBRip] 88`, and once the brackets are gone
 * the title reads "Dune Part Two 88". That trailing token then looks exactly
 * like an instalment number, so the matcher refuses *Dune: Part Two* and the
 * top card on a "dune" search renders as a grey letter tile.
 *
 * The rule is positional, not numeric, because the number itself carries no
 * signal: "Rocky 4" and "Dune Part Two 88" are indistinguishable as strings.
 * What separates them is that the junk digit sits *after* the release's
 * bracketed metadata, where a title cannot reach. `Rocky 4` has no brackets,
 * so it is untouched; `Blade Runner 2049` is untouched twice over (no
 * brackets, and it is not the last token after one).
 */
function dropTrailingListNoise(raw: string, title: string): string {
  const lastBracket = raw.lastIndexOf("]");
  const lastParen = raw.lastIndexOf(")");
  const afterGroups = Math.max(lastBracket, lastParen);
  if (afterGroups < 0) return title;
  if (!/^\s*\d{1,4}\s*$/.test(raw.slice(afterGroups + 1))) return title;

  const stripped = title.replace(/\s+\d{1,4}$/, "").trim();
  // Never strip a title down to nothing, and never leave a bare instalment
  // head behind ("Part", "Vol") — that would be worse than the noise.
  if (!stripped || !normalizeTitleForMatch(stripped)) return title;
  return stripped;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * How the extra words in the longer of two titles read.
 *
 * The extras either mark a *different work* — a sibling instalment ("Dune" vs
 * "Dune: Part Two") or a companion release ("The Odyssey" vs "The Odyssey: The
 * Real Story") — in which case the two must never share artwork, or they are
 * merely descriptive, meaning the longer title is the same work with its
 * subtitle attached ("Frieren" vs "Frieren: Beyond Journey's End").
 */
const INSTALMENT_HEADS = new Set([
  "part",
  "parts",
  "chapter",
  "chapters",
  "vol",
  "volume",
  "book",
  "season",
  "episode",
  "act",
  "cycle",
  "phase",
  "round",
]);

const NUMBER_WORDS = new Set([
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
]);

const ROMAN = /^[ivx]+$/;

/**
 * Words that only ever continue a phrase, never open a subtitle. Guards the
 * reverse direction, where the *query* is longer and carries no punctuation to
 * prove a subtitle boundary: "Up" must not claim "Up in the Air".
 */
const PHRASE_CONTINUATIONS = new Set([
  "in",
  "on",
  "of",
  "at",
  "to",
  "from",
  "for",
  "with",
  "and",
  "or",
  "the",
  "a",
  "an",
  "into",
  "onto",
  "vs",
  "versus",
]);

function isInstalmentExtra(extra: string[]): boolean {
  if (extra.length === 0) return false;
  const head = extra[0];
  if (INSTALMENT_HEADS.has(head)) return true;
  if (extra.length <= 2) {
    // A bare number, numeral or number-word is an instalment: "Dune 2",
    // "Rocky IV", "Kill Bill Vol Two" (the "vol" case is caught above).
    if (extra.every((t) => /^\d+$/.test(t) || ROMAN.test(t) || NUMBER_WORDS.has(t))) {
      return true;
    }
  }
  if (extra[0] === "final" || (extra[0] === "the" && extra[1] === "final")) {
    return true;
  }
  return false;
}

/**
 * Subtitles that mark a *companion* release rather than the work itself:
 * making-of features, tie-in documentaries, recaps, bonus discs.
 *
 * Found live, not theorised: with no TMDB key, "The Odyssey" (2026) matched
 * iTunes' "The Odyssey: The Real Story" — a documentary — because an exact
 * title from the wrong year scores below a subtitle from the right year. A
 * documentary's poster on a feature film's card is exactly the "wrong art is
 * worse than none" failure, so these are refused like instalments.
 */
const COMPANION_PREFIXES = [
  "making",
  "behind the scenes",
  "documentary",
  "real story",
  "true story",
  "untold story",
  "inside story",
  "story of",
  "recap",
  "recaps",
  "extras",
  "bonus",
  "featurette",
  "featurettes",
  "special features",
];

function isCompanionExtra(extra: string[]): boolean {
  // A leading article carries no meaning here: "The Making of…" and "Making
  // of…" are the same claim.
  const significant = extra[0] === "the" || extra[0] === "a" || extra[0] === "an" ? extra.slice(1) : extra;
  if (significant.length === 0) return false;
  const phrase = significant.join(" ");
  return COMPANION_PREFIXES.some((p) => phrase === p || phrase.startsWith(`${p} `));
}

/** True when the extra words prove the longer title is a *different* work. */
function isDifferentWorkExtra(extra: string[]): boolean {
  return isInstalmentExtra(extra) || isCompanionExtra(extra);
}

/** Split a raw title at its first *explicit* subtitle separator. */
function splitSubtitle(raw: string): { head: string; tail: string } | null {
  const m = raw.match(/^([^:\u2013\u2014]+?)(?::|\s[-\u2013\u2014]\s)(.+)$/);
  if (!m) return null;
  const head = m[1].trim();
  const tail = m[2].trim();
  if (!head || !tail) return null;
  return { head, tail };
}

function dice(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const pool = [...b];
  let hits = 0;
  for (const token of a) {
    const idx = pool.indexOf(token);
    if (idx >= 0) {
      hits += 1;
      pool.splice(idx, 1);
    }
  }
  return (2 * hits) / (a.length + b.length);
}

const TIER_EXACT = 100;
/**
 * Same title once a leading article is discounted.
 *
 * Catalogs disagree about articles ("The Odyssey" vs "Odyssey"), so this has to
 * count — but it cannot count as much as a true exact match, because "Dune" and
 * "The Dune" (2025) are genuinely two films. Ranking it below `TIER_EXACT` and
 * inside reach of a year penalty is what keeps both cases right.
 */
const TIER_ARTICLE = 72;
const TIER_SUBTITLE = 80;
/** Below this, the answer is "I don't know", which means no artwork. */
const MIN_ACCEPT = 60;

/**
 * Title-only similarity, before any year evidence.
 *
 * Returns 0 when the two titles are not confidently the same work.
 */
export function matchTier(queryTitle: string, candidateTitle: string): number {
  const qRaw = normalizeTitleForMatch(queryTitle);
  const cRaw = normalizeTitleForMatch(candidateTitle);
  if (!qRaw || !cRaw) return 0;
  if (qRaw === cRaw) return TIER_EXACT;

  const q = stripArticle(qRaw);
  const c = stripArticle(cRaw);
  if (q === c) return TIER_ARTICLE;

  const qTokens = q.split(" ");
  const cTokens = c.split(" ");

  // Forward: the candidate carries a subtitle the query omitted. Requires a
  // real separator in the candidate's own punctuation — that is what tells
  // "Frieren: Beyond Journey's End" (same work) from "Up in the Air" (not).
  const split = splitSubtitle(candidateTitle);
  if (split && stripArticle(normalizeTitleForMatch(split.head)) === q) {
    const extra = comparableTokens(split.tail);
    if (!isDifferentWorkExtra(extra)) return TIER_SUBTITLE;
    return 0; // "Dune" must never wear the "Dune: Part Two" poster.
  }

  // Reverse: the query carries extra words the catalog's title omits. Release
  // names arrive without punctuation, so a token prefix is all there is to go
  // on — hence the stricter guards.
  if (qTokens.length > cTokens.length) {
    const isPrefix = cTokens.every((t, i) => qTokens[i] === t);
    if (isPrefix) {
      const extra = qTokens.slice(cTokens.length);
      if (isDifferentWorkExtra(extra)) return 0;
      if (extra.length <= 3 && !PHRASE_CONTINUATIONS.has(extra[0])) {
        return TIER_SUBTITLE;
      }
      return 0;
    }
  }

  // Everything else has to be near-identical: at MIN_ACCEPT this needs ~6 of 7
  // tokens shared, which admits "Attack on Titan Final Season" against
  // "Attack on Titan: The Final Season" and rejects "Dune" against
  // "Dune: Part Two" (0.5 -> 35).
  return dice(qTokens, cTokens) * 70;
}

interface Candidate {
  title: string;
  year: number | null;
  posterUrl: string | null;
  backdropUrl: string | null;
  kind: "movie" | "tv" | "anime";
  /** Provider-relative popularity. Tie-break only, never a match signal. */
  popularity: number;
  provider: "tmdb" | "anilist" | "tvmaze" | "itunes";
  /** Set only by the TMDB provider. The handle detail lookups need. */
  tmdbId?: number;
}

/**
 * Year evidence, weighted by what a year actually means for the media type.
 *
 * For a film the year is strong: two films with one title and different years
 * are two films. For a series it is weak — a query year is usually the year of
 * the *season* someone is looking at, not the series premiere, so
 * "House of the Dragon 2024" must still match a show that premiered in 2022.
 * The one hard rule for series is directional: a show cannot have episodes
 * before it existed.
 */
function yearAdjustment(
  queryYear: number | null | undefined,
  candidate: Candidate,
): number {
  if (!queryYear) return 0;
  if (candidate.year == null) return candidate.kind === "movie" ? -5 : -3;

  const diff = candidate.year - queryYear;
  const abs = Math.abs(diff);

  if (candidate.kind === "movie") {
    if (abs === 0) return 25;
    // Festival premiere vs wide release routinely straddles a new year, and
    // iTunes lists the 1984 Dune as 1985-01-01.
    if (abs === 1) return 8;
    return -45;
  }

  if (abs === 0) return 15;
  if (abs === 1) return 6;
  // Premiered well after the year asked for: not this show. Has to outweigh an
  // exact title on its own — "Severance" (2025) is not "Severance" (2022).
  if (diff >= 2) return -45;
  // Premiered well before: entirely normal for a later season.
  return 0;
}

function score(query: NormalizedQuery, candidate: Candidate): number {
  const tier = matchTier(query.title, candidate.title);
  if (tier <= 0) return 0;
  return tier + yearAdjustment(query.year, candidate);
}

/**
 * Best candidate above the acceptance bar, or null.
 *
 * Ties break on popularity, never on provider order: a bare "Dune" is an exact
 * match against the 1984, 2000 and 2021 records alike, and the one people mean
 * is the popular one.
 */
export function chooseBest(
  query: NormalizedQuery,
  candidates: Candidate[],
  opts: { requireArt?: boolean } = {},
): Candidate | null {
  const requireArt = opts.requireArt ?? true;
  let best: Candidate | null = null;
  let bestScore = 0;

  for (const candidate of candidates) {
    if (requireArt && !candidate.posterUrl && !candidate.backdropUrl) continue;
    const s = score(query, candidate);
    if (s < MIN_ACCEPT) continue;
    if (
      s > bestScore ||
      (s === bestScore && best != null && candidate.popularity > best.popularity)
    ) {
      bestScore = s;
      best = candidate;
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export interface NormalizedQuery {
  title: string;
  year: number | null;
  mediaType: "movie" | "tv" | "anime" | null;
}

type Provider = (q: NormalizedQuery) => Promise<Candidate[]>;

const tmdbProvider =
  (scope: "movie" | "tv" | "multi"): Provider =>
  async (q) => {
    if (!hasTmdbKey()) return [];
    const budget = timeoutMs();
    const hits = await searchTmdbCandidates(scope, q.title, {
      year: scope === "multi" ? null : q.year,
      timeoutMs: budget,
    });
    // TMDB's year parameter is a boost, not a filter, so a year-scoped search
    // can still miss the one record that matters. When nothing clears the bar,
    // ask again without it before handing off to a weaker provider.
    const scoped = hits.map(fromTmdb);
    if (q.year && scope !== "multi" && !chooseBest(q, scoped)) {
      const retry = await searchTmdbCandidates(scope, q.title, {
        timeoutMs: budget,
      });
      return [...scoped, ...retry.map(fromTmdb)];
    }
    return scoped;
  };

function fromTmdb(hit: Awaited<ReturnType<typeof searchTmdbCandidates>>[number]): Candidate {
  return {
    title: hit.title,
    year: hit.year,
    posterUrl: hit.posterUrl,
    backdropUrl: hit.backdropUrl,
    kind: hit.mediaType,
    popularity: hit.popularity,
    provider: "tmdb",
    tmdbId: hit.id,
  };
}

const anilistProvider: Provider = async (q) => {
  const hits = await searchAniList(q.title, 6);
  return hits.map((hit, i) => ({
    title: hit.title,
    year: hit.year ?? null,
    posterUrl: hit.posterUrl ?? null,
    backdropUrl: hit.backdropUrl ?? null,
    kind: "anime" as const,
    // AniList returns SEARCH_MATCH order and no popularity on this query.
    popularity: hits.length - i,
    provider: "anilist" as const,
  }));
};

const tvmazeProvider: Provider = async (q) => {
  const hits = await searchTvmazeShows(q.title, { timeoutMs: timeoutMs() });
  return hits.map((hit) => ({
    title: hit.title,
    year: hit.year,
    posterUrl: hit.posterUrl,
    backdropUrl: hit.backdropUrl,
    kind: "tv" as const,
    popularity: hit.score,
    provider: "tvmaze" as const,
  }));
};

const itunesProvider: Provider = async (q) => {
  const hits = await searchItunes(q.title, { timeoutMs: timeoutMs() });
  return hits.map((hit, i) => ({
    title: hit.title,
    year: hit.year,
    posterUrl: hit.posterUrl,
    backdropUrl: hit.backdropUrl,
    kind: "movie" as const,
    popularity: hits.length - i,
    provider: "itunes" as const,
  }));
};

/**
 * Provider order per media type. TMDB first wherever it can answer — it is the
 * only provider that carries backdrops — then the keyless one that knows that
 * media type best.
 */
function providerChain(mediaType: ArtworkQuery["mediaType"]): Provider[] {
  switch (mediaType) {
    case "anime":
      // AniList first: it is keyless, it has the right art, and its titles are
      // the ones anime releases actually use.
      return [anilistProvider, tmdbProvider("multi"), tvmazeProvider];
    case "movie":
      return [tmdbProvider("movie"), itunesProvider];
    case "tv":
      return [tmdbProvider("tv"), tvmazeProvider];
    default:
      // Unknown type: one multi-search covers both, then both keyless
      // providers. Ordering film first is a cheap heuristic — an explicit year
      // is a film-ish signal, and a series query without a type is usually a
      // bare show name that TVmaze answers well.
      return [tmdbProvider("multi"), itunesProvider, tvmazeProvider];
  }
}

// ---------------------------------------------------------------------------
// Safety rails
// ---------------------------------------------------------------------------

/**
 * Resolve `work()` with a hard ceiling, swallowing every failure.
 *
 * The provider modules already abort their own fetches, but AniList's client is
 * shared with `enrich` and carries a 10s budget this module does not own, and
 * an aborted fetch is not the only way to hang.
 *
 * The timer is deliberately *not* `unref`'d. It was, and a script whose event
 * loop emptied while a provider hung simply exited — the returned promise never
 * settled and the caller never ran again. A few seconds of held event loop on
 * shutdown is a much smaller problem than a promise that never resolves.
 */
async function guarded<T>(work: () => Promise<T>, fallback: T): Promise<T> {
  const budget = timeoutMs();
  return new Promise<T>((resolve) => {
    let settled = false;
    const finish = (value: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(fallback), budget);
    try {
      work().then(
        (value) => finish(value),
        () => finish(fallback),
      );
    } catch {
      finish(fallback);
    }
  });
}

/** Order-preserving map with a hard ceiling on parallelism. */
async function mapBounded<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  fallback: R,
): Promise<R[]> {
  const out = new Array<R>(items.length).fill(fallback);
  let cursor = 0;

  const worker = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        out[index] = await fn(items[index], index);
      } catch {
        out[index] = fallback;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker),
  );
  return out;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  expires: number;
  value: Resolved;
}

/**
 * What one lookup actually learned.
 *
 * `ref` is tri-state on purpose. `undefined` means nobody has asked TMDB for a
 * handle yet; `null` means somebody asked and TMDB had no acceptable match.
 * Collapsing those two into `null` would make every art-less work re-search
 * TMDB on every detail render, which is exactly the negative-caching bug this
 * module was written to avoid.
 */
interface Resolved {
  artwork: Artwork;
  ref?: TmdbRef | null;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<Resolved>>();
const refInFlight = new Map<string, Promise<TmdbRef | null>>();

function cacheKey(q: NormalizedQuery): string {
  return `${q.mediaType ?? "any"}|${stripArticle(normalizeTitleForMatch(q.title))}|${q.year ?? "-"}`;
}

function readCache(key: string): Resolved | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expires < Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function writeCache(key: string, value: Resolved): void {
  const found = Boolean(
    value.artwork.posterUrl || value.artwork.backdropUrl || value.ref,
  );
  cache.set(key, {
    expires: Date.now() + (found ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS),
    value,
  });
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/** Test-only. Nothing in the app should need to forget artwork. */
export function resetArtworkCache(): void {
  cache.clear();
  inFlight.clear();
  refInFlight.clear();
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

function normalizeQuery(q: ArtworkQuery): NormalizedQuery | null {
  if (!q || typeof q.title !== "string") return null;
  const cleaned = cleanQueryTitle(q.title);
  if (!normalizeTitleForMatch(cleaned.title)) return null;

  const year = q.year ?? cleaned.year ?? null;
  return {
    title: cleaned.title,
    year: year && plausibleYear(year) ? year : null,
    mediaType: q.mediaType ?? null,
  };
}

/**
 * Poster and backdrop for one title. Never throws, never hangs, and returns
 * nulls rather than a poster it cannot vouch for.
 */
export async function resolveArtwork(q: ArtworkQuery): Promise<Artwork> {
  try {
    const query = normalizeQuery(q);
    if (!query) return NO_ARTWORK;

    const key = cacheKey(query);

    const cached = readCache(key);
    if (cached) return cached.artwork;

    // A rail showing three episodes of one show asks three times, at once.
    const pending = inFlight.get(key);
    if (pending) return (await pending).artwork;

    const run = (async () => {
      const value = await lookup(query);
      writeCache(key, value);
      return value;
    })();

    inFlight.set(key, run);
    try {
      return (await run).artwork;
    } finally {
      inFlight.delete(key);
    }
  } catch {
    return NO_ARTWORK;
  }
}

/**
 * The TMDB handle for a title, or null when TMDB has no match it can vouch for.
 *
 * This is the join between artwork and detail. Resolving a poster for a film or
 * series already performed a TMDB search and already picked a winner, so the id
 * is recorded on the shared cache entry and a subsequent detail lookup costs no
 * extra request. Anime resolves its poster from AniList, so the first detail
 * lookup for an anime does pay one TMDB search — deliberately, and only on a
 * detail page, never on the browse fast path.
 *
 * Uses the same matcher as artwork, so a title page can never disagree with the
 * card that linked to it.
 */
export async function resolveTmdbRef(q: ArtworkQuery): Promise<TmdbRef | null> {
  try {
    const query = normalizeQuery(q);
    if (!query || !hasTmdbKey()) return null;

    const key = cacheKey(query);

    const cached = readCache(key);
    if (cached && cached.ref !== undefined) return cached.ref;

    const pending = refInFlight.get(key);
    if (pending) return await pending;

    const run = (async () => {
      const ref = await lookupTmdbRef(query);
      const entry = readCache(key);
      writeCache(key, { artwork: entry?.artwork ?? NO_ARTWORK, ref });
      return ref;
    })();

    refInFlight.set(key, run);
    try {
      return await run;
    } finally {
      refInFlight.delete(key);
    }
  } catch {
    return null;
  }
}

/**
 * Match against TMDB without requiring the winner to carry art.
 *
 * `chooseBest` normally refuses a candidate with neither poster nor backdrop,
 * because for artwork such a candidate is worthless. For detail it is not: a
 * work with no images still has a synopsis, a cast and a runtime, and the title
 * page is the one surface that can show them.
 */
async function lookupTmdbRef(query: NormalizedQuery): Promise<TmdbRef | null> {
  const scope: "movie" | "tv" | "multi" =
    query.mediaType === "movie"
      ? "movie"
      : query.mediaType === "tv"
        ? "tv"
        : "multi";

  const candidates = await guarded(
    () => tmdbProvider(scope)(query),
    [] as Candidate[],
  );
  const best = chooseBest(query, candidates, { requireArt: false });
  return refOf(best);
}

function refOf(candidate: Candidate | null): TmdbRef | null {
  if (!candidate || candidate.tmdbId == null) return null;
  return {
    id: candidate.tmdbId,
    mediaType: candidate.kind === "tv" ? "tv" : "movie",
  };
}

/**
 * Order-preserving batch lookup. `result[i]` belongs to `queries[i]`.
 *
 * Bounded concurrency, because a browse page can hand this a hundred titles and
 * an unbounded `Promise.all` would open a hundred sockets and trip TMDB's rate
 * limiter. Never throws.
 */
export async function resolveArtworkBatch(
  queries: ArtworkQuery[],
): Promise<Artwork[]> {
  if (!Array.isArray(queries) || queries.length === 0) return [];
  return mapBounded(
    queries,
    BATCH_CONCURRENCY,
    (q) => resolveArtwork(q),
    NO_ARTWORK,
  );
}

async function lookup(query: NormalizedQuery): Promise<Resolved> {
  for (const provider of providerChain(query.mediaType)) {
    const candidates = await guarded(() => provider(query), [] as Candidate[]);
    const best = chooseBest(query, candidates);
    if (!best) continue;

    let backdropUrl = best.backdropUrl;
    let ref = refOf(best);
    // AniList wins the anime race but often has no banner, and the detail hero
    // needs one. TMDB is the only provider here that carries wide art, and it
    // was never asked on this path.
    if (!backdropUrl && best.provider === "anilist" && hasTmdbKey()) {
      const extra = await guarded(async () => {
        const hits = await searchTmdbCandidates("multi", query.title, {
          timeoutMs: timeoutMs(),
        });
        return chooseBest(query, hits.map(fromTmdb));
      }, null);
      backdropUrl = extra?.backdropUrl ?? null;
      // That search already answered the detail question too. Recording it here
      // is what stops the title page repeating it.
      if (extra) ref = refOf(extra);
    }

    return { artwork: { posterUrl: best.posterUrl, backdropUrl }, ref };
  }

  // No provider matched. Leave `ref` undefined rather than null: artwork gave
  // up, but TMDB was only asked for art-bearing candidates, so a detail lookup
  // is still entitled to its own answer.
  return { artwork: NO_ARTWORK };
}
