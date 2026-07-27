/**
 * Swarm probe — replace the indexer's *claim* with a *measurement*.
 *
 * WHY THIS EXISTS
 * ---------------
 * The ranker (`ranking.ts` / `quality.ts`) does its job perfectly on the
 * evidence it has: it log-scales advertised seeders, adds a seed/leech ratio
 * bonus, and picks the healthiest-looking release. But an advertised seeder
 * count is a *claim* from the indexer, and that claim does not survive contact
 * with the swarm. Measured live on "The Bear S01E01": 28 advertised seeders
 * became 6 connected and 0 delivering — the player sat on a spinner at 0.77%
 * for 40 seconds while `progress` never moved.
 *
 * Everything else in the pipeline is already fast (the bitrate harness clears
 * 7.85x–12.80x headroom; a healthy public swarm reaches 32 peers / 14.9 MiB/s).
 * The last bottleneck is *choosing a release whose swarm can actually feed us*,
 * and no amount of better ranking on advertised numbers can fix that, because
 * the number itself is the lie. So we briefly attach to the swarm, find out
 * what it delivers, and remember the answer.
 *
 * THE VOCABULARY IS SHARED WITH THE BITRATE HARNESS
 * -------------------------------------------------
 * `scripts/media-stream-bitrate.mts` already judges "can this stream" and
 * demands {@link MIN_HEADROOM} = 1.5x over the file's own bitrate. We reuse
 * that exact number and its reasoning: at 1.0x the buffer refills precisely as
 * fast as playback drains, so the first hiccup never recovers. Two places now
 * judge streamability and they must not disagree.
 *
 * `unknown` IS NOT `dead`
 * -----------------------
 * This distinction is load-bearing across the codebase (see the
 * `availability: null` discussion in docs/handover.md §3, and
 * `src/lib/browse/availability.ts`). Absence of evidence is not evidence of
 * absence: a probe that never connected to a peer, timed out before any signal,
 * or could not get metadata knows *nothing* and must say so. A wrong `dead`
 * hides a release the user could have watched. `dead` is only ever returned
 * when we connected to peers and they gave us nothing.
 */
import prisma from "@/lib/prisma";
import os from "node:os";
import path from "node:path";
import { infoHashFromMagnet, normalizeInfoHash } from "@/lib/torrents/infohash";

// ---------------------------------------------------------------------------
// The verdict vocabulary
// ---------------------------------------------------------------------------

export type SwarmVerdict = "good" | "weak" | "dead" | "unknown";

/**
 * Required headroom over the file's own bitrate. **Identical to the bitrate
 * harness's `MIN_HEADROOM`** (`scripts/media-stream-bitrate.mts:112`) on
 * purpose: two independent judges of "can this stream" must use one threshold.
 *
 * Delivering exactly 1.0x is a *failing* stream, not a marginal one — playback
 * drains the buffer at exactly the rate it refills, so there is no slack to
 * recover from a single slow piece and every hiccup is permanent. 1.5x is the
 * margin a stream needs to feel instant and to survive a seek.
 */
export const MIN_HEADROOM = 1.5;

/**
 * The bitrate we assume when a file's duration is unknown, in Mbit/s.
 *
 * "Required bitrate" is normally derived from the file's own size ÷ duration.
 * Before a download exists we rarely know the duration (ffprobe needs bytes on
 * disk), so we fall back to this. 8 Mbit/s is the "1080p WEB-DL, the common
 * case" fixture in the bitrate harness — a deliberately *demanding* default, so
 * the fallback errs toward calling a marginal swarm `weak` rather than falsely
 * calling it `good`. It is named here rather than buried in a formula so the
 * assumption is visible and changeable.
 */
export const DEFAULT_REQUIRED_MBPS = 8;

/**
 * How long the probe attaches to a swarm, in milliseconds.
 *
 * Single-digit seconds on purpose. It must be cheap enough to run
 * *speculatively* against several candidates, so a long window is not an
 * option. 8s is long enough for a live swarm to prove itself — metadata for a
 * public magnet lands in ~5.7s and the engine clears 23% within 10s once µTP is
 * off (see `builtin-engine.ts`) — while a genuinely dead swarm delivers nothing
 * in any window, so a longer one would not rescue it, only cost more.
 */
export const PROBE_WINDOW_MS = 8_000;

