/**
 * Honest stall detection for a live download.
 *
 * WHY THIS EXISTS
 * ---------------
 * A user pressed play and got a spinner that never resolved. The swarm was
 * `downloading` with **six peers connected**, yet `progress` never moved off
 * 0.7706% across 40 seconds of polling. The indexer had advertised 28 seeders;
 * that claim did not survive contact with the swarm. Nothing in the app noticed
 * — the health signal in the UI is `peers > 0`, which was green the whole time.
 *
 * So the rule here is deliberately built on **delivered bytes over a time
 * window**, never on peer count. Peer count is exactly the signal that lied:
 * peers can connect, complete a handshake, and deliver nothing (choked, seeders
 * that are actually leeches, dead web-seeds). Bytes on disk cannot lie.
 *
 * MEASUREMENT TRAP
 * ----------------
 * `src/lib/clients/webtorrent-piece-race.ts` substitutes the *previous* reading
 * for `downloaded` when its getter races a verifying piece, so an instantaneous
 * `downloadSpeed` can read stale or zero on a torrent that is actually moving.
 * This detector therefore compares the **absolute** `downloadedBytes` (or
 * `progress`) across two samples spaced a real interval apart, and never trusts
 * a point-in-time rate. Two independent readings of a monotonic counter cannot
 * both be stale in the same direction the way one derived rate can.
 *
 * The function is pure: a verdict over a series of samples, with no timers and
 * no engine handles, so the rule can be exhaustively table-tested.
 */

/** One reading of a torrent's transfer, taken by the poll loop. */
export interface TransferSample {
  /** Wall-clock time of the reading, ms since epoch. */
  atMs: number;
  /**
   * Absolute bytes delivered so far. Monotonic non-decreasing in a healthy
   * transfer. Prefer this over any rate. When only `progress` is known, pass
   * `progress * sizeBytes`.
   */
  downloadedBytes: number;
  /** Fraction complete, 0–1. Used only to recognise a finished download. */
  progress: number;
  /**
   * Engine state string (`torrentStatus` output: "downloading", "stalledDL",
   * "metaDL", "checkingDL", "paused", "uploading", "stalledUP", "error").
   * Peer count is deliberately **not** a field here — it must not influence the
   * verdict.
   */
  state: string;
}

/**
 * Minimum wall-clock span, in ms, a sample series must cover before a stall can
 * be declared.
 *
 * WHY 30s: a fresh swarm legitimately delivers nothing for its first seconds —
 * peer discovery, handshakes, bitfield exchange and the metadata/hash-check
 * phase all happen before the first block lands, and WebTorrent's sequential
 * strategy waits on the specific head pieces the player needs. Abandoning at
 * 10s would routinely kill swarms that were about to get going and waste the
 * bytes already fetched. But a swarm that has delivered essentially nothing for
 * a *continuous 30 seconds* while actively downloading is not warming up; it is
 * dead. This is also the point past which a viewer reads the spinner as broken.
 */
export const STALL_WINDOW_MS = 30_000;

/**
 * Bytes that must be delivered across {@link STALL_WINDOW_MS} for a transfer to
 * count as alive.
 *
 * WHY 256 KiB / 30s (~8.7 KB/s): below this a download is effectively frozen —
 * no video bitrate is servable at that rate, so it is indistinguishable from
 * zero for the user's purpose. Crucially, this floor is low enough that a
 * genuinely slow-but-viable swarm is safe: 256 KiB is a fraction of a single
 * BitTorrent piece, so a swarm completing even one small piece per window
 * clears it, and a modest 100 KB/s download delivers ~3 MB per window — an
 * order of magnitude clear. The floor exists to catch *zero*, not to judge
 * slowness. Do not raise it to chase faster downloads: that is how you abandon
 * working ones (the regression that matters most).
 */
export const STALL_MIN_DELIVERED_BYTES = 256 * 1024;

/** A transfer is complete at/after this fraction; a complete file never stalls. */
const COMPLETE_PROGRESS = 0.9999;

