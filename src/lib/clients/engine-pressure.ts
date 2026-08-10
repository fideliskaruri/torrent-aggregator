/**
 * A read-only pressure snapshot of the built-in torrent engine.
 *
 * The engine's slow degradation over a long session (BUG-011) is currently
 * diagnosed by guessing: there is no single place that answers "how many live
 * torrents are attached right now, how many wires are open across them, how
 * many are parked, how many are pinned open by a stream lease". This module is
 * that place.
 *
 * Three hard rules, because this runs on a diagnostics path against a live
 * swarm:
 *
 *   1. **Pure.** {@link enginePressureSnapshot} takes state in and returns a
 *      plain object. It never touches `globalThis`, never imports the engine,
 *      and is trivially testable with fixtures.
 *   2. **Never mutates.** No `select`/`deselect`, no `destroy`, no writes to
 *      the engine state maps. Reading a torrent must not change what it does.
 *      In particular this module does not know about — and must never learn
 *      about — `maxConns`, VOD budgets, detach/park decisions, stream-lease
 *      acquisition or `destroyStore`.
 *   3. **Defensive.** Every field is read through a try/catch with a fallback,
 *      because a half-destroyed WebTorrent object throws from its own getters.
 *      A diagnostics read must never be able to crash the server.
 */

/** Progress at/above which a torrent claims to hold everything. */
export const COMPLETE_PROGRESS = 0.9999;

/** The minimum of a live torrent this module is willing to look at. */
export interface PressureTorrentLike {
  infoHash?: string;
  name?: string;
  progress?: number;
  done?: boolean;
  paused?: boolean;
  ready?: boolean;
  numPeers?: number;
  downloadSpeed?: number;
  uploadSpeed?: number;
  pieces?: Array<unknown>;
  bitfield?: { get?: (index: number) => boolean };
  wires?: Array<{ destroyed?: boolean }>;
}

/** Engine state injected by the caller; all parts optional and defensive. */
export interface EnginePressureInput {
  torrents?: Array<PressureTorrentLike> | null;
  /** infoHash -> active engine-backed HTTP responses. */
  streamLeases?: Map<string, number> | null;
  /** `userId:hash` -> in-flight completion/park transition. */
  parking?: Map<string, unknown> | null;
  /** `userId:hash` -> pending detach retry timer. */
  parkingRetryTimers?: Map<string, unknown> | null;
  /** Whether the engine client is currently instantiated at all. */
  clientPresent?: boolean;
}

export type PieceVerification = "verified" | "incomplete" | "unknown";

export interface TorrentPressure {
  infoHash: string;
  name: string;
  progress: number;
  done: boolean;
  paused: boolean;
  ready: boolean;
  peers: number;
  wires: number;
  downloadSpeed: number;
  uploadSpeed: number;
  pieces: number;
  /**
   * `unknown` when the bitfield is not readable (pre-metadata, or a torrent
   * being torn down) — deliberately distinct from `incomplete`, so a missing
   * bitfield can never be mistaken for proof of missing data.
   */
  pieceVerification: PieceVerification;
  /** Claims complete progress while the bitfield says pieces are missing. */
  completionMismatch: boolean;
  streamLeases: number;
  parking: boolean;
  parkRetryPending: boolean;
}

export interface EnginePressureSnapshot {
  clientPresent: boolean;
  totals: {
    torrents: number;
    active: number;
    paused: number;
    complete: number;
    peers: number;
    wires: number;
    downloadSpeed: number;
    uploadSpeed: number;
    streamLeases: number;
    leasedTorrents: number;
    parking: number;
    parkRetryPending: number;
    completionMismatch: number;
    verificationUnknown: number;
  };
  torrents: TorrentPressure[];
}

/** Keep aggregate health while removing cross-user release identities. */
export function redactEnginePressureDetails(
  snapshot: EnginePressureSnapshot,
): EnginePressureSnapshot {
  return {
    ...snapshot,
    totals: { ...snapshot.totals },
    torrents: [],
  };
}

function read<T>(get: () => T | undefined | null, fallback: T): T {
  try {
    const value = get();
    if (value == null) return fallback;
    if (typeof value === "number" && !Number.isFinite(value)) return fallback;
    return value as T;
  } catch {
    return fallback;
  }
}

