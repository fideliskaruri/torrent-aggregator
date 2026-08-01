/**
 * The **swarm-delivery** watchdog: notices when the swarm feeding a playing
 * stream has stopped delivering bytes, and fails over to another release.
 *
 * NAME — READ THIS
 * ----------------
 * There is a *second*, unrelated "watchdog" in this repo:
 * `src/lib/media/session.ts` watches an **ffmpeg session's output progress** —
 * whether new HLS segments are being written — and lives at the transcode
 * layer. This one watches **swarm byte delivery** at the torrent-engine layer.
 * They are different things at different layers; do not merge them or assume a
 * fix to one touches the other.
 *
 * HOW IT RUNS — NO UI REQUIRED
 * ----------------------------
 * This is driven server-side, not by a client POST. The engine already knows
 * when someone is watching: `foregroundActive()` / `foregroundHash()` in
 * `src/lib/prewarm/foreground.ts`, refreshed by the byte-serving path and by
 * engine byte movement. The engine's upload-throttle loop
 * (`builtin-engine.ts`) polls that signal every 5s and, on the same tick, calls
 * {@link pollForegroundSwarmWatch}. So the watchdog starts sampling the moment a
 * torrent becomes the foreground stream and stops when playback goes idle —
 * with no browser involvement, immune to a hidden tab or a client that forgets
 * to call anything.
 *
 * DECISION FLOW
 * -------------
 *   - {@link evaluateStall} decides whether the current source is dead;
 *   - {@link failOver} decides which untried release to switch to;
 *   - {@link describePlayback} renders the resulting state (in the UI, not here).
 *
 * Per-content state lives in an in-process registry keyed by a content key
 * (title + episode). Everything with a side effect — reading a live sample,
 * looking up ranked candidates, starting a download, abandoning one — is an
 * injected dependency ({@link SwarmWatchDeps}), so the decision flow is
 * unit-testable with fakes and both the foreground driver and the manual route
 * are thin adapters over the same reducer.
 *
 * DATA ON ABANDON
 * ---------------
 * When we abandon a stalled source we **pause** it and keep its partial bytes
 * on disk; we never delete. Abandoning to try another release is a *routing*
 * decision, and routing decisions are reversible: the paused swarm may recover,
 * or the user may come back to that exact release later. Deleting a user's
 * partial download is a *data-loss* decision and must stay an explicit user
 * action (the Client delete button), never a side effect of play-time routing.
 * Pausing also stops the abandoned source competing with the new one for
 * bandwidth. (Note the `builtin-engine.ts` savePath hazard is not in play here:
 * a switch starts a *different* magnet/infoHash, not the same one with a new
 * path.)
 */
import prisma from "@/lib/prisma";
import { getUserClientConfig } from "@/lib/clients";
import type { ClientConnectionConfig } from "@/lib/clients/types";
import { foregroundActive, foregroundHash } from "@/lib/prewarm/foreground";
import { parseEpisode } from "@/lib/torrents/episodes";
import { preRankKey, releaseInfoHash } from "@/lib/prewarm/prerank";
import type { TorrentResult } from "@/lib/torrents/types";
import type { PreRankTarget } from "@/lib/prewarm/types";
import { evaluateStall, type StallOptions, type StallVerdict, type TransferSample } from "./stall";
import {
  commitSource,
  createFailoverSession,
  failOver,
  pinSource,
  recordAttempt,
  type FailoverCandidate,
  type FailoverSession,
} from "./failover";
import {
  failureClass,
  waitOutcome,
  type AutomaticFailureCause,
  type FailureCause,
  type PlaybackNarration,
} from "./narration";
import type { SwarmVerdict, SwarmVerdictReader } from "./candidates";
import { buildSwarmWatchDeps } from "./engine-deps";

/** How many samples to retain per source. A handful past the window is plenty. */
const MAX_SAMPLES = 32;

/** Bound on distinct content keys tracked at once, so a long-lived server cannot grow forever. */
const MAX_ENTRIES = 200;

const WATCHDOG_POLL_MS = 5_000;