/**
 * How long a measured verdict is trusted before it reads as `unknown` again.
 *
 * Swarms decay and revive: a release that was dead this morning may be fine by
 * evening, and permanently blacklisting it on one bad probe is worse than the
 * bug we are fixing. 6 hours balances the two — long enough to avoid re-probing
 * the same magnet on every play or speculation across a browsing afternoon,
 * short enough that a swarm gets a fresh chance within the day. It also mirrors
 * the existing 6-hour thin-swarm reconsideration window (`seederWaitSince` in
 * the library cursor), so the app reconsiders swarm health on one cadence.
 */
export const SWARM_MEASUREMENT_TTL_MS = 6 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Required bitrate (pure)
// ---------------------------------------------------------------------------

const MBIT = 1_000_000;

/**
 * The throughput a file needs to sustain playback, in **bytes per second**.
 *
 * Derived from size and duration when both are known (`bytes ÷ seconds` is the
 * file's own average bitrate). When duration is unknown, falls back to the
 * named {@link DEFAULT_REQUIRED_MBPS}. Always returns a positive number so a
 * headroom ratio can never divide by zero.
 */
export function requiredBitrateBps(input: {
  sizeBytes?: number | null;
  durationSec?: number | null;
}): number {
  const size = input.sizeBytes ?? 0;
  const duration = input.durationSec ?? 0;
  if (
    Number.isFinite(size) &&
    size > 0 &&
    Number.isFinite(duration) &&
    duration > 0
  ) {
    return size / duration;
  }
  // Fallback: DEFAULT_REQUIRED_MBPS is Mbit/s; convert to bytes/sec.
  return (DEFAULT_REQUIRED_MBPS * MBIT) / 8;
}

// ---------------------------------------------------------------------------
// The verdict rule (pure, table-driven tested)
// ---------------------------------------------------------------------------

/** The measured facts a verdict is derived from. */
export interface SwarmFacts {
  /**
   * Did we actually attach to the swarm and learn anything? False when the
   * probe failed, produced no metadata, or timed out before any signal — the
   * `unknown` cases. Absence of evidence, not evidence of absence.
   */
  reachedSwarm: boolean;
  /** How many peers actually connected (not how many were advertised). */
  peersConnected: number;
  /** Total content bytes actually received. */
  bytesReceived: number;
  /** Derived effective throughput, bytes/sec. */
  effectiveBps: number;
  /** The bitrate to clear, bytes/sec (from {@link requiredBitrateBps}). */
  requiredBps: number;
}

/**
 * Turn measured facts into a verdict.
 *
 * The order of these branches is the whole rule:
 *
 *  1. **unknown** — we could not find out. No attach, or nobody connected. This
 *     comes first so it can never be mistaken for `dead`. A swarm we never
 *     reached is not a swarm we proved empty.
 *  2. **dead** — peers connected and delivered *nothing*. This is the only path
 *     to `dead`, and it requires real evidence: at least one connected peer and
 *     zero bytes. (28 advertised → 6 connected → 0 bytes is exactly this.)
 *  3. **good** — throughput clears the required bitrate with ≥1.5x headroom.
 *     Compared with `>=`, so *exactly* 1.5x is `good`, matching the harness.
 *  4. **weak** — it delivered something, but not enough to sustain playback.
 */
export function classifySwarm(facts: SwarmFacts): SwarmVerdict {
  if (!facts.reachedSwarm) return "unknown";
  if (facts.peersConnected <= 0) return "unknown";
  if (facts.bytesReceived <= 0) return "dead";

  const required = facts.requiredBps > 0 ? facts.requiredBps : requiredBitrateBps({});
  if (facts.effectiveBps >= required * MIN_HEADROOM) return "good";
  return "weak";
}

// ---------------------------------------------------------------------------
// Measurement shape
// ---------------------------------------------------------------------------

export interface SwarmMeasurement {
  /** Normalised (lowercase-hex) info-hash. */
  infoHash: string;
  /** Peers that actually connected. */
  peersConnected: number;
  /** Of those, how many actually sent us bytes. */
  peersUnchoked: number;
  /** Total content bytes received. */
  bytesReceived: number;
  /** How long the probe ran, milliseconds. */
  elapsedMs: number;
  /** Derived effective throughput, bytes/sec. */
  effectiveBps: number;
  /** The bitrate the verdict was judged against, bytes/sec. */
  requiredBps: number;
  verdict: SwarmVerdict;
  /** Epoch ms the measurement was taken. */
  measuredAt: number;
  /**
   * True when the figures were read off a live user download instead of a fresh
   * probe. The probe must never add or destroy a real download.
   */
  fromLiveDownload: boolean;
}

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