function nonNegative(value: number): number {
  return value > 0 ? value : 0;
}

/**
 * Classify a torrent's bitfield.
 *
 * Mirrors `everyPieceVerified` in builtin-engine.ts (a torrent-level `done`
 * flag latches at its optimistic high-water mark and never re-evaluates), but
 * adds an explicit `unknown` for the case where there is no bitfield to read
 * yet, which the boolean version has to collapse into "not verified".
 */
export function classifyPieceVerification(
  torrent: PressureTorrentLike,
): PieceVerification {
  const pieces = read(() => torrent.pieces, undefined);
  const get = read(() => torrent.bitfield?.get, undefined);
  if (!Array.isArray(pieces) || pieces.length === 0) return "unknown";
  if (typeof get !== "function") return "unknown";
  for (let index = 0; index < pieces.length; index += 1) {
    let held = false;
    try {
      held = get.call(torrent.bitfield, index) === true;
    } catch {
      return "unknown";
    }
    if (!held) return "incomplete";
  }
  return "verified";
}

function countLiveWires(torrent: PressureTorrentLike): number {
  const wires = read(() => torrent.wires, undefined);
  if (!Array.isArray(wires)) return 0;
  let live = 0;
  for (const wire of wires) {
    if (read(() => wire?.destroyed, false) !== true) live += 1;
  }
  return live;
}

