/**
 * A. Background pre-ranking — choose the release *before* the click.
 *
 * WHY
 * ---
 * A torrent app cannot be instant *after* the click: the swarm still has to be
 * found and peers connected. The only latency you can actually remove is the
 * part that happens before the user asks — the indexer fan-out, the dedupe and
 * the ranking pass that decide *which* of forty releases to send. That work is
 * deterministic given a query, so it can be done early and reused.
 *
 * WHAT THIS IS NOT
 * ----------------
 * This module does not grab anything and does not rank anything itself. It
 * *reuses*:
 *   - `searchTorrents` for the fan-out (which already dedupes, filters, and
 *     calls `rankResults` with the user's own target resolution), and
 *   - the same "first usable release matching the episode" rule the on-demand
 *     and automation callers use, applied to that already-ranked pool.
 * There is exactly one ranking implementation in this repo and it is
 * `src/lib/torrents/quality.ts`. Nothing here re-implements a slice of it.
 *
 * HOW THE FAST PATH ACTUALLY WORKS
 * --------------------------------
 * `searchTorrents` caches the full ranked pool under a sha256 of its *entire*
 * option set. So the way to make a later grab free is not to remember a hash —
 * it is to make the later grab search with **byte-identical options**. That is
 * what {@link prewarmSearchOptions} is for: one function builds the option set,
 * pre-ranking warms it, and the grab pipeline is handed the very same object.
 * The key is then identical by construction and never reconstructed by hand.
 *
 * The second lookup path — {@link getPreRanked} after a process restart, or for
 * a search some *other* caller ran — goes through `SearchCache.normalizedQuery`,
 * which exists precisely so a consumer can ask "the latest search for this
 * title" without knowing the producer's options. Rebuilding `cacheKey` from
 * guessed values is the bug this column was added to prevent, it missed 100% of
 * the time, and `npm run test:seam` exists to catch a regression. Do not do it.
 */
import { prisma } from "@/lib/prisma";
import {
  searchTorrents,
  SearchThrottledError,
} from "@/lib/torrents/aggregator";
import { parseEpisode } from "@/lib/torrents/episodes";
import { rankResults } from "@/lib/torrents/ranking";
import { verdictTier } from "@/lib/torrents/quality";
import { filterReleasesForWork } from "@/lib/torrents/work-match";
import { infoHashFromMagnet, normalizeInfoHash } from "@/lib/torrents/infohash";
import { advanceCursor, episodeSearchQuery, resolveHuntCursor } from "@/lib/library/cursor";
import { isSeriesMediaType, normalizeMediaType, searchCategoryForMediaType } from "@/lib/metadata/media-type";
import { normalizeTitle } from "@/lib/utils";
import type { SearchResponse, TorrentResult } from "@/lib/torrents/types";
import type { PipelineSearchOptions } from "@/lib/grab/types";
import type { PreRankedChoice, PreRankTarget } from "./types";
import { loadSwarmVerdicts, type SwarmVerdict } from "@/lib/torrents/swarm-probe";

/** How long a pre-ranked choice is worth reusing. */
export const PRERANK_TTL_MS = 10 * 60 * 1000;

/**
 * How long after a `SearchCache` row expires we will still take its answer.
 *
 * A slightly stale magnet is not a correctness problem here: the grab pipeline
 * re-searches, re-dedupes and re-checks viability before it sends anything.
 * The pre-ranked choice is an *accelerator*, never the final word.
 */
export const PRERANK_MAX_STALE_MS = 30 * 60 * 1000;

/** Matches the on-demand grab so the two agree on how deep to look. */
export const PREWARM_SEARCH_LIMIT = 15;

/** Bound on the in-process memo so a long-running server cannot grow forever. */
const MEMO_MAX_ENTRIES = 200;

const memo = new Map<string, PreRankedChoice>();

// ---------------------------------------------------------------------------
// Target → query / options
// ---------------------------------------------------------------------------

function unit(n: number | null | undefined): number | null {
  if (n == null) return null;
  const v = Math.trunc(n);
  return Number.isFinite(v) && v >= 1 ? v : null;
}

/**
 * The search query for a target.
 *
 * Series go through `episodeSearchQuery` — the same helper the hunt and the
 * on-demand grab use — so a pre-ranked pool is the pool those callers would
 * have produced themselves.
 */