/** The subset of a WebTorrent torrent the probe reads. Kept tiny on purpose. */
export interface ProbeTorrentHandle {
  infoHash?: string;
  length?: number;
  numPeers?: number;
  downloadSpeed?: number;
  downloaded?: number;
  received?: number;
  wires?: Array<{ downloaded?: number } | null | undefined>;
  on?: (ev: string, fn: (...args: unknown[]) => void) => void;
  removeListener?: (ev: string, fn: (...args: unknown[]) => void) => void;
  destroy: (
    opts?: { destroyStore?: boolean },
    cb?: (err?: Error) => void,
  ) => void;
}

export interface ProbeClient {
  add: (...args: unknown[]) => ProbeTorrentHandle;
  torrents: unknown[];
}

export interface ProbeDeps {
  /** The live engine client. Defaults to the built-in engine's singleton. */
  getClient?: () => Promise<ProbeClient>;
  /**
   * Find a live real download by hash. If it returns a torrent, the probe reads
   * *its* figures and never touches it. Defaults to the built-in engine.
   */
  findLive?: (hash: string) => ProbeTorrentHandle | null;
  /**
   * How a torrent is added. Defaults to `addTorrentWithEngineDefaults`, which
   * is what inherits the private-swarm tracker rule — the probe must not bypass
   * it or it could leak to public trackers in tests.
   */
  addTorrent?: (
    client: ProbeClient,
    input: string,
    dest: string,
  ) => ProbeTorrentHandle;
  windowMs?: number;
  now?: () => number;
  /** Where the probe's throwaway partial data goes. Destroyed afterwards. */
  probeDir?: string;
  /** Known duration in seconds, if any, to derive the required bitrate. */
  durationSec?: number | null;
  /** Injected size hint (bytes) when metadata is unavailable. */
  sizeBytes?: number | null;
}

/** Resolve the info-hash of a magnet-or-hash input, or null. */
export function probeInfoHash(input: {
  magnet?: string | null;
  infoHash?: string | null;
}): string | null {
  const direct = normalizeInfoHash(input.infoHash ?? null);
  if (direct) return direct;
  return infoHashFromMagnet(input.magnet ?? null);
}

/** Build the measurement of a live download without touching it. */
function measureLiveDownload(
  hash: string,
  live: ProbeTorrentHandle,
  requiredBps: number,
  now: number,
): SwarmMeasurement {
  const peersConnected = Math.max(0, Number(live.numPeers ?? 0));
  const wires = Array.isArray(live.wires) ? live.wires : [];
  const peersUnchoked = wires.filter((w) => Number(w?.downloaded ?? 0) > 0).length;
  const bytesReceived = Math.max(0, Number(live.downloaded ?? live.received ?? 0));
  // A live download has no "probe window"; its instantaneous downloadSpeed is
  // the honest throughput reading. elapsedMs stays 0 to say "not a timed probe".
  const effectiveBps = Math.max(0, Number(live.downloadSpeed ?? 0));
  return {
    infoHash: hash,
    peersConnected,
    peersUnchoked,
    bytesReceived,
    elapsedMs: 0,
    effectiveBps,
    requiredBps,
    verdict: classifySwarm({
      reachedSwarm: true,
      peersConnected,
      bytesReceived,
      effectiveBps,
      requiredBps,
    }),
    measuredAt: now,
    fromLiveDownload: true,
  };
}

/** A measurement that says "we could not find out." */
function unknownMeasurement(
  hash: string,
  requiredBps: number,
  now: number,
  elapsedMs = 0,
): SwarmMeasurement {
  return {
    infoHash: hash,
    peersConnected: 0,
    peersUnchoked: 0,
    bytesReceived: 0,
    elapsedMs,
    effectiveBps: 0,
    requiredBps,
    verdict: "unknown",
    measuredAt: now,
    fromLiveDownload: false,
  };
}