/** Keys in the engine's park maps are `userId:hash`; match on the hash tail. */
function anyKeyForHash(
  map: Map<string, unknown> | null | undefined,
  hash: string,
): boolean {
  if (!map || !hash) return false;
  try {
    for (const key of map.keys()) {
      if (key === hash || key.endsWith(`:${hash}`)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

/** Pure, allocation-only pressure snapshot. Never mutates its input. */
export function enginePressureSnapshot(
  input: EnginePressureInput | null | undefined,
): EnginePressureSnapshot {
  const source = input ?? {};
  const list = Array.isArray(source.torrents) ? source.torrents : [];
  const leases = source.streamLeases ?? null;

  const torrents: TorrentPressure[] = [];
  const totals = {
    torrents: 0,
    active: 0,
    paused: 0,
    complete: 0,
    peers: 0,
    wires: 0,
    downloadSpeed: 0,
    uploadSpeed: 0,
    streamLeases: 0,
    leasedTorrents: 0,
    parking: 0,
    parkRetryPending: 0,
    completionMismatch: 0,
    verificationUnknown: 0,
  };

  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const infoHash = read(() => raw.infoHash, "").toLowerCase();
    const progress = Math.min(1, nonNegative(read(() => raw.progress, 0)));
    const paused = read(() => raw.paused, false) === true;
    const pieceVerification = classifyPieceVerification(raw);
    const wires = countLiveWires(raw);
    const peers = Math.round(nonNegative(read(() => raw.numPeers, 0)));
    const downloadSpeed = nonNegative(read(() => raw.downloadSpeed, 0));
    const uploadSpeed = nonNegative(read(() => raw.uploadSpeed, 0));
    const leaseCount = infoHash
      ? Math.round(nonNegative(read(() => leases?.get(infoHash) ?? 0, 0)))
      : 0;
    const parking = anyKeyForHash(source.parking, infoHash);
    const parkRetryPending = anyKeyForHash(source.parkingRetryTimers, infoHash);
    const atCompleteProgress = progress >= COMPLETE_PROGRESS;
    const completionMismatch =
      atCompleteProgress && pieceVerification === "incomplete";

    torrents.push({
      infoHash,
      name: read(() => raw.name, ""),
      progress,
      done: read(() => raw.done, false) === true,
      paused,
      ready: read(() => raw.ready, false) === true,
      peers,
      wires,
      downloadSpeed,
      uploadSpeed,
      pieces: read(() => raw.pieces?.length, 0),
      pieceVerification,
      completionMismatch,
      streamLeases: leaseCount,
      parking,
      parkRetryPending,
    });

    totals.torrents += 1;
    if (paused) totals.paused += 1;
    else totals.active += 1;
    if (atCompleteProgress && pieceVerification === "verified")
      totals.complete += 1;
    totals.peers += peers;
    totals.wires += wires;
    totals.downloadSpeed += downloadSpeed;
    totals.uploadSpeed += uploadSpeed;
    totals.streamLeases += leaseCount;
    if (leaseCount > 0) totals.leasedTorrents += 1;
    if (parking) totals.parking += 1;
    if (parkRetryPending) totals.parkRetryPending += 1;
    if (completionMismatch) totals.completionMismatch += 1;
    if (pieceVerification === "unknown") totals.verificationUnknown += 1;
  }

  return {
    clientPresent: source.clientPresent === true,
    totals,
    torrents,
  };
}

/**
 * Read the live engine singleton without importing the engine module.
 *
 * The diagnostics route must not drag `builtin-engine.ts` (and WebTorrent, and
 * Prisma writes, and every lifecycle side effect it arms on import) into its
 * bundle just to count torrents. The engine already parks its state on
 * `globalThis.__tfBuiltinEngine`; if that is absent the engine has simply never
 * been started in this process, which is itself the honest answer.
 */
export function liveEnginePressure(): EnginePressureSnapshot {
  try {
    const g = globalThis as unknown as {
      __tfBuiltinEngine?: {
        client?: { torrents?: Array<PressureTorrentLike> } | null;
        streamLeases?: Map<string, number>;
        parking?: Map<string, unknown>;
        parkingRetryTimers?: Map<string, unknown>;
      };
    };
    const state = g.__tfBuiltinEngine;
    if (!state) return enginePressureSnapshot(null);
    return enginePressureSnapshot({
      torrents: state.client?.torrents ?? [],
      streamLeases: state.streamLeases ?? null,
      parking: state.parking ?? null,
      parkingRetryTimers: state.parkingRetryTimers ?? null,
      clientPresent: Boolean(state.client),
    });
  } catch {
    return enginePressureSnapshot(null);
  }
}

/**
 * One-time-per-hash notice that a torrent claims complete progress while its
 * bitfield still has holes.
 *
 * Purely observational — the engine's own `isComplete` already refuses to call
 * such a torrent complete, and nothing here changes that decision. The point is
 * that the disagreement was previously invisible: the torrent silently sat in
 * `stalledDL`/`downloading` at "100%" with no record of why. A bounded
 * once-per-recent-hash memo keeps a torrent polled every 5s from flooding the
 * log without retaining every historical hash forever.
 */
const MISMATCH_KEY = Symbol.for("torrentflow.engine.completionMismatch");
export const COMPLETION_MISMATCH_NOTICE_LIMIT = 512;

function mismatchSeen(): Set<string> {
  const g = globalThis as unknown as Record<symbol, Set<string> | undefined>;
  if (!g[MISMATCH_KEY]) g[MISMATCH_KEY] = new Set<string>();
  return g[MISMATCH_KEY]!;
}

/**
 * Records the gap and returns true the first time it is seen for a hash.
 *
 * @param log injected for tests; defaults to `console.warn`.
 */
export function noteCompletionVerificationGap(
  infoHash: string | undefined,
  atCompleteProgress: boolean,
  verified: boolean,
  log: (message: string) => void = (message) => console.warn(message),
): boolean {
  if (!atCompleteProgress || verified) return false;
  const hash = (infoHash ?? "").toLowerCase();
  if (!hash) return false;
  const seen = mismatchSeen();
  if (seen.has(hash)) return false;
  while (seen.size >= COMPLETION_MISMATCH_NOTICE_LIMIT) {
    const oldest = seen.values().next().value;
    if (typeof oldest !== "string") break;
    seen.delete(oldest);
  }
  seen.add(hash);
  try {
    log(
      `[engine] ${hash} reports complete progress but not every piece is verified; treating as incomplete`,
    );
  } catch {
    // Diagnostics must never break the read path.
  }
  return true;
}

/** Test-only reset of the once-per-hash memo. */
export function resetCompletionVerificationNotices(): void {
  mismatchSeen().clear();
}

/** Recent hashes that have reported a completion/verification gap. */
export function completionVerificationGapHashes(): string[] {
  return [...mismatchSeen()].sort();
}
