/**
 * B. Speculative pre-probing — measure the swarm *before* the click.
 *
 * WHY
 * ---
 * Pre-ranking (`prerank.ts`) removes the pre-click work of *deciding* which
 * release to grab, but it decides on the indexer's advertised seeder counts.
 * Those counts are a claim, and the claim does not survive contact with the
 * swarm — 28 advertised seeders became 6 connected and 0 delivering on the
 * release that stalled a real playback. The only way to know a swarm can feed
 * us is to attach to it and watch the bytes arrive. That is a probe, and a
 * probe is worth doing *before* the user presses play so the verdict is already
 * stored when the choice is made.
 *
 * WHAT THIS IS
 * ------------
 * A bounded, speculative pass that takes the top handful of candidates for the
 * few things the user is most likely to watch next, probes each swarm through
 * `probeAndRecord`, and stores the verdict keyed by info-hash. `prerank.ts`
 * then reads those verdicts and lets a measured `good` beat an advertised
 * claim (and demotes a measured `dead`).
 *
 * WHY IT IS BOUNDED THE WAY IT IS
 * -------------------------------
 * Probing is speculative work, and speculative work must never compete with a
 * viewer. Three hard limits enforce that:
 *
 *   1. **Never while a foreground stream is active.** `foregroundActive()` is
 *      the same signal the engine's upload throttle already respects; a probe
 *      opens connections and pulls bytes, which is exactly the contention that
 *      machinery exists to prevent. If someone is watching, this pass does
 *      nothing at all.
 *   2. **Only the top few candidates, only for the top few targets.** The point
 *      is to have measured *the release we would actually pick*, not to survey
 *      the whole pool. Two targets × three candidates is at most six short
 *      probes, and the numbers are named constants below so the ceiling is
 *      obvious and easy to tune.
 *   3. **Sequential, and skips anything already known or already live.** A
 *      fresh verdict is not re-measured (that is what the TTL is for), and a
 *      live download is never probed — `probeSwarm` guards that too, but we do
 *      not even queue it.
 */
import prisma from "@/lib/prisma";
import { foregroundActive } from "./foreground";
import { normalizeTitle } from "@/lib/utils";
import { releaseInfoHash, upcomingTargets } from "./prerank";
import {
  getSwarmMeasurement,
  probeAndRecord,
  type SwarmVerdict,
} from "@/lib/torrents/swarm-probe";
import { findLiveBuiltinTorrent } from "@/lib/clients/builtin-engine";
import type { PreRankTarget } from "./types";
import type { SearchResponse, TorrentResult } from "@/lib/torrents/types";

/**
 * How many upcoming targets one pre-probe pass will look at.
 *
 * Small on purpose: the first target in `upcomingTargets` (the next episode of
 * whatever is in Continue Watching) is by a wide margin the most likely to be
 * pressed play on. Spending the budget there beats spreading it thin.
 */
export const MAX_PREPROBE_TARGETS = 2;

/**
 * How many candidates per target get probed.
 *
 * The ranker already put the best advertised release first, so the release we
 * would pick is almost always in the top three. Probing the top three means we
 * have measured the likely winner *and* its two most likely stand-ins, which is
 * what makes a `good`-beats-claim / `dead`-demote decision meaningful at click
 * time without surveying forty rows.
 */
export const MAX_PREPROBE_CANDIDATES = 3;

export interface PreProbeResult {
  /** Why the pass did nothing, when it did nothing. */
  skipped?: "foreground" | "no-targets";
  /** Info-hashes freshly probed this pass. */
  probed: string[];
  /** Info-hashes skipped because a fresh verdict already existed. */
  skippedFresh: string[];
  /** Info-hashes skipped because they are a live download. */
  skippedLive: string[];
  /** Verdicts observed (freshly measured or already-fresh), by info-hash. */
  verdicts: Record<string, SwarmVerdict>;
}

export interface PreProbeOptions {
  db?: typeof prisma;
  limitTargets?: number;
  limitCandidates?: number;
  /** Test seam — inject a fake probe so unit tests never touch a swarm. */
  _probeFn?: typeof probeAndRecord;
  /** Test seam — inject the live-download guard. */
  _findLive?: (hash: string) => unknown;
  /** Test seam — override the foreground check. */
  _foregroundActive?: () => boolean;
  /** Test seam — supply the ranked pool for a target directly. */
  _poolFor?: (target: PreRankTarget) => Promise<TorrentResult[]>;
  /** Test seam — supply upcoming targets directly instead of reading the DB. */
  _targets?: PreRankTarget[];
}

