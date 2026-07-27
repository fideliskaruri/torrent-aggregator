/**
 * B. Pre-warm the next episode.
 *
 * WHAT IT DOES
 * ------------
 * Once ~15% of an episode has been watched, quietly start fetching the next
 * one, so that when the credits roll the swarm is already found and the first
 * pieces are already on disk. This is the only way a torrent app gets near
 * "instant": you cannot win the race after the click, so you start before it.
 *
 * WHAT IT IS NOT ALLOWED TO DO
 * ----------------------------
 * A pre-warm is a guess. It is never a user action, and it must be impossible
 * to mistake for one:
 *
 *   - It writes **no `DownloadHistory` row** (see `no-user-history.ts`) — the
 *     download log is a record of what the user asked for.
 *   - It **never advances the library cursor**. `onSuccess` here deliberately
 *     does not call `advanceLibraryItemIfHuntMatch`, so a guess cannot skip an
 *     episode the user never received.
 *   - It leaves an `EngineTorrent` row stamped `origin: "prewarm"` and a
 *     `GrabJob` with `kind: "prewarm"`, so everything it did is attributable.
 *   - It never surfaces an error. Failure is logged and swallowed.
 *   - It never *reports* success it did not observe: `sent` is returned only
 *     when the pipeline actually sent, and `labelled` says plainly whether the
 *     origin stamp landed.
 *
 * BANDWIDTH — FOREGROUND PLAYBACK WINS
 * ------------------------------------
 * The built-in engine exposes no per-torrent bandwidth *priority*, so
 * connection-only prewarms stay connected but deselected while the user is being
 * served bytes. That preserves peer handshakes for "Next" without requesting
 * speculative pieces, and it is reconciled on every progress ping — so it also
 * parks a pre-warm that was *already running* when the user pressed play, which
 * the admission gates below cannot do.
 *
 * The admission gates remain, because not starting is cheaper than starting and
 * parking:
 *
 *   - at most {@link MAX_CONCURRENT_PREWARMS} speculative torrent(s) at a time;
 *   - nothing starts while a foreground stream is live at all;
 *   - nothing starts while the torrent being watched is itself still far from
 *     complete ({@link MIN_FOREGROUND_PROGRESS});
 *   - a per-title cooldown so a paused/resumed player cannot fire repeatedly.
 *
 * What is *not* proven: none of this has been observed against a live swarm or
 * a real player. See `foreground.ts` for which signal is used and why.
 *
 * REUSE
 * -----
 * Nothing here searches, ranks, selects, resolves a path, sends, or records by
 * itself. It configures `runGrabPipeline` — the single shared grab path — with
 * the same search options `prerank.ts` warmed, which is what makes the grab a
 * cache hit rather than a second indexer fan-out.
 */
import prisma from "@/lib/prisma";
import { getUserClientConfig, sendToClient } from "@/lib/clients";
import type { ClientConnectionConfig } from "@/lib/clients/types";
import { runGrabPipeline } from "@/lib/grab/pipeline";
import type { TorrentResult } from "@/lib/torrents/types";
import type { searchTorrents } from "@/lib/torrents/aggregator";
import { advanceCursor, formatEpisodeLabel, resolveHuntCursor } from "@/lib/library/cursor";
import {
  assertStorageBudget,
  resetDirectorySizeCache,
} from "@/lib/library/disk-space";
import { resolveSmartSendTarget } from "@/lib/download/smart-target";
import { catalogMetadata } from "@/lib/metadata/catalog-identity";
import { isSeriesMediaType } from "@/lib/metadata/media-type";
import { workIdentity } from "@/lib/torrents/work-identity";
import {
  preRank,
  preRankKey,
  prewarmSearchOptions,
  releaseInfoHash,
  selectBestRelease,
} from "./prerank";
import { evictPrewarmsForBytes, markPrewarmUsed } from "./eviction";
import type { EvictOptions } from "./eviction";
import { withoutDownloadHistory } from "./no-user-history";
import { syncPrewarmSuspension } from "./foreground";
import {
  PREWARM_GRAB_KIND,
  PREWARM_ORIGIN,
  USER_ORIGIN,
} from "./types";
import type {
  NextEpisode,
  PreRankTarget,
  PrewarmOutcome,
  PrewarmReason,
} from "./types";