/** Side effects the watchdog needs, injected so the core stays testable. */
export interface SwarmWatchDeps {
  /** Read one live transfer sample for a source, or null if it is gone. */
  sample(infoHash: string): Promise<TransferSample | null>;
  /** The already-ranked candidate pool for this content (from SearchCache). */
  rankedResults(target: PreRankTarget): Promise<readonly TorrentResult[]>;
  /** Start downloading a chosen release. Returns whether it started. */
  startRelease(candidate: FailoverCandidate): Promise<boolean>;
  /** Abandon a source without deleting its bytes (pause). */
  abandon(infoHash: string): Promise<void>;
  /**
   * Carry the viewer's playback position from the old source to the new, so an
   * automatic switch during active playback resumes where they were instead of
   * at zero. Optional: a switch must still happen if position carry is
   * unavailable (a manual pool, or no prior position) — recovery is the point,
   * and resuming mid-file is a nicety on top, never a precondition for it.
   */
  carryPosition?(fromInfoHash: string, toInfoHash: string): Promise<number | null>;
  /**
   * Read *cached* swarm verdicts for a set of infoHashes (never probes — this
   * runs on the engine poll). When wired, the failover picker skips a release
   * the probe already measured `dead` instead of burning an attempt on it; see
   * {@link preferLiveCandidates}. Optional: absent, failover is by rank alone,
   * exactly as before measurement existed.
   */
  readVerdicts?: SwarmVerdictReader;
  /**
   * Refresh discovery after every cached candidate has been attempted. Calls are
   * serialized; results are hash-deduped before any start is attempted.
   */
  discoverResults?(
    target: PreRankTarget,
    options: {
      attemptedHashes: readonly string[];
      signal: AbortSignal;
    },
  ): Promise<{ results: readonly TorrentResult[]; exhausted: boolean }>;
}

export interface SwarmWatchTickResult {
  /** Structured facts for the UI to format. Never a sentence built here. */
  narration: PlaybackNarration;
  /** The source the player should be pointed at now. */
  currentHash: string;
  /** True on the tick where we moved to a new source. */
  switched: boolean;
  /** True once every candidate has been tried and none delivered. */
  exhausted: boolean;
  /** The stall verdict for the source evaluated this tick, for diagnosis. */
  verdict: StallVerdict;
}

interface WatchEntry {
  session: FailoverSession;
  /** Latest mutable selection plan for this stable content identity. */
  target: PreRankTarget | null;
  /** Samples for the *current* source only; cleared on every switch. */
  samples: TransferSample[];
  /**
   * The narration produced by the most recent tick. Read by
   * {@link currentForegroundState} so a status reader (and the client that polls
   * it) sees the same state the watchdog last decided, without running a tick of
   * its own. `null` until the first tick.
   */
  lastNarration: PlaybackNarration | null;
  generation: number;
  controller: AbortController;
  tickQueue: Promise<void>;
}

const registry = new Map<string, WatchEntry>();

/** Test seam — drop all in-process state. */
export function resetSwarmWatch(): void {
  for (const entry of registry.values()) entry.controller.abort();
  registry.clear();
  activeContentKey = null;
}

/** Diagnostics only. */
export function swarmWatchEntryCount(): number {
  return registry.size;
}

/** Forget one content's failover state — called when its playback ends. */
export function stopSwarmWatch(contentKey: string): void {
  registry.get(contentKey)?.controller.abort();
  registry.delete(contentKey);
}

function ensureEntry(
  contentKey: string,
  initialHash: string,
  target?: PreRankTarget,
): WatchEntry {
  let entry = registry.get(contentKey);
  if (!entry) {
    if (registry.size >= MAX_ENTRIES) {
      const oldest = registry.keys().next();
      if (!oldest.done) registry.delete(oldest.value);
    }
    entry = {
      session: createFailoverSession(contentKey),
      target: target ? { ...target } : null,
      samples: [],
      lastNarration: null,
      generation: 0,
      controller: new AbortController(),
      tickQueue: Promise.resolve(),
    };
    registry.set(contentKey, entry);
  }
  if (!entry.session.current) {
    // First commit: the source the player opened on counts as attempt #1.
    entry.session = commitSource(entry.session, initialHash);
  }
  if (target && !entry.target) entry.target = { ...target };
  return entry;
}

function preferredResolutionOf(target: PreRankTarget | null): number | null {
  const value = target?.preferredResolution;
  return value != null && Number.isFinite(value) && value >= 1
    ? Math.trunc(value)
    : null;
}

function beginGeneration(entry: WatchEntry): void {
  entry.controller.abort();
  entry.controller = new AbortController();
  entry.generation += 1;
}

function updateTarget(
  entry: WatchEntry,
  target: PreRankTarget,
  forceNewGeneration = false,
): void {
  const preferenceChanged =
    preferredResolutionOf(entry.target) !== preferredResolutionOf(target);
  if (forceNewGeneration || (entry.target !== null && preferenceChanged)) {
    beginGeneration(entry);
  }
  entry.target = { ...target };
}

/**
 * Update mutable plan state without changing the stable watchdog identity.
 * Transfer/player callers may use this before a later tick; an in-flight older
 * generation is cancelled when the preference changes.
 */
export function updateSwarmWatchTarget(
  contentKey: string,
  target: PreRankTarget,
): boolean {
  const entry = registry.get(contentKey);
  if (!entry) return false;
  updateTarget(entry, target);
  return true;
}