/**
 * Attach briefly to a swarm and measure what it actually delivers.
 *
 * Bounded and self-cleaning: a hard {@link PROBE_WINDOW_MS} cap, and everything
 * it created — the torrent, its listeners, the timer — is torn down before it
 * returns. This engine has had file-descriptor leaks before; the teardown here
 * follows the same `settled`-flag discipline `builtin-engine.ts` uses in
 * `rehydrateFromDb`.
 *
 * If the info-hash is already a live real download, its figures are returned
 * and **nothing is added or destroyed** — probing a user's torrent and then
 * destroying it would delete their download.
 */
export async function probeSwarm(
  input: { magnet?: string | null; infoHash?: string | null },
  deps: ProbeDeps = {},
): Promise<SwarmMeasurement> {
  const now = deps.now ?? (() => Date.now());
  const windowMs = deps.windowMs ?? PROBE_WINDOW_MS;
  const requiredBps = requiredBitrateBps({
    sizeBytes: deps.sizeBytes ?? null,
    durationSec: deps.durationSec ?? null,
  });

  const hash = probeInfoHash(input);
  // No metadata to key on — we cannot find out anything. Not `dead`: `unknown`.
  if (!hash) return unknownMeasurement("", requiredBps, now());

  // ── Guard: never probe (and therefore never destroy) a live download ──
  //
  // This guard is the one place in the module where a wrong answer costs data,
  // not just a bad verdict: a fresh probe ends in `destroy({ destroyStore })`,
  // and `builtin-engine.ts` (~line 1067) documents that re-adding the same
  // magnet with a different savePath silently *reuses the first torrent's
  // path*. So if we mistake a live download for "not present", our add returns
  // a handle to the user's real download still pointed at their directory, and
  // teardown deletes their file. Therefore the guard fails **closed**:
  //   - `live`    → read the live figures, add/destroy nothing.
  //   - `unknown` → we could not determine liveness; refuse to probe and return
  //                 `unknown`. That is the honest answer and costs nothing,
  //                 because `unknown` is already neutral in the ranking tiers.
  //   - `absent`  → and only then may a fresh probe run.
  const live = await resolveLive(deps, hash);
  if (live.kind === "live") {
    return measureLiveDownload(hash, live.torrent, requiredBps, now());
  }
  if (live.kind === "unknown") {
    // Could-not-determine is not "there is nothing there". Same `unknown` is
    // not `dead` discipline as the verdict rule — here the stake is the user's
    // files, so it matters even more.
    return unknownMeasurement(hash, requiredBps, now());
  }

  // ── A fresh probe ─────────────────────────────────────────────────────
  const magnetInput = input.magnet?.trim() || `magnet:?xt=urn:btih:${hash}`;

  let client: ProbeClient;
  let add: (c: ProbeClient, i: string, d: string) => ProbeTorrentHandle;
  try {
    if (deps.getClient && deps.addTorrent) {
      client = await deps.getClient();
      add = deps.addTorrent;
    } else {
      // Lazy import so pure/unit callers that inject fakes never load the
      // native engine. `addTorrentWithEngineDefaults` is the one add path that
      // inherits the private-swarm tracker rule; the probe must not bypass it.
      const engine = await import("@/lib/clients/builtin-engine");
      client = deps.getClient
        ? await deps.getClient()
        : ((await engine.getBuiltinClientForProbe()) as unknown as ProbeClient);
      add =
        deps.addTorrent ??
        ((c, i, d) =>
          engine.addTorrentWithEngineDefaults(
            c as unknown as Parameters<
              typeof engine.addTorrentWithEngineDefaults
            >[0],
            i,
            d,
          ) as unknown as ProbeTorrentHandle);
    }
  } catch {
    // Could not even get a client — we know nothing.
    return unknownMeasurement(hash, requiredBps, now());
  }

  const dest = deps.probeDir ?? defaultProbeDir();

  return await runFreshProbe({
    hash,
    magnetInput,
    dest,
    client,
    add,
    windowMs,
    now,
    requiredBps,
    sizeHint: deps.sizeBytes ?? null,
    durationSec: deps.durationSec ?? null,
  });
}

/**
 * The result of the liveness check, as a three-way discriminated union so a
 * *failure to determine* can never be silently read as *determined absent*.
 * See the guard in {@link probeSwarm} for why that distinction is load-bearing.
 */