/**
 * Read the most recent ranked pool for a target from `SearchCache`.
 *
 * Keyed by `normalizedQuery`, never by a reconstructed `cacheKey` — the same
 * sanctioned seam `getPreRanked` uses (see prerank.ts module header). A probe
 * pass that guessed the cache key would miss 100% of the time.
 */
async function poolForTarget(
  target: PreRankTarget,
  db: typeof prisma,
): Promise<TorrentResult[]> {
  const normalizedQuery = normalizeTitle(target.title);
  if (!normalizedQuery) return [];
  try {
    const row = await db.searchCache.findFirst({
      where: { normalizedQuery },
      orderBy: { expiresAt: "desc" },
    });
    if (!row) return [];
    const payload = JSON.parse(row.payload) as SearchResponse;
    return Array.isArray(payload.results) ? payload.results : [];
  } catch {
    return [];
  }
}

/**
 * The top candidates for a target worth probing: usable releases (magnet +
 * info-hash + at least one advertised seeder), in the ranker's order, capped.
 * Season packs are excluded for the same reason `selectBestRelease` excludes
 * them — the pre-warm budget is sized for one episode.
 */
function topCandidates(
  results: readonly TorrentResult[],
  limit: number,
): TorrentResult[] {
  const out: TorrentResult[] = [];
  for (const r of results) {
    if (!r.magnet) continue;
    if ((r.seeders ?? 0) <= 0) continue;
    if (releaseInfoHash(r) === null) continue;
    if (r.episode?.isSeasonPack) continue;
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Speculatively probe the swarms of the top candidates for the next few things
 * the user is likely to watch, and store the verdicts.
 *
 * Does nothing while a foreground stream is active. Safe to call on a timer or
 * from the background prewarm route; it never throws for probe failure (an
 * unreachable swarm simply reads `unknown`).
 */
export async function preProbeUpcoming(
  userId: string,
  opts: PreProbeOptions = {},
): Promise<PreProbeResult> {
  const db = opts.db ?? prisma;
  const isForeground = opts._foregroundActive ?? foregroundActive;
  const probe = opts._probeFn ?? probeAndRecord;
  const findLive = opts._findLive ?? findLiveBuiltinTorrent;
  const poolFor =
    opts._poolFor ?? ((t: PreRankTarget) => poolForTarget(t, db));

  const result: PreProbeResult = {
    probed: [],
    skippedFresh: [],
    skippedLive: [],
    verdicts: {},
  };

  // Rule 1: never compete with a viewer. Speculative work yields, always.
  if (isForeground()) {
    result.skipped = "foreground";
    return result;
  }

  const maxTargets = Math.max(1, opts.limitTargets ?? MAX_PREPROBE_TARGETS);
  const maxCandidates = Math.max(
    1,
    opts.limitCandidates ?? MAX_PREPROBE_CANDIDATES,
  );

  const targets =
    opts._targets ?? (await upcomingTargets(userId, { limit: maxTargets, db }));
  if (targets.length === 0) {
    result.skipped = "no-targets";
    return result;
  }

  const done = new Set<string>();

  for (const target of targets.slice(0, maxTargets)) {
    // Re-check between targets: a viewer may have pressed play mid-pass, and a
    // probe must yield the instant that happens.
    if (isForeground()) {
      result.skipped = "foreground";
      return result;
    }

    const pool = await poolFor(target);
    const candidates = topCandidates(pool, maxCandidates);

    for (const candidate of candidates) {
      const hash = releaseInfoHash(candidate);
      if (!hash || done.has(hash)) continue;
      done.add(hash);

      // Skip anything already live: never probe (or risk destroying) a real
      // download. `probeSwarm` guards this too; we avoid even queueing it.
      if (findLive(hash)) {
        result.skippedLive.push(hash);
        continue;
      }

      // Skip anything with a fresh verdict — that is what the TTL is for.
      const existing = await getSwarmMeasurement(hash, { db });
      if (existing && existing.verdict !== "unknown") {
        result.skippedFresh.push(hash);
        result.verdicts[hash] = existing.verdict;
        continue;
      }

      if (isForeground()) {
        result.skipped = "foreground";
        return result;
      }

      const measurement = await probe(
        { magnet: candidate.magnet ?? null, infoHash: hash },
        { db, sizeBytes: candidate.sizeBytes ?? null },
      );
      result.probed.push(hash);
      if (measurement) result.verdicts[hash] = measurement.verdict;
    }
  }

  return result;
}