/** Create canonical registry identity when a control-plane no-op needs no tick. */
export function ensureSwarmWatchTarget(
  contentKey: string,
  initialHash: string,
  target: PreRankTarget,
): void {
  const entry = ensureEntry(contentKey, initialHash, target);
  updateTarget(entry, target);
}

function pushSample(entry: WatchEntry, sample: TransferSample): void {
  entry.samples.push(sample);
  if (entry.samples.length > MAX_SAMPLES) {
    entry.samples.splice(0, entry.samples.length - MAX_SAMPLES);
  }
}

export interface SwarmWatchTickOptions {
  stall?: StallOptions;
  /**
   * Why a failover on this tick would be happening. The automatic watchdog only
   * ever triggers on a delivery stall, so this defaults to `delivery`; a caller
   * that knows the current release is undecodable can pass `playability` so the
   * narration says so.
   */
  cause?: FailureCause;
  /** Specific transfer/player failure; mapped to the honest narration class. */
  failure?: AutomaticFailureCause;
  /**
   * Force a failover regardless of the byte-delivery verdict. A `playability`
   * failure is real even when bytes are flowing — the swarm is healthy, the
   * browser simply cannot decode the file — so the stall rule would (correctly)
   * say "progressing" and never switch. `force` lets that caller move on anyway.
   * Never set by the automatic delivery watchdog; a pinned source is still held.
   */
  force?: boolean;
}

/** Record the tick's narration on the entry (for status reads), then return it. */
function finish(entry: WatchEntry, result: SwarmWatchTickResult): SwarmWatchTickResult {
  entry.lastNarration = result.narration;
  return result;
}

function startingNarration(
  attempt: number,
  verdict: StallVerdict,
  sample: TransferSample | null,
): PlaybackNarration {
  const reason =
    verdict.reason === "cold-starting"
      ? "cold-starting"
      : verdict.reason === "not-downloading"
        ? "checking"
        : "connecting";
  return {
    phase: "starting",
    attempt,
    outcome: waitOutcome({
      reason,
      peerCount: sample?.peerCount ?? null,
      activeRequestCount: sample?.activeRequestCount ?? null,
      nextPollMs: WATCHDOG_POLL_MS,
    }),
  };
}

/**
 * Advance the watchdog for one poll of a content's playback.
 *
 * `initialHash` is the source the player is currently pointed at (the pre-ranked
 * pick on the first tick). On each tick we sample the current source, judge it,
 * and — only if it is genuinely stalled (or the caller forces it, e.g. a
 * playability failure) — fail over to the next untried candidate, abandoning
 * (pausing, not deleting) the dead one and carrying the viewer's position across.
 */