/**
 * States in which a lack of delivered bytes actually means "stalled".
 *
 * Metadata fetch and hash-check ("metaDL"/"checkingDL") legitimately deliver no
 * *content* bytes, and "paused" is a user choice — none of those is a stall, so
 * we never abandon during them. Only an active download that is moving no bytes
 * is the failure this detector is for.
 */
const ACTIVE_DOWNLOAD_STATES = new Set(["downloading", "stalledDL"]);

export type StallReason =
  /** Not enough history yet: no baseline sample old enough to compare against. */
  | "insufficient-history"
  /** The transfer is finished; nothing to stall. */
  | "complete"
  /** Not in an active-download state (metadata, hash-check, paused, seeding). */
  | "not-downloading"
  /** Delivered bytes over the window cleared the floor — healthy or slow-but-alive. */
  | "progressing"
  /** Actively downloading but delivered less than the floor across the window. */
  | "stalled";

export interface StallVerdict {
  stalled: boolean;
  reason: StallReason;
  /** Bytes delivered across the evaluated window. `null` when undetermined. */
  deliveredBytes: number | null;
  /** Span in ms actually evaluated. `null` when undetermined. */
  windowMs: number | null;
}

export interface StallOptions {
  windowMs?: number;
  minDeliveredBytes?: number;
}

/**
 * Decide whether a series of transfer samples represents a stalled download.
 *
 * The verdict compares the newest sample against the newest sample that is at
 * least `windowMs` older — a baseline taken a real interval ago — and asks a
 * single question: did we get at least `minDeliveredBytes` of content in
 * between? Peer count never enters into it.
 *
 * Returns `stalled: false` with an honest `reason` in every non-stall case, so
 * callers can distinguish "still warming up" (`insufficient-history`) from
 * "alive" (`progressing`) from "done" (`complete`).
 */
export function evaluateStall(
  samples: readonly TransferSample[],
  options: StallOptions = {},
): StallVerdict {
  const windowMs = options.windowMs ?? STALL_WINDOW_MS;
  const minDeliveredBytes =
    options.minDeliveredBytes ?? STALL_MIN_DELIVERED_BYTES;

  if (samples.length < 2) {
    return { stalled: false, reason: "insufficient-history", deliveredBytes: null, windowMs: null };
  }

  // Samples may arrive unordered; sort a copy by time so the newest is last.
  const ordered = [...samples].sort((a, b) => a.atMs - b.atMs);
  const latest = ordered[ordered.length - 1];

  if (latest.progress >= COMPLETE_PROGRESS) {
    return { stalled: false, reason: "complete", deliveredBytes: null, windowMs: null };
  }

  if (!ACTIVE_DOWNLOAD_STATES.has(latest.state)) {
    return { stalled: false, reason: "not-downloading", deliveredBytes: null, windowMs: null };
  }

  // Baseline = the newest sample that is at least `windowMs` older than latest.
  // Using the newest such sample keeps the evaluated span as close to the
  // window as the data allows, rather than reaching back to ancient history.
  const cutoff = latest.atMs - windowMs;
  let baseline: TransferSample | null = null;
  for (let i = ordered.length - 2; i >= 0; i--) {
    if (ordered[i].atMs <= cutoff) {
      baseline = ordered[i];
      break;
    }
  }

  if (!baseline) {
    return { stalled: false, reason: "insufficient-history", deliveredBytes: null, windowMs: null };
  }

  const evaluatedWindow = latest.atMs - baseline.atMs;
  // Clamp negative deltas to 0: `downloaded` can dip by a piece for one tick
  // when the piece-race guard substitutes a prior reading (see module header).
  const deliveredBytes = Math.max(0, latest.downloadedBytes - baseline.downloadedBytes);

  if (deliveredBytes >= minDeliveredBytes) {
    return { stalled: false, reason: "progressing", deliveredBytes, windowMs: evaluatedWindow };
  }

  return { stalled: true, reason: "stalled", deliveredBytes, windowMs: evaluatedWindow };
}