type LiveResolution =
  | { kind: "live"; torrent: ProbeTorrentHandle }
  | { kind: "absent" }
  | { kind: "unknown" };

async function resolveLive(
  deps: ProbeDeps,
  hash: string,
): Promise<LiveResolution> {
  // `hash` is already normalised (`probeInfoHash` → `normalizeInfoHash`), and
  // `findLiveBuiltinTorrent` normalises again internally, so the value handed to
  // the engine is in the exact lowercase-hex form WebTorrent keys on. A case or
  // format mismatch would make a live torrent look absent — the same failure
  // with the same consequence as failing open — so it is guarded on both sides.
  try {
    if (deps.findLive) {
      const t = deps.findLive(hash);
      return t ? { kind: "live", torrent: t } : { kind: "absent" };
    }
    const engine = await import("@/lib/clients/builtin-engine");
    const t = engine.findLiveBuiltinTorrent(hash) as ProbeTorrentHandle | null;
    return t ? { kind: "live", torrent: t } : { kind: "absent" };
  } catch {
    // Could not run the check at all (import failed, engine threw). We do NOT
    // know there is no live download — say so, and the caller refuses to probe.
    return { kind: "unknown" };
  }
}

function defaultProbeDir(): string {
  // A throwaway directory; the probe's partial data is deleted on teardown.
  // Kept out of the user's download tree so a probe can never be mistaken for
  // a real download or collide with one on disk.
  return path.join(os.tmpdir(), "tf-swarm-probe");
}

interface FreshProbeArgs {
  hash: string;
  magnetInput: string;
  dest: string;
  client: ProbeClient;
  add: (c: ProbeClient, i: string, d: string) => ProbeTorrentHandle;
  windowMs: number;
  now: () => number;
  requiredBps: number;
  sizeHint: number | null;
  durationSec: number | null;
}

function runFreshProbe(args: FreshProbeArgs): Promise<SwarmMeasurement> {
  const startedAt = args.now();
  return new Promise<SwarmMeasurement>((resolve) => {
    let settled = false;
    let bytesReceived = 0;
    const senders = new Set<object>();
    const connectedWires = new Set<object>();

    let torrent: ProbeTorrentHandle | null = null;
    // A destructive `destroyStore: true` must fire only on a handle the probe
    // itself created — never inferred from `torrent != null`, but asserted from
    // a flag set at the exact point of a successful add. This is belt-and-braces
    // behind the fail-closed liveness guard: even if some future change let a
    // non-probe handle reach here, teardown would refuse to delete its store.
    let createdByProbe = false;

    const onDownload = (bytes: unknown) => {
      const n = Number(bytes);
      if (Number.isFinite(n) && n > 0) bytesReceived += n;
    };
    const onWire = (wire: unknown) => {
      if (wire && typeof wire === "object") {
        connectedWires.add(wire as object);
        const w = wire as {
          on?: (ev: string, fn: () => void) => void;
        };
        // A peer only "counts" once it actually sends a byte. A peer that
        // connects and chokes us forever is worth nothing.
        try {
          w.on?.("download", () => senders.add(wire as object));
        } catch {
          /* best effort */
        }
      }
    };
    const onError = () => finish(true);

    const finish = (reachedSwarm: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const elapsedMs = Math.max(0, args.now() - startedAt);
      const t = torrent;

      // Prefer the accumulated content bytes; fall back to the torrent's own
      // counters, which exist on a real WebTorrent handle.
      const measuredBytes =
        bytesReceived > 0
          ? bytesReceived
          : Math.max(0, Number(t?.downloaded ?? t?.received ?? 0));
      const numPeers = Math.max(
        connectedWires.size,
        Math.max(0, Number(t?.numPeers ?? 0)),
      );
      const peersUnchoked = Math.max(
        senders.size,
        countByteSenders(t?.wires),
      );
      const effectiveBps = elapsedMs > 0 ? (measuredBytes * 1000) / elapsedMs : 0;

      // Metadata (a length) or any wire is proof we reached the swarm.
      const reached =
        reachedSwarm && (numPeers > 0 || Number(t?.length ?? 0) > 0);

      const measurement: SwarmMeasurement = {
        infoHash: args.hash,
        peersConnected: numPeers,
        peersUnchoked,
        bytesReceived: measuredBytes,
        elapsedMs,
        effectiveBps,
        requiredBps: args.requiredBps,
        verdict: classifySwarm({
          reachedSwarm: reached,
          peersConnected: numPeers,
          bytesReceived: measuredBytes,
          effectiveBps,
          requiredBps: args.requiredBps,
        }),
        measuredAt: args.now(),
        fromLiveDownload: false,
      };

      // ── Teardown: listeners, then destroy the torrent and its partial data.
      try {
        t?.removeListener?.("download", onDownload);
        t?.removeListener?.("wire", onWire as (...a: unknown[]) => void);
        t?.removeListener?.("error", onError);
      } catch {
        /* best effort */
      }
      if (t && createdByProbe) {
        try {
          // destroyStore: true deletes the probe's throwaway partial data. Only
          // ever reached for a handle this probe created (see `createdByProbe`).
          t.destroy({ destroyStore: true }, () => {});
        } catch {
          /* best effort — the promise has already resolved */
        }
      }

      resolve(measurement);
    };

    const timer = setTimeout(() => finish(true), args.windowMs);
    // Never let a probe's timer hold the process open.
    (timer as { unref?: () => void }).unref?.();

    try {
      torrent = args.add(args.client, args.magnetInput, args.dest);
      // The add returned a handle: this torrent is ours, so its store may be
      // destroyed on teardown. Set before wiring listeners so any synchronous
      // event cannot observe an unset flag.
      createdByProbe = true;
      torrent.on?.("download", onDownload);
      torrent.on?.("wire", onWire as (...a: unknown[]) => void);
      torrent.on?.("error", onError);
    } catch {
      // Add threw synchronously — nothing was created to tear down.
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve(
          unknownMeasurement(args.hash, args.requiredBps, args.now(), 0),
        );
      }
    }
  });
}