async function runSwarmDeliveryTick(
  entry: WatchEntry,
  contentKey: string,
  initialHash: string,
  target: PreRankTarget,
  deps: SwarmWatchDeps,
  options: SwarmWatchTickOptions = {},
  expectedGeneration = entry.generation,
  signal = entry.controller.signal,
): Promise<SwarmWatchTickResult> {
  const current = entry.session.current ?? initialHash.toLowerCase();
  const cause: FailureCause = options.failure
    ? failureClass(options.failure)
    : options.cause ?? "delivery";
  const isCurrentGeneration = () =>
    registry.get(contentKey) === entry &&
    entry.generation === expectedGeneration &&
    !signal.aborted;

  if (!isCurrentGeneration()) {
    return {
      narration: entry.lastNarration ?? { phase: "playing" },
      currentHash: entry.session.current ?? current,
      switched: false,
      exhausted: entry.session.status === "exhausted",
      verdict: {
        stalled: false,
        reason: "not-downloading",
        deliveredBytes: null,
        windowMs: null,
      },
    };
  }

  if (entry.session.status === "exhausted" && !deps.discoverResults) {
    // Terminal already: replay the exhausted narration we recorded when it
    // happened, so the honest cause (delivery vs playability) is preserved
    // rather than reset to a default on every subsequent poll.
    const narration: PlaybackNarration =
      entry.lastNarration?.phase === "exhausted"
        ? entry.lastNarration
        : {
            phase: "exhausted",
            cause,
            triedCount: entry.session.tried.length,
            outcome: {
              kind: "none-available",
              reason: cause === "playability" ? "no-playable-sources" : "all-sources-failed",
              triedCount: entry.session.tried.length,
              totalCandidates: entry.session.tried.length,
              seededCandidateCount: 0,
            },
          };
    return finish(entry, {
      narration,
      currentHash: current,
      switched: false,
      exhausted: true,
      verdict: { stalled: false, reason: "not-downloading", deliveredBytes: null, windowMs: null },
    });
  }

  const sample = await deps.sample(current);
  if (sample) pushSample(entry, sample);

  const verdict = evaluateStall(entry.samples, options.stall);

  if (!verdict.stalled && !options.force && !options.failure) {
    // Not dead and not forced. "progressing" means bytes are flowing → playing;
    // anything else ("insufficient-history", "not-downloading") is spinning up.
    const attempt = entry.session.tried.length || 1;
    const narration: PlaybackNarration =
      verdict.reason === "progressing" || verdict.reason === "complete"
        ? { phase: "playing" }
        : startingNarration(attempt, verdict, sample);
    return finish(entry, { narration, currentHash: current, switched: false, exhausted: false, verdict });
  }

  // Ask the failover rule for every unique untried candidate. A manual choice
  // affects initial preference only; it never disables automatic recovery.
  const initialResults = await deps.rankedResults(target);
  const resultByHash = new Map<string, TorrentResult>();
  const mergeResults = (releases: readonly TorrentResult[]) => {
    for (const release of releases) {
      const hash = releaseInfoHash(release);
      if (hash && !resultByHash.has(hash)) resultByHash.set(hash, release);
    }
  };
  mergeResults(initialResults);

  // Consult cached swarm verdicts so we do not fail over onto a release the
  // probe already measured dead. Best-effort and cached-only: a verdict read
  // must never block or delay a failover, so any failure falls back to
  // rank-only selection (identical to before measurement existed).
  let discoveryFinished = !deps.discoverResults;
  while (true) {
    const results = [...resultByHash.values()];
    let verdicts: ReadonlyMap<string, SwarmVerdict> | null = null;
    if (deps.readVerdicts && results.length > 0) {
      try {
        verdicts = await deps.readVerdicts([...resultByHash.keys()]);
      } catch {
        verdicts = null;
      }
    }

    if (!isCurrentGeneration()) {
      return finish(entry, {
        narration: entry.lastNarration ?? startingNarration(entry.session.tried.length || 1, verdict, sample),
        currentHash: entry.session.current ?? current,
        switched: false,
        exhausted: entry.session.status === "exhausted",
        verdict,
      });
    }

    const step = failOver(entry.session, results, target, cause, verdicts);
    if (step.kind === "exhausted") {
      if (!discoveryFinished && deps.discoverResults) {
        const before = resultByHash.size;
        const discovered = await deps.discoverResults(target, {
          attemptedHashes: entry.session.tried,
          signal,
        });
        if (!isCurrentGeneration()) {
          return finish(entry, {
            narration: entry.lastNarration ?? step.narration,
            currentHash: entry.session.current ?? current,
            switched: false,
            exhausted: false,
            verdict,
          });
        }
        mergeResults(discovered.results);
        discoveryFinished = discovered.exhausted || resultByHash.size === before;
        if (resultByHash.size > before) continue;
      }
      entry.session = step.session;
      return finish(entry, {
        narration: step.narration,
        currentHash: current,
        switched: false,
        exhausted: true,
        verdict,
      });
    }

    const started = await deps.startRelease(step.candidate);
    if (!isCurrentGeneration()) {
      if (started) await deps.abandon(step.candidate.infoHash);
      return finish(entry, {
        narration: entry.lastNarration ?? step.narration,
        currentHash: entry.session.current ?? current,
        switched: false,
        exhausted: false,
        verdict,
      });
    }
    if (!started) {
      entry.session = recordAttempt(entry.session, step.candidate.infoHash);
      continue;
    }

    if (deps.carryPosition) {
      try {
        await deps.carryPosition(current, step.candidate.infoHash);
      } catch {
        /* position carry is best-effort */
      }
    }

    if (!isCurrentGeneration()) {
      await deps.abandon(step.candidate.infoHash);
      return finish(entry, {
        narration: entry.lastNarration ?? step.narration,
        currentHash: entry.session.current ?? current,
        switched: false,
        exhausted: false,
        verdict,
      });
    }

    await deps.abandon(current);
    if (!isCurrentGeneration()) {
      await deps.abandon(step.candidate.infoHash);
      return finish(entry, {
        narration: entry.lastNarration ?? step.narration,
        currentHash: entry.session.current ?? current,
        switched: false,
        exhausted: false,
        verdict,
      });
    }
    entry.session = { ...step.session, pinnedHash: null, status: "active" };
    entry.generation += 1;
    entry.samples = [];
    return finish(entry, {
      narration: step.narration,
      currentHash: step.candidate.infoHash,
      switched: true,
      exhausted: false,
      verdict,
    });
  }
}

/**
 * Serialize state-machine ticks per content key. Discovery, verdict reads and
 * engine starts may be slow, but two polls can never race the same generation
 * or start the same fallback twice.
 */