export function preRankQuery(target: PreRankTarget): string {
  const season = unit(target.season);
  const episode = unit(target.episode);
  const title = target.title.trim();
  if (season != null && episode != null) {
    return episodeSearchQuery(title, season, episode);
  }
  return title;
}

/** Stable memo key. Opaque — callers must not parse it. */
export function preRankKey(target: PreRankTarget): string {
  const season = unit(target.season);
  const episode = unit(target.episode);
  return `${normalizeTitle(target.title)}|S${season ?? "X"}E${episode ?? "X"}`;
}

/** Resolution is mutable plan state, but memoised choices must remain distinct. */
function preRankPlanKey(target: PreRankTarget): string {
  const resolution = unit(target.preferredResolution);
  return `${preRankKey(target)}|R${resolution ?? "X"}`;
}

/**
 * The one and only search option set for speculative work.
 *
 * Both the pre-rank pass and the pre-warm grab pass this exact shape to
 * `searchTorrents`, which is what makes the grab a cache hit. Change it in one
 * place or the fast path silently stops being fast — nothing errors, the grab
 * just quietly pays for a second fan-out.
 *
 * `background: true` draws on the smaller background indexer budget, because
 * nobody is waiting on this; a human at the search box must not be throttled by
 * speculation. `skipCache: false` for the same reason the cache exists.
 *
 * The media-type fallback is stated here in the open, per the standing rule
 * that `searchCategoryForMediaType` returns `null` and each caller declares its
 * own default: everything this module speculates about is either a series we
 * are tracking episode-by-episode or a title we know nothing about, and `"tv"`
 * is the better of the two guesses for both.
 */
export function prewarmSearchOptions(
  target: PreRankTarget,
): PipelineSearchOptions {
  const season = unit(target.season);
  const episode = unit(target.episode);
  return {
    query: preRankQuery(target),
    category: searchCategoryForMediaType(target.mediaType) ?? "tv",
    limit: PREWARM_SEARCH_LIMIT,
    enrich: false,
    skipCache: false,
    background: true,
    filters: {
      hasMagnet: true,
      // Never a resolution filter and never a seeder floor above 1: nothing is
      // rejected for its resolution, and a brand-new episode legitimately has
      // no seeders for its first minutes.
      minSeeders: 1,
      ...(season != null ? { season } : {}),
      ...(episode != null ? { episode } : {}),
    },
  };
}

/**
 * Call `searchTorrents` with a `PipelineSearchOptions`.
 *
 * Deliberately mirrors step 1 of `runGrabPipeline` field for field. The cache
 * key is a hash of this payload, so any divergence — an extra key, a different
 * default — turns the grab's cache hit into a miss.
 */
