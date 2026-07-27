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
import { preRankKey } from "@/lib/prewarm/prerank";
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
import { buildSwarmWatchDeps } from "./engine-deps";

/** How many samples to retain per source. A handful past the window is plenty. */
const MAX_SAMPLES = 32;

/** Bound on distinct content keys tracked at once, so a long-lived server cannot grow forever. */
const MAX_ENTRIES = 200;

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
  /** Samples for the *current* source only; cleared on every switch. */
  samples: TransferSample[];
}

const registry = new Map<string, WatchEntry>();

/** Test seam — drop all in-process state. */
export function resetSwarmWatch(): void {
  registry.clear();
  activeContentKey = null;
}

/** Diagnostics only. */
export function swarmWatchEntryCount(): number {
  return registry.size;
}

/** Forget one content's failover state — called when its playback ends. */
export function stopSwarmWatch(contentKey: string): void {
  registry.delete(contentKey);
}

function ensureEntry(contentKey: string, initialHash: string): WatchEntry {
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

function pushSample(entry: WatchEntry, sample: TransferSample): void {
  entry.samples.push(sample);
  if (entry.samples.length > MAX_SAMPLES) {
    entry.samples.splice(0, entry.samples.length - MAX_SAMPLES);
  }
}

export interface SwarmWatchTickOptions {
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
export async function swarmDeliveryTick(
  contentKey: string,
  initialHash: string,
  target: PreRankTarget,
  deps: SwarmWatchDeps,
  options: SwarmWatchTickOptions = {},
): Promise<SwarmWatchTickResult> {
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

// ---------------------------------------------------------------------------
// Foreground driver — the production entry point (no UI required)
// ---------------------------------------------------------------------------

/**
 * The content key currently being watched, so we can clean its registry entry
 * up the moment foreground playback goes idle. Module-scoped, like the
 * foreground timestamp it shadows.
 */
let activeContentKey: string | null = null;

/**
 * Build the failover target for a live source from its `EngineTorrent` row.
 *
 * The row's `name` is the release name; `normalizeTitle` (applied downstream by
 * `preRankKey` and the SearchCache lookup) reduces both it and the search query
 * to the same work name, so a release "The Bear S01E01 1080p WEB-DL" keys to
 * the pool searched for "The Bear S01E01". The episode numbers come from
 * `parseEpisode`, matching how the pool was filtered when it was built.
 */
function targetFromReleaseName(name: string): PreRankTarget {
  const ep = parseEpisode(name);
  return {
    title: name,
    mediaType: "tv",
    season: ep.season ?? null,
    episode: ep.episode ?? null,
  };
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

    const target = targetFromReleaseName(row.name);
    const contentKey = preRankKey(target);

    const getConfig = opts.getConfig ?? getUserClientConfig;
    const config = await getConfig(row.userId);
    if (!config || config.clientType !== "builtin") {
      return { active: true, watched: false, result: null, reason: "no-builtin-config" };
    }

    const deps = (opts.buildDeps ?? buildSwarmWatchDeps)(config);
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