function countByteSenders(
  wires: ProbeTorrentHandle["wires"] | undefined,
): number {
  if (!Array.isArray(wires)) return 0;
  return wires.filter((w) => Number(w?.downloaded ?? 0) > 0).length;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

type Db = typeof prisma;

/** A stored measurement, with the verdict already expiry-corrected. */
export interface StoredSwarmMeasurement {
  infoHash: string;
  peersConnected: number;
  peersUnchoked: number;
  bytesReceived: number;
  elapsedMs: number;
  effectiveBps: number;
  requiredBps: number;
  /** Expiry-corrected: an expired row reports `unknown`, never its old verdict. */
  verdict: SwarmVerdict;
  measuredAt: Date;
  expiresAt: Date;
  expired: boolean;
}

function isVerdict(v: string): v is SwarmVerdict {
  return v === "good" || v === "weak" || v === "dead" || v === "unknown";
}

/**
 * Persist a measurement, keyed by info-hash.
 *
 * A `fromLiveDownload` reading is not stored: a live download's figures are a
 * momentary snapshot of a torrent the user already has, not a probe of a
 * candidate we are deciding about, and caching it would let a busy download's
 * numbers stand in for a swarm's health long after playback stops.
 */
export async function recordSwarmMeasurement(
  m: SwarmMeasurement,
  opts: { db?: Db; ttlMs?: number; now?: number } = {},
): Promise<void> {
  if (m.fromLiveDownload) return;
  const hash = normalizeInfoHash(m.infoHash);
  if (!hash) return;
  const db = opts.db ?? prisma;
  const now = opts.now ?? Date.now();
  const ttl = opts.ttlMs ?? SWARM_MEASUREMENT_TTL_MS;
  const expiresAt = new Date(now + ttl);
  const data = {
    peersConnected: Math.max(0, Math.floor(m.peersConnected)),
    peersUnchoked: Math.max(0, Math.floor(m.peersUnchoked)),
    bytesReceived: BigInt(Math.max(0, Math.floor(m.bytesReceived))),
    elapsedMs: Math.max(0, Math.floor(m.elapsedMs)),
    effectiveBps: Number.isFinite(m.effectiveBps) ? m.effectiveBps : 0,
    requiredBps: Number.isFinite(m.requiredBps) ? m.requiredBps : 0,
    verdict: m.verdict,
    measuredAt: new Date(m.measuredAt),
    expiresAt,
  };
  try {
    await db.swarmMeasurement.upsert({
      where: { infoHash: hash },
      create: { infoHash: hash, ...data },
      update: data,
    });
  } catch (err) {
    console.warn(
      "[swarm-probe] could not store measurement:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Read a stored measurement. The verdict is expiry-corrected: an expired row
 * reports `unknown`, never its last verdict. Returns null when nothing is
 * stored for the hash.
 */
export async function getSwarmMeasurement(
  infoHash: string,
  opts: { db?: Db; now?: number } = {},
): Promise<StoredSwarmMeasurement | null> {
  const hash = normalizeInfoHash(infoHash);
  if (!hash) return null;
  const db = opts.db ?? prisma;
  const now = opts.now ?? Date.now();
  try {
    const row = await db.swarmMeasurement.findUnique({
      where: { infoHash: hash },
    });
    if (!row) return null;
    return toStored(row, now);
  } catch {
    return null;
  }
}

/**
 * The trusted verdict for a hash: `unknown` when nothing is stored or the row
 * has expired. This is the function selection consults.
 */
export async function getSwarmVerdict(
  infoHash: string,
  opts: { db?: Db; now?: number } = {},
): Promise<SwarmVerdict> {
  const stored = await getSwarmMeasurement(infoHash, opts);
  return stored ? stored.verdict : "unknown";
}

/**
 * Batch verdict lookup for a pool of hashes. Every hash not stored (or expired)
 * maps to `unknown`, so a caller can treat the whole pool uniformly.
 */
export async function loadSwarmVerdicts(
  infoHashes: readonly (string | null | undefined)[],
  opts: { db?: Db; now?: number } = {},
): Promise<Map<string, SwarmVerdict>> {
  const out = new Map<string, SwarmVerdict>();
  const hashes = new Set<string>();
  for (const raw of infoHashes) {
    const h = normalizeInfoHash(raw ?? null);
    if (h) hashes.add(h);
  }
  if (hashes.size === 0) return out;
  const db = opts.db ?? prisma;
  const now = opts.now ?? Date.now();
  try {
    const rows = await db.swarmMeasurement.findMany({
      where: { infoHash: { in: [...hashes] } },
    });
    for (const row of rows) {
      out.set(row.infoHash, toStored(row, now).verdict);
    }
  } catch {
    // A missing measurement is `unknown`, which is the map's default. Callers
    // read a missing key as `unknown` too, so an empty map is a safe answer.
  }
  return out;
}

interface SwarmRow {
  infoHash: string;
  peersConnected: number;
  peersUnchoked: number;
  bytesReceived: bigint;
  elapsedMs: number;
  effectiveBps: number;
  requiredBps: number;
  verdict: string;
  measuredAt: Date;
  expiresAt: Date;
}

function toStored(row: SwarmRow, now: number): StoredSwarmMeasurement {
  const expired = row.expiresAt.getTime() <= now;
  const stored = isVerdict(row.verdict) ? row.verdict : "unknown";
  return {
    infoHash: row.infoHash,
    peersConnected: row.peersConnected,
    peersUnchoked: row.peersUnchoked,
    bytesReceived: Number(row.bytesReceived),
    elapsedMs: row.elapsedMs,
    effectiveBps: row.effectiveBps,
    requiredBps: row.requiredBps,
    // The load-bearing line: an expired verdict is not trusted. It reads as
    // `unknown` so a swarm that has since revived gets a fresh chance, rather
    // than being pinned to a stale `dead`.
    verdict: expired ? "unknown" : stored,
    measuredAt: row.measuredAt,
    expiresAt: row.expiresAt,
    expired,
  };
}

/**
 * Probe a candidate and store the result. Convenience for the speculative path.
 * Never throws — a probe is best-effort and must not take a caller down.
 */
export async function probeAndRecord(
  input: { magnet?: string | null; infoHash?: string | null },
  deps: ProbeDeps & { db?: Db; ttlMs?: number } = {},
): Promise<SwarmMeasurement | null> {
  try {
    const measurement = await probeSwarm(input, deps);
    await recordSwarmMeasurement(measurement, {
      db: deps.db,
      ttlMs: deps.ttlMs,
    });
    return measurement;
  } catch (err) {
    console.warn(
      "[swarm-probe] probe failed:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}