export function searchPayloadFor(options: PipelineSearchOptions) {
  return {
    query: options.query,
    category: options.category,
    limit: options.limit,
    sources: options.sources,
    enrich: options.enrich,
    skipCache: options.skipCache,
    background: options.background,
    filters: {
      hasMagnet: options.filters.hasMagnet,
      minSeeders: options.filters.minSeeders,
      maxSizeBytes: options.filters.maxSizeBytes,
      resolution: options.filters.resolution,
      season: options.filters.season,
      episode: options.filters.episode,
    },
  };
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Re-rank a discovered pool for an explicit request preference.
 *
 * Search results arrive ranked for the account default. When a single action
 * carries its own preference, this is the one canonical re-ranking pass; an
 * absent preference preserves the producer's order exactly.
 */
export function rankResultsForTarget(
  results: readonly TorrentResult[],
  target: PreRankTarget,
): TorrentResult[] {
  const resolution = unit(target.preferredResolution);
  if (resolution == null) return [...results];
  const options = prewarmSearchOptions(target);
  return rankResults(
    [...results],
    options.query,
    resolution,
    options.category,
  );
}

/**
 * The canonical lowercase-hex infoHash for a release, or null.
 *
 * A speculative grab has to be labelled `origin: "prewarm"` on its
 * `EngineTorrent` row, and that row is keyed on the hash. A release we cannot
 * key is a download we could never mark speculative and never evict, so it is
 * not a release we are willing to speculate on. In practice every magnet
 * carries a btih, so this rejects almost nothing.
 */
export function releaseInfoHash(r: TorrentResult): string | null {
  if (r.infoHash) {
    const direct = normalizeInfoHash(r.infoHash);
    if (direct) return direct;
  }
  return infoHashFromMagnet(r.magnet ?? null);
}

/**
 * Reorder an already-ranked pool by *measured* swarm verdict, stably.
 *
 * This is the seam that replaces the indexer's claim with a measurement. The
 * ranker ordered these releases on advertised seeders; a verdict from an actual
 * probe outranks that claim. But the rule is **demote, never filter** — the
 * same invariant `quality.ts` holds (docs/handover.md §3): a `dead`-looking
 * release that is the *only* release must still be reachable, because the
 * alternative is offering the user nothing at all. Nothing is removed here.
 *
 * The tiers:
 *   - `good`    → promoted above everything: a measured pass beats any claim.
 *   - `unknown` → **neutral**. Most candidates are unknown most of the time, so
 *     this is the baseline; treating it as bad would make the system refuse to
 *     try anything it has not already tried. It keeps its ranker position.
 *   - `weak`    → demoted below the baseline: it delivered, but not enough.
 *   - `dead`    → demoted hardest, to the very back — but still present.
 *
 * Stable within a tier: the ranker's order (input order) is preserved by the
 * index tiebreak, so among equally-verdicted releases the better-ranked one
 * still wins.
 */
export function orderByVerdict(
  results: readonly TorrentResult[],
  verdictOf: (r: TorrentResult) => SwarmVerdict,
): TorrentResult[] {
  return results
    .map((r, i) => ({ r, i, tier: verdictTier(verdictOf(r)) }))
    .sort((a, b) => a.tier - b.tier || a.i - b.i)
    .map((x) => x.r);
}

/**
 * Pick the release to grab from an **already-ranked** pool.
 *
 * Input order is authoritative: `searchTorrents` has already run
 * `rankResults`, which is the single ordering implementation. This function
 * only *filters* and, when a measured verdict is supplied, *reorders by that
 * verdict* — it never re-sorts on advertised numbers, so it cannot disagree
 * with the ranker on the claims.
 *
 * The rule is the on-demand caller's rule verbatim: a release needs a magnet
 * and at least one seeder, and when an episode was asked for it must be that
 * exact episode. A season pack is not accepted in place of an episode: the
 * pre-warm budget is sized for one episode, and quietly pulling forty is the
 * kind of surprise a background feature must never spring.
 *
 * A film additionally has to BE the film. Without that test the whole
 * episode-matching branch is skipped and `ordered[0]` wins, which is how the
 * title page for *The Odyssey* (2026) came to offer a 1997 print, a Waterworld
 * documentary and an audiobook. See `work-match.ts`.
 *
 * `verdictOf` is optional and pure. When omitted, the ranker's order stands
 * untouched — so the fast memo/cache path (no DB) behaves exactly as before,
 * and only callers with a measurement to offer change the outcome.
 */
export function selectBestRelease(
  results: readonly TorrentResult[],
  target: PreRankTarget,
  opts: { verdictOf?: (r: TorrentResult) => SwarmVerdict } = {},
): TorrentResult | null {
  const season = unit(target.season);
  const episode = unit(target.episode);
  const ranked = rankResultsForTarget(results, target);

  const usable = ranked.filter(
    (r) => r.magnet && (r.seeders ?? 0) > 0 && releaseInfoHash(r) !== null,
  );
  if (usable.length === 0) return null;

  const ordered = opts.verdictOf
    ? orderByVerdict(usable, opts.verdictOf)
    : usable;

  if (season == null || episode == null) {
    // Nothing structural constrains this match, so work identity is the only
    // thing standing between the viewer and a different work entirely.
    //
    // The guard runs only on a CONFIRMED film. Series-ness is not inferred
    // from the absence of a season/episode — callers legitimately pre-rank a
    // *show* by name alone (failover does) — and an unrecognised media type is
    // left alone too, because a name test on something we cannot classify is a
    // guess that can only cost the viewer playback.
    const isFilm = normalizeMediaType(target.mediaType) === "movie";
    const sameWork = isFilm
      ? filterReleasesForWork(ordered, {
          title: target.title,
          year: target.year,
          isSeries: false,
        })
      : ordered;
    return sameWork[0] ?? null;
  }

  return (
    ordered.find((r) => {
      const ep = r.episode ?? parseEpisode(r.title);
      if (ep.isSeasonPack) return false;
      return ep.season === season && ep.episode === episode;
    }) ?? null
  );
}

/**
 * Load measured swarm verdicts for a pool and turn them into a `verdictOf`
 * lookup for {@link selectBestRelease}. Every release with no fresh measurement
 * reads as `unknown` (neutral), which is the map's default.
 */
export async function verdictLookupFor(
  results: readonly TorrentResult[],
  db: typeof prisma,
): Promise<(r: TorrentResult) => SwarmVerdict> {
  const hashes = results.map((r) => releaseInfoHash(r));
  const verdicts = await loadSwarmVerdicts(hashes, { db });
  return (r: TorrentResult) => {
    const h = releaseInfoHash(r);
    return (h && verdicts.get(h)) || "unknown";
  };
}

// ---------------------------------------------------------------------------
// Memo
// ---------------------------------------------------------------------------

function remember(
  target: PreRankTarget,
  choice: PreRankedChoice,
): PreRankedChoice {
  if (memo.size >= MEMO_MAX_ENTRIES) {
    const oldest = memo.keys().next();
    if (!oldest.done) memo.delete(oldest.value);
  }
  memo.set(preRankPlanKey(target), choice);
  return choice;
}

/** Drop every memoised choice. Tests only. */
export function clearPreRankMemo(): void {
  memo.clear();
}

/** How many choices are currently memoised. Diagnostics only. */
export function preRankMemoSize(): number {
  return memo.size;
}

function buildChoice(
  target: PreRankTarget,
  response: Pick<SearchResponse, "results">,
  source: PreRankedChoice["source"],
  rankedAt: number,
  verdictOf?: (r: TorrentResult) => SwarmVerdict,
): PreRankedChoice {
  const options = prewarmSearchOptions(target);
  return {
    key: preRankKey(target),
    query: options.query,
    normalizedQuery: normalizeTitle(target.title),
    category: options.category as PreRankedChoice["category"],
    season: unit(target.season),
    episode: unit(target.episode),
    candidate: selectBestRelease(response.results, target, { verdictOf }),
    resultCount: response.results.length,
    source,
    rankedAt,
    expiresAt: rankedAt + PRERANK_TTL_MS,
  };
}

// ---------------------------------------------------------------------------
// Lookup (never touches the network)
// ---------------------------------------------------------------------------

/**
 * The already-decided choice for a target, or `null` if there isn't one.
 *
 * **Never performs a search.** This is the function a "Download" press should
 * consult: it answers from the in-process memo, then from a search another
 * caller already cached for the same title, and otherwise admits it does not
 * know. `null` here means *not determined*, never *unavailable*.
 */
export async function getPreRanked(
  target: PreRankTarget,
  opts: { db?: typeof prisma } = {},
): Promise<PreRankedChoice | null> {
  const key = preRankPlanKey(target);
  const hit = memo.get(key);
  if (hit) {
    if (hit.expiresAt > Date.now()) return { ...hit, source: "memo" };
    memo.delete(key);
  }

  const normalizedQuery = normalizeTitle(target.title);
  if (!normalizedQuery) return null;

  const db = opts.db ?? prisma;
  try {
    // Look up by the query, NOT by a reconstructed `cacheKey`. See the module
    // header, `search-cache.ts`, and `npm run test:seam`.
    const row = await db.searchCache.findFirst({
      where: { normalizedQuery },
      orderBy: { expiresAt: "desc" },
    });
    if (!row) return null;

    const age = Date.now() - row.expiresAt.getTime();
    if (age > PRERANK_MAX_STALE_MS) return null;

    const payload = JSON.parse(row.payload) as SearchResponse;
    if (!Array.isArray(payload.results)) return null;

    // A measured verdict outranks the indexer's advertised claim. Loading it
    // here is cheap (one indexed read keyed by info-hash) and is what lets a
    // release we have actually probed `good` win over one merely advertising
    // more seeders. Absent a measurement every release reads `unknown`
    // (neutral), so this never demotes anything we have not measured.
    const verdictOf = await verdictLookupFor(payload.results, db);

    return remember(
      target,
      buildChoice(
        target,
        payload,
        "search-cache",
        row.expiresAt.getTime(),
        verdictOf,
      ),
    );
  } catch {
    // A pre-ranked choice is an accelerator. Not having one is normal.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pre-rank (may search)
// ---------------------------------------------------------------------------

export interface PreRankOptions {
  /** Re-search even if a fresh choice is already known. */
  force?: boolean;
  db?: typeof prisma;
  /** Test seam — the real fan-out. */
  _searchFn?: typeof searchTorrents;
}

/**
 * Resolve and cache the best release for a target ahead of time.
 *
 * Returns `null` when we could not determine an answer at all (indexer budget
 * spent, network down, DB unavailable). It does **not** return a "nothing
 * found" choice in that case — an unchecked title must never look like a
 * checked one.
 */
export async function preRank(
  target: PreRankTarget,
  opts: PreRankOptions = {},
): Promise<PreRankedChoice | null> {
  if (!target.title.trim()) return null;

  if (!opts.force) {
    const known = await getPreRanked(target, { db: opts.db });
    if (known) return known;
  }

  const search = opts._searchFn ?? searchTorrents;
  const options = prewarmSearchOptions(target);
  const db = opts.db ?? prisma;

  try {
    const response = await search(searchPayloadFor(options));
    const verdictOf = await verdictLookupFor(response.results, db);
    return remember(
      target,
      buildChoice(target, response, "search", Date.now(), verdictOf),
    );
  } catch (err) {
    if (err instanceof SearchThrottledError) {
      // Expected and harmless: speculation yields to the person who is waiting.
      return null;
    }
    console.warn(
      `[prewarm] pre-rank failed for ${JSON.stringify(options.query)}:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// What is the user plausibly about to want?
// ---------------------------------------------------------------------------

/** Default number of titles one background pre-rank pass will look at. */
export const PRERANK_UPCOMING_LIMIT = 6;

/**
 * The sources a pre-rank / pre-probe pass may draw targets from, in descending
 * value order. Scoping the *speculative swarm probe* maps onto these:
 *   - "watching"  → the next episode of shows in progress (the money case).
 *   - "monitored" → the hunt cursor of every monitored series.
 *   - "watchlist" → planned/other watchlist titles, opportunistic only.
 * Never the whole catalogue: that is bandwidth spent competing with playback
 * for content nobody will open.
 */
export type PreRankSource = "watching" | "monitored" | "watchlist";

/** The default sources — the two highest-value tiers, matching prior behaviour. */
export const DEFAULT_PRERANK_SOURCES: readonly PreRankSource[] = [
  "monitored",
  "watching",
];

/**
 * The targets worth pre-ranking right now, best bet first.
 *
 * 1. The hunt cursor of every monitored series — the library has already
 *    stated, in a durable field, which episode it wants next.
 * 2. Other watchlist titles — planned series and movies the user explicitly
 *    saved, opportunistic but still user-declared.
 * 3. The next episode of Continue Watching — the most likely immediate click,
 *    but behind durable tracked/saved intent for this background probe.
 *
 * `sources` gates which tiers run; the default keeps the same two tiers as
 * before, with monitored intent first.
 *
 * Ordering matters: the background indexer budget is small, so the first few
 * targets are the only ones that reliably get done.
 */
export async function upcomingTargets(
  userId: string,
  opts: {
    limit?: number;
    db?: typeof prisma;
    sources?: readonly PreRankSource[];
  } = {},
): Promise<PreRankTarget[]> {
  const db = opts.db ?? prisma;
  const limit = Math.max(1, opts.limit ?? PRERANK_UPCOMING_LIMIT);
  const sources = new Set(opts.sources ?? DEFAULT_PRERANK_SOURCES);
  const out: PreRankTarget[] = [];
  const seen = new Set<string>();

  const push = (t: PreRankTarget) => {
    const key = preRankKey(t);
    if (seen.has(key) || out.length >= limit) return;
    seen.add(key);
    out.push(t);
  };

  try {
    const monitored = sources.has("monitored")
      ? await db.watchListItem.findMany({
          where: { userId, monitored: true },
          orderBy: { updatedAt: "desc" },
          take: limit * 2,
        })
      : [];

    for (const item of monitored) {
      if (!isSeriesMediaType(item.mediaType)) continue;
      const hunt = resolveHuntCursor({
        title: item.title,
        mediaType: item.mediaType,
        cursorSeason: item.cursorSeason,
        cursorEpisode: item.cursorEpisode,
        fromSeason: item.fromSeason,
        fromEpisode: item.fromEpisode,
        lastEpisode: item.lastEpisode,
        nextEpisodeHint: item.nextEpisodeHint,
      });
      if (!hunt.cursor) continue;
      push({
        title: item.title,
        mediaType: item.mediaType,
        season: hunt.cursor.season,
        episode: hunt.cursor.episode,
      });
    }
  } catch {
    // Same reasoning.
  }

  // Tier 2: other watchlist titles the user saved but is not actively watching
  // or monitoring. Opportunistic only, and never the whole
  // catalogue. Series resolve to their hunt cursor; movies use the bare title.
  if (sources.has("watchlist")) {
    try {
      const saved = await db.watchListItem.findMany({
        where: { userId, status: { notIn: ["completed", "dropped"] } },
        orderBy: { updatedAt: "desc" },
        take: limit * 2,
      });

      for (const item of saved) {
        if (isSeriesMediaType(item.mediaType)) {
          const hunt = resolveHuntCursor({
            title: item.title,
            mediaType: item.mediaType,
            cursorSeason: item.cursorSeason,
            cursorEpisode: item.cursorEpisode,
            fromSeason: item.fromSeason,
            fromEpisode: item.fromEpisode,
            lastEpisode: item.lastEpisode,
            nextEpisodeHint: item.nextEpisodeHint,
          });
          if (!hunt.cursor) continue;
          push({
            title: item.title,
            mediaType: item.mediaType,
            season: hunt.cursor.season,
            episode: hunt.cursor.episode,
          });
        } else {
          push({ title: item.title, mediaType: item.mediaType });
        }
      }
    } catch {
      // Same reasoning.
    }
  }

  try {
    const watching = sources.has("watching")
      ? await db.playbackProgress.findMany({
          where: { userId, completedAt: null, season: { not: null }, episode: { not: null } },
          orderBy: { updatedAt: "desc" },
          take: limit * 2,
        })
      : [];

    // Resolve the show title from the library row when there is one — a
    // PlaybackProgress title is a release name, and a release name is not a
    // search query.
    const itemIds = [
      ...new Set(watching.map((p) => p.watchListItemId).filter((v): v is string => !!v)),
    ];
    const items = itemIds.length
      ? await db.watchListItem.findMany({ where: { id: { in: itemIds }, userId } })
      : [];
    const byId = new Map(items.map((i) => [i.id, i]));

    for (const row of watching) {
      const item = row.watchListItemId ? byId.get(row.watchListItemId) : undefined;
      if (!item) continue;
      if (!isSeriesMediaType(item.mediaType)) continue;
      if (row.season == null || row.episode == null) continue;
      const next = advanceCursor({ season: row.season, episode: row.episode });
      push({
        title: item.title,
        mediaType: item.mediaType,
        season: next.season,
        episode: next.episode,
      });
    }
  } catch {
    // Fall through to the library pass — a partial answer beats none.
  }

  return out;
}

/**
 * Pre-rank the next few things the user is likely to want.
 *
 * Sequential on purpose. The background indexer budget is 15 fan-outs a minute
 * for *all* speculation; firing them in parallel just spends it faster and
 * risks throttling the hunt. Stops early the moment the budget runs dry.
 */
export async function preRankUpcoming(
  userId: string,
  opts: PreRankOptions & { limit?: number } = {},
): Promise<PreRankedChoice[]> {
  const targets = await upcomingTargets(userId, {
    limit: opts.limit,
    db: opts.db,
  });

  const out: PreRankedChoice[] = [];
  for (const target of targets) {
    const choice = await preRank(target, opts);
    if (!choice) break;
    out.push(choice);
  }
  return out;
}
