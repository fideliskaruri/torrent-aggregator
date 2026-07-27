/**
 * The stall-and-failover watchdog.
 *
 * Ties the pure pieces together for a live playback session:
 *   - {@link evaluateStall} decides whether the current source is dead;
 *   - {@link failOver} decides which untried release to switch to;
 *   - {@link describePlayback} renders the resulting state (in the UI, not here).
 *
 * State per piece of content lives in an in-process registry keyed by a content
 * key (title + episode). Everything with a side effect — reading a live sample,
 * looking up ranked candidates, starting a download, abandoning one — is an
 * injected dependency, so the decision flow is unit-testable with fakes and the
 * route is a thin adapter.
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
import type { TorrentResult } from "@/lib/torrents/types";
import type { PreRankTarget } from "@/lib/prewarm/types";
import { evaluateStall, type StallOptions, type StallVerdict, type TransferSample } from "./stall";
import {
  commitSource,
  createFailoverSession,
  failOver,
  MAX_FAILOVER_ATTEMPTS,
  type FailoverCandidate,
  type FailoverSession,
} from "./failover";
import type { PlaybackNarration } from "./narration";

/** How many samples to retain per source. A handful past the window is plenty. */
const MAX_SAMPLES = 32;

/** Bound on distinct content keys tracked at once, so a long-lived server cannot grow forever. */
const MAX_ENTRIES = 200;

/** Side effects the watchdog needs, injected so the core stays testable. */
export interface WatchdogDeps {
  /** Read one live transfer sample for a source, or null if it is gone. */
  sample(infoHash: string): Promise<TransferSample | null>;
  /** The already-ranked candidate pool for this content (from SearchCache). */
  rankedResults(target: PreRankTarget): Promise<readonly TorrentResult[]>;
  /** Start downloading a chosen release. Returns whether it started. */
  startRelease(candidate: FailoverCandidate): Promise<boolean>;
  /** Abandon a source without deleting its bytes (pause). */
  abandon(infoHash: string): Promise<void>;
}

export interface WatchdogTickResult {
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

interface WatchdogEntry {
  session: FailoverSession;
  /** Samples for the *current* source only; cleared on every switch. */
  samples: TransferSample[];
}

const registry = new Map<string, WatchdogEntry>();

/** Test seam — drop all in-process state. */
export function resetWatchdog(): void {
  registry.clear();
}

/** Diagnostics only. */
export function watchdogEntryCount(): number {
  return registry.size;
}

function ensureEntry(contentKey: string, initialHash: string): WatchdogEntry {
  let entry = registry.get(contentKey);
  if (!entry) {
    if (registry.size >= MAX_ENTRIES) {
      const oldest = registry.keys().next();
      if (!oldest.done) registry.delete(oldest.value);
    }
    entry = { session: createFailoverSession(contentKey), samples: [] };
    registry.set(contentKey, entry);
  }
  if (!entry.session.current) {
    // First commit: the source the player opened on counts as attempt #1.
    entry.session = commitSource(entry.session, initialHash);
  }
  return entry;
}

function pushSample(entry: WatchdogEntry, sample: TransferSample): void {
  entry.samples.push(sample);
  if (entry.samples.length > MAX_SAMPLES) {
    entry.samples.splice(0, entry.samples.length - MAX_SAMPLES);
  }
}

export interface WatchdogTickOptions {
  stall?: StallOptions;
  cap?: number;
}

/**
 * Advance the watchdog for one poll of a content's playback.
 *
 * `initialHash` is the source the player is currently pointed at (the pre-ranked
 * pick on the first tick). On each tick we sample the current source, judge it,
 * and — only if it is genuinely stalled — fail over to the next untried
 * candidate, abandoning (pausing, not deleting) the dead one.
 */
export async function watchdogTick(
  contentKey: string,
  initialHash: string,
  target: PreRankTarget,
  deps: WatchdogDeps,
  options: WatchdogTickOptions = {},
): Promise<WatchdogTickResult> {
  const entry = ensureEntry(contentKey, initialHash);
  const current = entry.session.current ?? initialHash.toLowerCase();

  if (entry.session.status === "exhausted") {
    return {
      narration: { phase: "exhausted", triedCount: entry.session.tried.length },
      currentHash: current,
      switched: false,
      exhausted: true,
      verdict: { stalled: false, reason: "not-downloading", deliveredBytes: null, windowMs: null },
    };
  }

  const sample = await deps.sample(current);
  if (sample) pushSample(entry, sample);

  const verdict = evaluateStall(entry.samples, options.stall);

  if (!verdict.stalled) {
    // Not dead. "progressing" means bytes are flowing → playing; anything else
    // ("insufficient-history", "not-downloading") is still spinning up.
    const attempt = entry.session.tried.length || 1;
    const narration: PlaybackNarration =
      verdict.reason === "progressing" || verdict.reason === "complete"
        ? { phase: "playing" }
        : { phase: "starting", attempt };
    return { narration, currentHash: current, switched: false, exhausted: false, verdict };
  }

  // Stalled. Ask the failover rule for the next untried candidate.
  const results = await deps.rankedResults(target);
  const step = failOver(entry.session, results, target, options.cap ?? MAX_FAILOVER_ATTEMPTS);

  if (step.kind === "exhausted") {
    entry.session = step.session;
    return {
      narration: step.narration,
      currentHash: current,
      switched: false,
      exhausted: true,
      verdict,
    };
  }

  // Switch: start the new source, then abandon the old one (keeping its bytes).
  // Start first so a failed start does not strand us with nothing running.
  const started = await deps.startRelease(step.candidate);
  if (!started) {
    // Could not start the chosen release; do not abandon the current source or
    // mark it tried a second time. Report the attempt honestly and let the next
    // tick try again — the pool or the engine may recover.
    return {
      narration: { phase: "switching", triedCount: entry.session.tried.length, nextName: step.candidate.release.title ?? null },
      currentHash: current,
      switched: false,
      exhausted: false,
      verdict,
    };
  }

  await deps.abandon(current);
  entry.session = step.session;
  entry.samples = []; // fresh evidence for the new source; do not carry the dead one's history.

  return {
    narration: step.narration,
    currentHash: step.candidate.infoHash,
    switched: true,
    exhausted: false,
    verdict,
  };
}