/** Fraction of an episode that must be watched before we speculate. */
export const PREWARM_TRIGGER_FRACTION = 0.15;

/**
 * How many speculative torrents may be fetching at once.
 *
 * One. The engine has no per-torrent bandwidth priority, so the only way to
 * keep speculation from starving the thing on screen is to not do much of it.
 */
export const MAX_CONCURRENT_PREWARMS = 1;

/**
 * How complete the torrent being watched must be before we add a second swarm.
 *
 * At 15% watched a healthy torrent is normally far ahead of the playhead. If
 * it is not, the user is close to stalling and the last thing they need is
 * competition for peers.
 */
export const MIN_FOREGROUND_PROGRESS = 0.5;

/** Don't re-fire for the same next-episode inside this window. */
export const PREWARM_COOLDOWN_MS = 30 * 60 * 1000;

type Db = typeof prisma;

const inFlight = new Set<string>();
const cooldownUntil = new Map<string, number>();

/** Clear cooldowns and in-flight state. Tests only. */
export function resetPrewarmRuntimeState(): void {
  inFlight.clear();
  cooldownUntil.clear();
}

function outcome(
  status: PrewarmOutcome["status"],
  reason: PrewarmReason,
  message: string,
  extra: Partial<PrewarmOutcome> = {},
): PrewarmOutcome {
  return {
    status,
    reason,
    message,
    next: null,
    title: null,
    infoHash: null,
    preRanked: false,
    fastPath: false,
    labelled: false,
    evictedCount: 0,
    freedBytes: 0,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

/**
 * Has playback passed the pre-warm threshold?
 *
 * Deliberately a pure function of the numbers the progress ping already
 * carries, so it can be tested without a player, a torrent or a clock.
 */
export function shouldTriggerPrewarm(p: {
  positionSec: number;
  durationSec: number | null | undefined;
}): boolean {
  const duration = p.durationSec;
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) {
    return false;
  }
  if (!Number.isFinite(p.positionSec) || p.positionSec < 0) return false;
  return p.positionSec / duration >= PREWARM_TRIGGER_FRACTION;
}

// ---------------------------------------------------------------------------
// Which episode is next?
// ---------------------------------------------------------------------------

export interface PlaybackContext {
  userId: string;
  /** Info hash of the torrent being watched (already normalised). */
  infoHash: string;
  /** Title as the player knows it — usually a release name. */
  title: string;
  season?: number | null;
  episode?: number | null;
  watchListItemId?: string | null;
}

function unit(n: number | null | undefined): number | null {
  if (n == null) return null;
  const v = Math.trunc(n);
  return Number.isFinite(v) && v >= 1 ? v : null;
}

/**
 * The episode a pre-warm should fetch, or `null` when there isn't one.
 *
 * Two sources, in order of confidence:
 *
 *  1. **What is playing.** One past the episode on screen. This is where the
 *     hit rate is, and it is computed with `advanceCursor` — the same pure
 *     helper the library uses — rather than an ad-hoc `episode + 1`.
 *  2. **The library's hunt cursor.** When the player did not say which episode
 *     it is on, the watchlist row has already recorded, durably, which episode
 *     it wants next. `resolveHuntCursor` owns that logic including the season
 *     rollover and the "duplicate at the cursor" fix; it is not re-derived.
 *
 * Reading the cursor is not the same as moving it, and nothing here moves it.
 */
export async function resolveNextEpisode(
  ctx: PlaybackContext,
  opts: { db?: Db } = {},
): Promise<NextEpisode | null> {
  const db = opts.db ?? prisma;
  const season = unit(ctx.season);
  const episode = unit(ctx.episode);

  let item: {
    id: string;
    title: string;
    mediaType: string;
    cursorSeason: number | null;
    cursorEpisode: number | null;
    fromSeason: number | null;
    fromEpisode: number | null;
    lastEpisode: string | null;
    nextEpisodeHint: string | null;
  } | null = null;

  if (ctx.watchListItemId) {
    try {
      item = await db.watchListItem.findFirst({
        where: { id: ctx.watchListItemId, userId: ctx.userId },
      });
    } catch {
      item = null;
    }
  }

  if (item) {
    if (!isSeriesMediaType(item.mediaType)) return null;

    if (season != null && episode != null) {
      const next = advanceCursor({ season, episode });
      return {
        title: item.title,
        mediaType: item.mediaType,
        season: next.season,
        episode: next.episode,
        watchListItemId: item.id,
        source: "playing-episode",
      };
    }

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
    if (!hunt.cursor) return null;
    return {
      title: item.title,
      mediaType: item.mediaType,
      season: hunt.cursor.season,
      episode: hunt.cursor.episode,
      watchListItemId: item.id,
      source: "hunt-cursor",
    };
  }

  // No library row. We still know it is a series if the player told us an
  // episode number. The show name comes from `workIdentity`, which is the
  // repo's one implementation of "work name from a release name" — a raw
  // release name is not a search query.
  if (season == null || episode == null) return null;
  const work = workIdentity(ctx.title);
  const name = work.name.trim();
  if (!name) return null;

  const next = advanceCursor({ season, episode });
  return {
    title: name,
    mediaType: null,
    season: next.season,
    episode: next.episode,
    watchListItemId: null,
    source: "playing-episode",
  };
}

// ---------------------------------------------------------------------------
// The pre-warm itself
// ---------------------------------------------------------------------------

export interface PrewarmRunOptions {
  userId: string;
  next: NextEpisode;
  /** Hashes that must survive eviction — the torrent on screen. */
  protectHashes?: readonly string[];
  /** Ignore the per-title cooldown (manual trigger / tests). */
  force?: boolean;
  db?: Db;
  /** Injected client config; skips the DB lookup. */
  _config?: ClientConnectionConfig | null;
  _searchFn?: typeof searchTorrents;
  _sendFn?: typeof sendToClient;
  _deleteFn?: EvictOptions["_deleteFn"];
  /** Override the foreground-contention check (tests). */
  _foregroundProgress?: number | null;
  /** Override the live-stream verdict instead of sampling the engine (tests). */
  _foregroundActive?: boolean;
}

function targetOf(next: NextEpisode): PreRankTarget {
  return {
    title: next.title,
    mediaType: next.mediaType,
    season: next.season,
    episode: next.episode,
  };
}

/**
 * Speculatively grab `next`, honouring the disk budget.
 *
 * Never throws. Every path returns an outcome describing exactly what happened
 * and why — including the paths where it deliberately did nothing.
 */
export async function prewarmNextEpisode(
  opts: PrewarmRunOptions,
): Promise<PrewarmOutcome> {
  const db = opts.db ?? prisma;
  const next = opts.next;
  const label = formatEpisodeLabel(next.season, next.episode);
  const base = { next, title: `${next.title} ${label}` };
  const key = `${opts.userId}|${preRankKey(targetOf(next))}`;

  if (inFlight.has(key)) {
    return outcome("skipped", "in-flight", `Already pre-warming ${label}`, base);
  }
  const until = cooldownUntil.get(key);
  if (!opts.force && until != null && until > Date.now()) {
    return outcome("skipped", "cooldown", `Pre-warmed ${label} recently`, base);
  }

  inFlight.add(key);
  try {
    return await runPrewarm(opts, db, next, label, base, key);
  } catch (err) {
    // A pre-warm is a background nicety. It may never become a user-visible
    // failure, and it may never take anything else down with it.
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[prewarm] ${label} failed:`, message);
    return outcome("failed", "error", message, base);
  } finally {
    inFlight.delete(key);
  }
}

async function runPrewarm(
  opts: PrewarmRunOptions,
  db: Db,
  next: NextEpisode,
  label: string,
  base: { next: NextEpisode; title: string },
  key: string,
): Promise<PrewarmOutcome> {
  const config =
    opts._config !== undefined
      ? opts._config
      : await getUserClientConfig(opts.userId);
  if (!config) {
    return outcome("skipped", "no-client", "No client configured", base);
  }

  // External clients give us no `EngineTorrent` row, so a speculative download
  // could never be labelled `origin: "prewarm"` and could never be evicted. An
  // unlabellable, unreclaimable guess is worse than no guess.
  if (config.clientType !== "builtin") {
    return outcome(
      "skipped",
      "unlabelable-client",
      `Pre-warm needs the built-in engine (client is ${config.clientType})`,
      base,
    );
  }

  // Foreground first. Connection-only prewarms keep their peer handshakes, but
  // starting a new search/add while playback is active is still avoidable work
  // on the hot path.
  const suspension = await syncPrewarmSuspension({
    userId: opts.userId,
    db,
    ...(opts._foregroundActive !== undefined
      ? { _foregroundActive: opts._foregroundActive }
      : {}),
  });
  if (suspension.foreground) {
    return outcome(
      "skipped",
      "foreground-busy",
      `Playback is active${suspension.suspended.length ? `; parked ${suspension.suspended.length} pre-warm(s)` : ""}`,
      base,
    );
  }

  const foreground =
    opts._foregroundProgress !== undefined
      ? opts._foregroundProgress
      : await foregroundProgress(db, opts.userId, opts.protectHashes ?? []);
  if (foreground != null && foreground < MIN_FOREGROUND_PROGRESS) {
    return outcome(
      "skipped",
      "foreground-busy",
      `Playing torrent is only ${Math.round(foreground * 100)}% fetched`,
      base,
    );
  }

  const active = await db.engineTorrent.count({
    where: {
      userId: opts.userId,
      origin: PREWARM_ORIGIN,
      status: { in: ["downloading", "queued", "checking"] },
      progress: { lt: 1 },
    },
  });
  if (active >= MAX_CONCURRENT_PREWARMS) {
    return outcome(
      "skipped",
      "at-concurrency-cap",
      `${active} pre-warm(s) already active`,
      base,
    );
  }

  // ── The pre-ranked choice ────────────────────────────────────────────
  const target = targetOf(next);
  const choice = await preRank(target, { db, _searchFn: opts._searchFn });
  if (!choice) {
    // Not determined. Not "unavailable" — we simply do not know, and a guess
    // we could not price is a guess we do not make.
    return outcome(
      "not-applicable",
      "not-determined",
      `Could not pre-rank ${label}`,
      base,
    );
  }
  if (!choice.candidate) {
    return outcome(
      "not-applicable",
      "no-release",
      `No usable release for ${label} in ${choice.resultCount} results`,
      { ...base, preRanked: true },
    );
  }

  const preRankedHash = releaseInfoHash(choice.candidate);
  const preRanked = choice.source !== "search";

  // ── Already have it? ─────────────────────────────────────────────────
  if (preRankedHash) {
    const held = await db.engineTorrent.findFirst({
      where: { userId: opts.userId, hash: preRankedHash },
      select: { origin: true },
    });
    if (held) {
      // Touch it so it is not the least-recently-used row when the budget is
      // next under pressure.
      await markPrewarmUsed(opts.userId, preRankedHash, { db });
      cooldownUntil.set(key, Date.now() + PREWARM_COOLDOWN_MS);
      return outcome("skipped", "already-held", `${label} is already here`, {
        ...base,
        preRanked,
        infoHash: preRankedHash,
      });
    }

  }

  // ── Grab through the one shared pipeline ─────────────────────────────
  const search = prewarmSearchOptions(target);
  const history = withoutDownloadHistory(db);
  const searchFn = opts._searchFn ?? undefined;

  let fastPath = false;
  let stamped = 0;
  let budgetRefused = false;
  let eviction = { count: 0, bytes: 0 };
  const sendStartedAt = new Date();

  const wrappedSearch = (async (payload: Parameters<typeof searchTorrents>[0]) => {
    const impl =
      searchFn ??
      (await import("@/lib/torrents/aggregator")).searchTorrents;
    const response = await impl(payload);
    // The honest, measurable form of "the pre-rank made this fast": the grab's
    // own search never reached an indexer.
    fastPath = response.cached === true;
    return response;
  }) as typeof searchTorrents;

  const result = await runGrabPipeline({
    userId: opts.userId,
    search,
    config,
    fallbackTitle: `${next.title} ${label}`,
    addPayload: { connectOnly: true },
    grabJobKind: PREWARM_GRAB_KIND,
    externalId: next.watchListItemId,
    downloadHistoryPrefix: `Pre-warm ${label}`,
    noMatchMessage: (count) =>
      count
        ? `Pre-warm: no matching ${label} release in ${count} results`
        : `Pre-warm: no seeded torrent for ${label}`,

    // Prefer the exact release pre-ranking already chose, so the grab and the
    // pre-rank cannot disagree. Fall back to the same filter rule applied to
    // whatever the pipeline's own (cached) pool holds.
    selectCandidate(results): TorrentResult | null {
      if (preRankedHash) {
        const same = results.find((r) => releaseInfoHash(r) === preRankedHash);
        if (same) return same;
      }
      return selectBestRelease(results, target);
    },

    async checkDuplicate(candidate) {
      const hash = releaseInfoHash(candidate);
      if (!hash) return "Release has no info hash";
      const held = await db.engineTorrent.findFirst({
        where: { userId: opts.userId, hash },
        select: { id: true },
      });
      return held ? "Already downloading" : null;
    },

    // ── Disk budget: check, evict prewarms only, re-check ──────────────
    async checkStorageBudget(candidate, targetPaths) {
      const root =
        config.baseDownloadPath?.trim() ||
        targetPaths.savePath ||
        config.savePath?.trim() ||
        process.cwd();
      const incomingBytes = candidate.sizeBytes ?? null;

      const first = await assertStorageBudget({
        root,
        maxStorageBytes: config.maxStorageBytes,
        incomingBytes,
      });
      if (first.ok) return { ok: true as const };

      // Over budget. Reclaim from speculative downloads *only* — see
      // `eviction.ts`. A user's download is never a cache entry.
      const needed = Math.max(1, incomingBytes ?? 0);
      const freed = await evictPrewarmsForBytes({
        userId: opts.userId,
        neededBytes: needed,
        config,
        protectHashes: opts.protectHashes,
        db,
        _deleteFn: opts._deleteFn,
      });
      eviction = { count: freed.evicted.length, bytes: freed.freedBytes };

      if (freed.evicted.length === 0) {
        budgetRefused = true;
        return { ok: false as const, message: first.message };
      }

      // The directory-size probe memoises for 30s. Without this the re-check
      // would read the pre-eviction size and refuse space we just freed.
      resetDirectorySizeCache();

      const second = await assertStorageBudget({
        root,
        maxStorageBytes: config.maxStorageBytes,
        incomingBytes,
      });
      if (second.ok) return { ok: true as const };

      // Files are removed asynchronously, so the second probe can still see
      // them. Failing here is the safe direction: we skip rather than exceed
      // the budget, and the next progress ping tries again.
      budgetRefused = true;
      return { ok: false as const, message: second.message };
    },

    resolveTarget(cfg, candidate) {
      const t = resolveSmartSendTarget(cfg, {
        name: candidate.title,
        source: candidate.source,
        searchCategory: search.category,
        metadata: catalogMetadata({
          mediaType: next.mediaType ?? "tv",
          title: next.title,
        }),
      });
      return { category: t.category, savePath: t.savePath };
    },

    // ── Post-send, inside the transaction ─────────────────────────────
    // NOTE what is *absent*: no `advanceLibraryItemIfHuntMatch`. A pre-warm
    // must never move the cursor — the user has not received this episode and
    // moving it would silently skip one.
    async onSuccess(tx, candidate) {
      const hash = releaseInfoHash(candidate);
      if (!hash) return;
      const updated = await tx.engineTorrent.updateMany({
        where: {
          userId: opts.userId,
          hash,
          // Only a row *this send* created. If the user already owned this
          // torrent we must not relabel their download as evictable.
          origin: USER_ORIGIN,
          createdAt: { gte: sendStartedAt },
        },
        data: { origin: PREWARM_ORIGIN },
      });
      stamped = updated.count;
    },

    _searchFn: wrappedSearch,
    ...(opts._sendFn ? { _sendFn: opts._sendFn } : {}),
    // Suppresses exactly one write: the DownloadHistory row. See
    // `no-user-history.ts` for why, and for the upstream fix this stands in for.
    _prisma: history.db,
  });

  const infoHash = result.candidate
    ? releaseInfoHash(result.candidate)
    : preRankedHash;

  const common = {
    ...base,
    preRanked,
    fastPath,
    infoHash,
    evictedCount: eviction.count,
    freedBytes: eviction.bytes,
    title: result.candidate?.title ?? base.title,
  };

  if (result.status === "sent") {
    cooldownUntil.set(key, Date.now() + PREWARM_COOLDOWN_MS);
    if (stamped === 0) {
      console.warn(
        `[prewarm] ${label} sent but the EngineTorrent row was not stamped ` +
          `origin=prewarm — it will not be evictable.`,
      );
    }
    if (history.stats.suppressed !== 1) {
      // Loud on purpose. If the pipeline stops writing history, or writes it
      // somewhere this facade cannot see, the invariant has silently changed.
      console.warn(
        `[prewarm] expected to suppress exactly 1 DownloadHistory write, ` +
          `saw ${history.stats.suppressed}`,
      );
    }
    return {
      ...outcome("sent", "sent", result.message, common),
      labelled: stamped > 0,
    };
  }

  if (result.status === "failed") {
    // The pipeline reports a refused storage budget as `failed` too, but it
    // never sent anything — calling that a send failure would be a claim we
    // did not observe. The hook itself tells us which happened.
    return outcome(
      "failed",
      budgetRefused ? "no-space" : "send-failed",
      result.message,
      common,
    );
  }

  // The pipeline's idempotency guard fired: this exact hash was grabbed for
  // this user moments ago, so the episode is already coming down. Nothing was
  // written and nothing needs to be — but calling it "no-release" would claim
  // we found nothing, which is the opposite of what happened.
  if (result.status === "already_active") {
    return outcome("skipped", "already-held", result.message, common);
  }

  // "skipped" from the pipeline: no candidate, a duplicate, or not viable.
  return outcome("skipped", "no-release", result.message, common);
}

/**
 * How much of the torrent being watched has actually been fetched.
 *
 * `null` when we cannot tell — and "cannot tell" must not block a pre-warm,
 * because an absent row is not evidence of contention.
 */
async function foregroundProgress(
  db: Db,
  userId: string,
  hashes: readonly string[],
): Promise<number | null> {
  const list = hashes.map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (list.length === 0) return null;
  try {
    const rows = await db.engineTorrent.findMany({
      where: { userId, hash: { in: list } },
      select: { progress: true },
    });
    if (rows.length === 0) return null;
    return Math.min(...rows.map((r) => r.progress));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Entry point used by the progress ping
// ---------------------------------------------------------------------------

export interface PlaybackProgressSignal extends PlaybackContext {
  positionSec: number;
  durationSec: number | null | undefined;
}

/**
 * Called on every playback progress ping.
 *
 * Two jobs, in this order:
 *
 *  1. Always mark the torrent being watched as used, so LRU can never pick it.
 *     This happens on *every* ping, below the trigger threshold too.
 *  2. Past ~15%, pre-warm the next episode.
 *
 * Returns an outcome for logging and tests. Callers on a request path should
 * treat this as fire-and-forget: it must not delay a progress ping and its
 * failure must not reach the user.
 */
export async function onPlaybackProgress(
  signal: PlaybackProgressSignal,
  opts: Omit<PrewarmRunOptions, "userId" | "next"> = {},
): Promise<PrewarmOutcome> {
  try {
    await markPrewarmUsed(signal.userId, signal.infoHash, { db: opts.db });
  } catch {
    // A timestamp is not worth failing over.
  }

  // Reconcile suspension on *every* ping, not just past the trigger. This is
  // the path that parks a running pre-warm the moment the user presses play,
  // and the path that lets it resume once they stop.
  try {
    await syncPrewarmSuspension({
      userId: signal.userId,
      db: opts.db ?? prisma,
      ...(opts._foregroundActive !== undefined
        ? { _foregroundActive: opts._foregroundActive }
        : {}),
    });
  } catch (err) {
    console.warn(
      "[prewarm] suspension sync failed:",
      err instanceof Error ? err.message : String(err),
    );
  }

  if (!shouldTriggerPrewarm(signal)) {
    return outcome("not-applicable", "below-trigger", "Below 15% watched");
  }

  let next: NextEpisode | null = null;
  try {
    next = await resolveNextEpisode(signal, { db: opts.db });
  } catch (err) {
    console.warn(
      "[prewarm] could not resolve next episode:",
      err instanceof Error ? err.message : String(err),
    );
    next = null;
  }
  if (!next) {
    return outcome(
      "not-applicable",
      "no-next-episode",
      "No next episode to pre-warm",
    );
  }

  return prewarmNextEpisode({
    ...opts,
    userId: signal.userId,
    next,
    protectHashes: opts.protectHashes ?? [signal.infoHash],
  });
}