export function swarmDeliveryTick(
  contentKey: string,
  initialHash: string,
  target: PreRankTarget,
  deps: SwarmWatchDeps,
  options: SwarmWatchTickOptions = {},
): Promise<SwarmWatchTickResult> {
  const entry = ensureEntry(contentKey, initialHash, target);
  updateTarget(entry, target);
  const expectedGeneration = entry.generation;
  const signal = entry.controller.signal;
  const run = entry.tickQueue.then(() =>
    runSwarmDeliveryTick(
      entry,
      contentKey,
      initialHash,
      target,
      deps,
      options,
      expectedGeneration,
      signal,
    ),
  );
  entry.tickQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ---------------------------------------------------------------------------
// Manual switch — the viewer picks a release from the quality selector
// ---------------------------------------------------------------------------

/**
 * Effects a manual switch needs. `startRelease`/`abandon` are the *same* engine
 * swap path {@link failOver} takes — a manual switch is not a second mechanism,
 * only a different chooser. `carryPosition` moves the viewer's playback position
 * from the old source to the new so the switch resumes where they were.
 */
export interface ManualSwitchDeps {
  rankedResults(target: PreRankTarget): Promise<readonly TorrentResult[]>;
  startRelease(candidate: FailoverCandidate): Promise<boolean>;
  abandon(infoHash: string): Promise<void>;
  /** Carry position from the old to the new source. Returns resumed seconds, or null. */
  carryPosition(fromInfoHash: string, toInfoHash: string): Promise<number | null>;
  /**
   * Resolve a chosen release by infoHash when the title-keyed ranked pool does
   * not contain it. This is the movie fix (I48): a movie's ranked pool is looked
   * up by `normalizeTitle(target.title)`, which does not carry the year, so a
   * switch built from a slightly different title (or a movie that was never
   * prewarmed into a title-keyed row) misses the pool even though the release is
   * a perfectly real one the user just picked from the selector. This fallback
   * finds it wherever it was cached, so a genuine pick resolves while a bogus
   * infoHash (present in no cache at all) still returns `not-a-candidate`.
   * Optional: a deps set without it behaves exactly as before.
   */
  resolveRelease?(chosenInfoHash: string): Promise<TorrentResult | null>;
}

export type ManualSwitchResult =
  | {
      ok: false;
      reason: "not-a-candidate" | "start-failed" | "superseded";
    }
  | { ok: true; infoHash: string; positionSec: number | null; narration: PlaybackNarration };

/**
 * Switch to a release the viewer explicitly chose and record that preference.
 *
 * Operates on the same session registry the auto-watchdog reads. The manual
 * marker is informational; it never disables automatic recovery.
 * Two rules a human watching cares about more than the machine does:
 *
 *  - **Preserve position.** Position is carried from the old source to the new
 *    *before* the old one is touched, and returned so the player resumes at the
 *    same offset — 40 minutes in stays 40 minutes in, never 0.
 *  - **Keep the bytes.** The old source is paused, never deleted, so trying 720p
 *    and switching back to 1080p does not throw the 1080p partial away. Manual
 *    switching is freely reversible.
 *
 * The chosen release must be a real candidate in the shared ranked pool — a
 * pick that cannot be resolved to a known release is rejected rather than
 * fabricated.
 */
async function runManualSwitch(
  entry: WatchEntry,
  contentKey: string,
  currentHash: string,
  chosenInfoHash: string,
  target: PreRankTarget,
  deps: ManualSwitchDeps,
  expectedGeneration: number,
  signal: AbortSignal,
): Promise<ManualSwitchResult> {
  const chosen = chosenInfoHash.toLowerCase();
  const current = entry.session.current ?? currentHash.toLowerCase();
  const isCurrentGeneration = () =>
    registry.get(contentKey) === entry &&
    entry.generation === expectedGeneration &&
    !signal.aborted;

  if (!isCurrentGeneration()) return { ok: false, reason: "superseded" };

  const results = await deps.rankedResults(target);
  if (!isCurrentGeneration()) return { ok: false, reason: "superseded" };
  let match = results.find((r) => releaseInfoHash(r) === chosen) ?? null;
  if (!match && deps.resolveRelease) {
    // I48: the title-keyed pool missed (common for movies — the pool key drops
    // the year and movies are not prewarmed). Fall back to resolving the chosen
    // release from wherever it was cached. Still rejects a truly unknown hash,
    // because that resolves to nothing anywhere.
    const resolved = await deps.resolveRelease(chosen);
    if (!isCurrentGeneration()) return { ok: false, reason: "superseded" };
    if (resolved && releaseInfoHash(resolved) === chosen) match = resolved;
  }
  if (!match) return { ok: false, reason: "not-a-candidate" };

  if (chosen === current) {
    // Re-pinning the source already playing: nothing to start or abandon, just
    // record the explicit choice so the watchdog stops second-guessing it.
    entry.session = pinSource(entry.session, chosen);
    entry.generation += 1;
    entry.samples = [];
    return { ok: true, infoHash: chosen, positionSec: null, narration: { phase: "playing" } };
  }

  const candidate: FailoverCandidate = { release: match, infoHash: chosen };
  const started = await deps.startRelease(candidate);
  if (!isCurrentGeneration()) {
    if (started) await deps.abandon(chosen);
    return { ok: false, reason: "superseded" };
  }
  if (!started) return { ok: false, reason: "start-failed" };

  // Carry position first, so the read cannot race the pause below.
  let positionSec: number | null = null;
  try {
    positionSec = await deps.carryPosition(current, chosen);
  } catch {
    positionSec = null; // best-effort — a lost carry must not fail the switch
  }
  if (!isCurrentGeneration()) {
    await deps.abandon(chosen);
    return { ok: false, reason: "superseded" };
  }

  await deps.abandon(current); // pause, never delete — reversible routing
  if (!isCurrentGeneration()) {
    await deps.abandon(chosen);
    return { ok: false, reason: "superseded" };
  }
  entry.session = pinSource(entry.session, chosen);
  entry.generation += 1;
  entry.samples = []; // fresh evidence for the new source

  return {
    ok: true,
    infoHash: chosen,
    positionSec,
    narration: {
      phase: "starting",
      attempt: 1,
      outcome: waitOutcome({ reason: "connecting", nextPollMs: WATCHDOG_POLL_MS }),
    },
  };
}

export function manualSwitchTo(
  contentKey: string,
  currentHash: string,
  chosenInfoHash: string,
  target: PreRankTarget,
  deps: ManualSwitchDeps,
): Promise<ManualSwitchResult> {
  const entry = ensureEntry(contentKey, currentHash, target);
  // Every explicit switch supersedes an older request immediately. The work is
  // still serialized behind tickQueue, while the generation check makes a slow
  // in-flight start park its source instead of committing stale state.
  updateTarget(entry, target, true);
  const expectedGeneration = entry.generation;
  const signal = entry.controller.signal;
  const run = entry.tickQueue.then(() =>
    runManualSwitch(
      entry,
      contentKey,
      currentHash,
      chosenInfoHash,
      target,
      deps,
      expectedGeneration,
      signal,
    ),
  );
  entry.tickQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ---------------------------------------------------------------------------
// Foreground driver — the production entry point (no UI required)
// ---------------------------------------------------------------------------

/**
 * The content key currently being watched, so we can clean its registry entry
 * up the moment foreground playback goes idle. Module-scoped, like the
 * foreground timestamp it shadows.
 */
let activeContentKey: string | null = null;

/** Last-resort target for legacy playback without persisted work identity. */
function targetFromReleaseName(name: string): PreRankTarget {
  const ep = parseEpisode(name);
  return {
    title: name,
    mediaType: "tv",
    season: ep.season ?? null,
    episode: ep.episode ?? null,
  };
}

function registeredForegroundIdentity(
  infoHash: string,
): { contentKey: string; target: PreRankTarget } | null {
  const normalized = infoHash.toLowerCase();
  if (activeContentKey) {
    const active = registry.get(activeContentKey);
    if (
      active?.target &&
      (active.session.current === normalized ||
        active.session.tried.includes(normalized))
    ) {
      return { contentKey: activeContentKey, target: active.target };
    }
  }
  for (const [contentKey, entry] of registry) {
    if (
      entry.target &&
      (entry.session.current === normalized ||
        entry.session.tried.includes(normalized))
    ) {
      return { contentKey, target: entry.target };
    }
  }
  return null;
}

export interface ForegroundPollOptions {
  db?: typeof prisma;
  now?: number;
  tickOptions?: SwarmWatchTickOptions;
  /** Test seam: resolve a user's client config. */
  getConfig?: (userId: string) => Promise<ClientConnectionConfig | null>;
  /** Test seam: build the engine-backed effects for a config. */
  buildDeps?: (config: ClientConnectionConfig) => SwarmWatchDeps;
}

export type ForegroundPollResult =
  | { active: false; watched: false; result: null }
  | { active: true; watched: false; result: null; reason: string }
  | { active: true; watched: true; result: SwarmWatchTickResult; contentKey: string };

/**
 * One poll of the foreground stream — the function the engine's 5s throttle
 * loop calls.
 *
 * When a torrent is the foreground stream, this resolves its content and runs a
 * {@link swarmDeliveryTick}, which is what makes the whole subsystem reachable
 * without any client call. When foreground playback has gone idle, it cleans up
 * the watched content's state. Never throws: it runs on the engine's timer and
 * a failover nicety must never take the engine down.
 */
export async function pollForegroundSwarmWatch(
  opts: ForegroundPollOptions = {},
): Promise<ForegroundPollResult> {
  const now = opts.now ?? Date.now();

  if (!foregroundActive(now)) {
    // Playback ended (or the grace period lapsed): stop watching and clean up.
    if (activeContentKey) {
      stopSwarmWatch(activeContentKey);
      activeContentKey = null;
    }
    return { active: false, watched: false, result: null };
  }

  const hash = foregroundHash();
  if (!hash) return { active: true, watched: false, result: null, reason: "no-foreground-hash" };

  try {
    const db = opts.db ?? prisma;
    const row = await db.engineTorrent.findFirst({
      where: { hash: hash.toLowerCase() },
      select: { userId: true, name: true },
    });
    if (!row) return { active: true, watched: false, result: null, reason: "no-engine-row" };

    const registered = registeredForegroundIdentity(hash);
    const persisted = registered
      ? null
      : await db.playbackProgress.findFirst({
          where: { userId: row.userId, infoHash: hash.toLowerCase() },
          orderBy: { updatedAt: "desc" },
          select: { title: true, season: true, episode: true },
        });
    const inferredTarget: PreRankTarget = persisted?.title.trim()
      ? {
          title: persisted.title.trim(),
          mediaType:
            persisted.season != null || persisted.episode != null
              ? "tv"
              : "movie",
          season: persisted.season,
          episode: persisted.episode,
        }
      : targetFromReleaseName(row.name);
    const contentKey = registered?.contentKey ?? preRankKey(inferredTarget);
    const target =
      registered?.target ?? registry.get(contentKey)?.target ?? inferredTarget;

    const getConfig = opts.getConfig ?? getUserClientConfig;
    const config = await getConfig(row.userId);
    if (!config || config.clientType !== "builtin") {
      return { active: true, watched: false, result: null, reason: "no-builtin-config" };
    }

    // The default builder is given the viewer's id so an automatic recovery can
    // carry their playback position to the new source. A test seam (`buildDeps`)
    // keeps the `(config) => deps` shape and simply omits carry.
    const build = opts.buildDeps ?? ((c: ClientConnectionConfig) => buildSwarmWatchDeps(c, row.userId));
    const deps = build(config);
    const result = await swarmDeliveryTick(contentKey, hash, target, deps, opts.tickOptions);
    activeContentKey = contentKey;
    return { active: true, watched: true, result, contentKey };
  } catch (err) {
    console.warn(
      "[swarm-watch] foreground poll failed:",
      err instanceof Error ? err.message : String(err),
    );
    return { active: true, watched: false, result: null, reason: "error" };
  }
}

// ---------------------------------------------------------------------------
// Status read — how a stalled swarm's recovery reaches the player
// ---------------------------------------------------------------------------

/**
 * The current foreground playback state, for a client (or a status route) to
 * read on a UI-latency path.
 *
 * WHY THIS EXISTS — recovery must reach the player
 * ------------------------------------------------
 * Detecting a stall and switching the engine to a healthy release server-side
 * is only half the job: if the browser stays pointed at the dead infoHash it
 * still shows a black screen, and the feature has not delivered. There is no
 * server→client push in this app, so recovery reaches the player by the player
 * polling this state and re-pointing when `currentHash` changes. `positionSec`
 * is the resume point (the watchdog carried it to the new source before
 * abandoning the old), so the switch resumes mid-file, not at zero.
 *
 * This is a pure READ of the last tick's decision — it never runs a tick, never
 * samples, never probes. It reflects exactly what the engine's 5s poll last
 * decided for whatever is the foreground content.
 */
export interface ForegroundPlaybackState {
  contentKey: string;
  /** The source the player should be pointed at now (may differ after a switch). */
  currentHash: string;
  /** The user's explicit pick, if any — exempt from automatic failover. */
  pinnedHash: string | null;
  /** Structured state from the last tick; the UI renders it via `describePlayback`. */
  narration: PlaybackNarration;
  /** True once every candidate was tried and none worked — a terminal answer. */
  exhausted: boolean;
}

/**
 * Read the last decided state for the content currently being watched, or null
 * when nothing is in the foreground or it has not ticked yet.
 */
export function currentForegroundState(): ForegroundPlaybackState | null {
  if (!activeContentKey) return null;
  const entry = registry.get(activeContentKey);
  if (!entry || !entry.session.current) return null;
  return {
    contentKey: activeContentKey,
    currentHash: entry.session.current,
    pinnedHash: entry.session.pinnedHash,
    narration:
      entry.lastNarration ??
      startingNarration(
        entry.session.tried.length || 1,
        { stalled: false, reason: "insufficient-history", deliveredBytes: null, windowMs: null },
        null,
      ),
    exhausted: entry.session.status === "exhausted",
  };
}

// ---------------------------------------------------------------------------
// Poll health — silence must mean "working", never "broken"
// ---------------------------------------------------------------------------

/**
 * The engine drives {@link pollForegroundSwarmWatch} fire-and-forget on its
 * throttle timer: a failover bug must never stop that timer. But an *empty*
 * catch is a live hole — if the poll fails on every tick the watchdog is dead
 * and nothing anywhere says so, and the symptom ("no stalls detected") is
 * indistinguishable from the feature working. That is exactly the class of
 * failure this whole feature exists to catch, so it must not itself fail silent.
 *
 * The rule: swallow the error (never propagate), but make it observable. Log the
 * first failure loudly (stall detection is DOWN), then rate-limit repeats to one
 * line per {@link POLL_FAILURE_LOG_THROTTLE_MS} so a permanently-broken watchdog
 * neither spams the log nor disappears from it, and log the transition back to
 * healthy so an operator can see it recover. Silence means working.
 */
export const POLL_FAILURE_LOG_THROTTLE_MS = 60_000;

interface PollHealth {
  consecutiveFailures: number;
  lastReportedAt: number;
}

let pollHealth: PollHealth = { consecutiveFailures: 0, lastReportedAt: 0 };

/** Test seam — reset the poll-health bookkeeping. */
export function resetSwarmWatchPollHealth(): void {
  pollHealth = { consecutiveFailures: 0, lastReportedAt: 0 };
}

/** Diagnostics: consecutive poll failures seen so far (0 when healthy). */
export function swarmWatchConsecutiveFailures(): number {
  return pollHealth.consecutiveFailures;
}

export interface PollHealthDeps {
  now?: number;
  log?: (message: string, error?: unknown) => void;
}

export type PollHealthTransition =
  | "healthy"
  | "failing" // first failure of a run
  | "failing-throttled" // still failing, logged after the throttle window
  | "failing-silent" // still failing, within the throttle window (not logged)
  | "recovered";

/**
 * Record the outcome of one poll and report failures observably.
 *
 * Returns whether it logged and which transition it saw, so a test can assert
 * on the reporting without scraping console output.
 */
export function recordSwarmWatchPollOutcome(
  ok: boolean,
  error?: unknown,
  deps: PollHealthDeps = {},
): { logged: boolean; transition: PollHealthTransition } {
  const now = deps.now ?? Date.now();
  const log =
    deps.log ??
    ((message: string, err?: unknown) =>
      err === undefined ? console.error(message) : console.error(message, err));

  if (ok) {
    if (pollHealth.consecutiveFailures > 0) {
      const failures = pollHealth.consecutiveFailures;
      pollHealth = { consecutiveFailures: 0, lastReportedAt: 0 };
      log(`[swarm-watch] poll recovered after ${failures} consecutive failure(s); stall detection is back up`);
      return { logged: true, transition: "recovered" };
    }
    return { logged: false, transition: "healthy" };
  }

  const wasFailing = pollHealth.consecutiveFailures > 0;
  pollHealth.consecutiveFailures += 1;

  if (!wasFailing) {
    pollHealth.lastReportedAt = now;
    log("[swarm-watch] foreground poll failing — stall detection is DOWN", error);
    return { logged: true, transition: "failing" };
  }

  if (now - pollHealth.lastReportedAt >= POLL_FAILURE_LOG_THROTTLE_MS) {
    pollHealth.lastReportedAt = now;
    log(
      `[swarm-watch] foreground poll still failing (${pollHealth.consecutiveFailures} consecutive) — stall detection remains DOWN`,
      error,
    );
    return { logged: true, transition: "failing-throttled" };
  }

  return { logged: false, transition: "failing-silent" };
}

/**
 * One watchdog beat, as the engine timer calls it: run the foreground poll and
 * report its health. **Never throws and never rejects** — that is the property
 * that keeps the engine's throttle timer alive — while routing every failure
 * (a thrown poll, or an internal `error` verdict) through
 * {@link recordSwarmWatchPollOutcome} so a dead watchdog cannot hide.
 *
 * `poll` is injectable so a test can drive a throwing tick without a live engine.
 */
export async function driveForegroundSwarmWatch(
  poll: () => Promise<Pick<ForegroundPollResult, "active"> & { reason?: string }> = () =>
    pollForegroundSwarmWatch(),
  deps: PollHealthDeps = {},
): Promise<void> {
  try {
    const result = await poll();
    // An `error` reason is the internal catch firing — a genuine failure — while
    // every other outcome (idle, no row, no config, watched) is normal running.
    const ok = !("reason" in result) || result.reason !== "error";
    recordSwarmWatchPollOutcome(ok, ok ? undefined : new Error("poll returned error verdict"), deps);
  } catch (err) {
    recordSwarmWatchPollOutcome(false, err, deps);
  }
}
