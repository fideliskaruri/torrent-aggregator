/**
 * Built-in BitTorrent engine (WebTorrent, Node).
 * No external qBittorrent/Transmission required.
 *
 * v1: in-process singleton (globalThis) for Next.js Node runtime.
 * Durable: EngineTorrent rows survive process restart; rehydrated on first use.
 * v2 (future): move to sidecar process — this adapter stays the port.
 */
import fs from "node:fs";
import path from "node:path";
import type { ClientTorrent } from "@/lib/torrents/types";
import type {
  AddTorrentPayload,
  AddTorrentResult,
  ClientConnectionConfig,
  TorrentClientAdapter,
} from "./types";
import { repairContentLayout } from "./content-layout-repair";
import { releasePaths } from "./layout-ownership";
import { pruneEmptyDescendants, pruneEmptyParents } from "./prune-empty-parents";
import {
  executeReleaseRemoval,
  planReleaseRemoval,
} from "./release-file-removal";
import { findTorrentByHash } from "./find-torrent-by-hash";
import { noteCompletionVerificationGap } from "./engine-pressure";
import {
  decideCompletionParkingAdmission,
  MAX_CONCURRENT_COMPLETION_PARKS,
  runCompletionSweep,
  clearCompletionSweepOwnerState,
  type CompletionSweepStats,
} from "./completion-sweep";
import {
  releaseFailedAllocation,
  snapshotAllocation,
  type AllocationTorrent,
} from "./add-allocation";
import {
  forgetTorrentMetadata,
  preferredAddInput,
  saveTorrentMetadata,
} from "./torrent-metadata-cache";
import { haltTransfer, resumeTransfer as resumeTransferCore } from "./transfer-control";
import prisma from "@/lib/prisma";
import { foregroundActive, foregroundHash, foregroundIdleMs } from "@/lib/prewarm/foreground";
import { USER_ORIGIN } from "@/lib/prewarm/types";
import {
  purposeFromOrigin,
  resolveEffectiveAdd,
  resumeSelectionForLookup,
  type AddSelection,
  type ExistingOriginLookup,
  type OriginValue,
} from "./add-purpose";
import {
  DOWNLOAD_COMPLETE_PROGRESS,
  persistedTorrentDisplayState,
  persistedTorrentHasInvalidMedia,
  persistedTorrentIsDownloaded,
  shouldRehydrateTorrent,
} from "./builtin-engine-lifecycle";
import { createSnapshotScheduler } from "./snapshot-scheduler";
import { finalizeCompletedDownload } from "./completion-finalizer";
import {
  isSupportedVideoFileName,
  validateTorrentMediaPayload,
} from "@/lib/torrents/filters";
import { probeFile } from "@/lib/media/probe";

export const INVALID_COMPLETED_MEDIA_MESSAGE =
  "The downloaded release did not contain playable video. TorrentFlow will choose another release.";

class InvalidCompletedMediaError extends Error {
  constructor() {
    super(INVALID_COMPLETED_MEDIA_MESSAGE);
    this.name = "InvalidCompletedMediaError";
  }
}

function hasSupportedVideoPayload(
  files: readonly { name?: string | null; path?: string | null }[],
): boolean {
  return files.some((file) =>
    isSupportedVideoFileName(String(file.path ?? file.name ?? "")),
  );
}

type WebTorrentLike = {
  torrents: Array<WtTorrent>;
  listening?: boolean;
  add: (
    uri: string | Uint8Array,
    opts?: BuiltinAddOptions,
    cb?: (t: WtTorrent) => void,
  ) => WtTorrent;
  throttleUpload?: (rate: number) => void | boolean;
  throttleDownload?: (rate: number) => void | boolean;
  /** WebTorrent 3+: async; prefer findTorrent (scans torrents) instead */
  get: (id: string) => WtTorrent | void | Promise<WtTorrent | null | void>;
  remove?: (
    id: string | WtTorrent,
    opts?: { destroyStore?: boolean } | ((err?: Error) => void),
    cb?: (err?: Error) => void,
  ) => void | Promise<void>;
  destroy: (cb?: (err?: Error) => void) => void;
  on: (ev: string, fn: (...args: unknown[]) => void) => void;
  once?: (ev: string, fn: (...args: unknown[]) => void) => void;
  removeListener?: (ev: string, fn: (...args: unknown[]) => void) => void;
};

type WtFile = {
  name: string;
  path: string;
  length: number;
  type?: string;
  offset?: number;
  _startPiece?: number;
  _endPiece?: number;
  select?: (priority?: number) => void;
  deselect?: () => void;
  stream: (opts?: { start?: number; end?: number }) => ReadableStream<Uint8Array>;
};

type WtTorrent = {
  infoHash: string;
  name: string;
  progress: number;
  length: number;
  /** Absolute bytes fetched so far. Monotonic; the honest stall signal. */
  downloaded?: number;
  downloadSpeed: number;
  uploadSpeed: number;
  done: boolean;
  paused: boolean;
  /** False until existing data has been hash-checked (`torrent.js:928`). */
  ready: boolean;
  numPeers: number;
  timeRemaining: number;
  path: string;
  magnetURI?: string;
  /** Bencoded info dictionary; available once `ready`. Cached for offline adds. */
  torrentFile?: Uint8Array;
  pieces?: Array<unknown>;
  bitfield?: { buffer?: Uint8Array; get?: (index: number) => boolean };
  files?: Array<WtFile>;
  select?: (start: number, end: number, priority?: number) => void;
  deselect?: (start: number, end: number) => void;
  _select?: (
    start: number,
    end: number,
    priority?: number,
    notify?: (() => void) | null,
    isStreamSelection?: boolean,
  ) => void;
  _deselect?: (start: number, end: number, isStreamSelection?: boolean) => void;
  critical?: (start: number, end: number) => void;
  pieceLength?: number;
  /** Live peer connections. Destroying these is the only way to stop transfer. */
  wires?: Array<{ destroyed?: boolean; destroy?: () => void }>;
  _peers?: Map<string, { destroyed?: boolean; destroy?: (err?: Error) => void }>;
  discovery?: {
    tracker?: { update?: () => void } | null;
    dht?: { lookup?: (infoHash: string) => void } | null;
  } | null;
  pause: () => void;
  resume: () => void;
  destroy: (opts?: { destroyStore?: boolean }, cb?: (err?: Error) => void) => void;
  on: (ev: string, fn: (...args: unknown[]) => void) => void;
  emit?: (ev: string, ...args: unknown[]) => boolean;
  listenerCount?: (ev: string) => number;
  removeListener?: (ev: string, fn: (...args: unknown[]) => void) => void;
};

/**
 * Options for the in-process WebTorrent client.
 *
 * **`utp: false` is the single most important setting here.** WebTorrent
 * defaults µTP on, and µTP is not an *addition* to TCP — it *replaces* it as
 * the first choice for every IPv4 peer:
 *
 *   lib/torrent.js:1065   const type = (this.client.utp && this._isIPv4(host)) ? 'utp' : 'tcp'
 *
 * When `utp-native` cannot establish a connection — routine on Windows and
 * behind NATs that drop unsolicited UDP — TCP is not tried until the peer has
 * exhausted its whole retry ladder (`lib/torrent.js:2145`):
 *
 *   attempt 1 → 5s connect timeout, wait 1s
 *   attempt 2 → 5s,                 wait 5s
 *   attempt 3 → 5s,                 wait 15s
 *   attempt 4 → 5s, only now is the peer re-added as 'tcp'
 *
 * That is ~41 seconds of dead air per peer before a single byte can flow, and
 * it repeats for every peer the tracker returns. The download is not broken,
 * just starved — which is exactly what "the builtin client is slow" looks like.
 *
 * Measured on one torrent, same swarm, same machine (scripts/probe-engine-speed.mts):
 *
 *   µTP on (default) → 0.00% after 40s
 *   µTP off          → 23.2% within 10s
 *
 * Disabling it also removes the source of the `UTP_ECONNRESET` throws that
 * `webtorrent-conn-errors.ts` exists to absorb.
 *
 * We do not pin `torrentPort`: measurement showed it made no difference, and a
 * fixed port collides with a qBittorrent install on the same machine.
 *
 * `maxConns` is deliberately bounded below WebTorrent's default. Re-measured after public
 * fallback trackers were restored, using Ubuntu 24.04.3
 * (d160b8d8ea35a5b4e52837468fc8f03d55cef1f7) with this probe:
 *
 *   metadata 5.7s; peak 32 peers / 32 wires in 60s; peak 14.9 MiB/s
 *
 * The measured swarm peaked at 32 peers, so 32 preserves the observed useful
 * ceiling while preventing each active torrent from inheriting a 55-socket
 * budget. Completed torrents are parked rather than seeded, so this budget is
 * reserved for work that is still downloading or serving a partial file.
 */
const BUILTIN_CLIENT_OPTIONS = { utp: false, maxConns: 32 } as const;

export const builtinClientOptions = BUILTIN_CLIENT_OPTIONS;

/**
 * Per-torrent add options.
 *
 * `strategy: 'sequential'` asks for pieces in file order instead of rarest-
 * first, so a partially downloaded file is playable from the start rather than
 * being a mesh of holes. This *is* WebTorrent's current default
 * (`torrent.js:143`), but a default is not a decision — it has flipped between
 * releases, and the whole point of this app is that you can start watching
 * before the download finishes. Stating it means an upstream change cannot
 * quietly take it away.
 *
 * The trade-off is real and accepted: sequential fetching is worse for the
 * swarm and slightly slower overall than rarest-first, because you cannot
 * prioritise the pieces that are hardest to get.
 */
type BuiltinAddOptions = {
  strategy: "sequential";
  announce: string[];
  path?: string;
  bitfield?: Uint8Array;
  storeCacheSlots: number;
  deselect?: boolean;
};

/** Public trackers that widen thin public swarms without replacing release trackers. */
export const PUBLIC_TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://exodus.desync.com:6969/announce",
  "udp://tracker.openbittorrent.com:6969/announce",
  "wss://tracker.openwebtorrent.com",
  "wss://tracker.webtorrent.dev",
] as const;

// WebTorrent's store cache is per torrent, not global. Applying the former
// 256-piece value to eleven torrents retained roughly 2.75 GiB on the measured
// workload. Twenty is WebTorrent's own disk-backed default: enough to absorb
// active sequential reads without turning every transfer into a RAM cache.
export const STREAMING_STORE_CACHE_SLOTS = 20;

const ADD_OPTIONS: BuiltinAddOptions = {
  strategy: "sequential",
  announce: [...PUBLIC_TRACKERS],
  storeCacheSlots: STREAMING_STORE_CACHE_SLOTS,
};

export const builtinAddOptions = ADD_OPTIONS;
export const PREWARM_PEER_CAP = 20;

function normalizeAnnounceUrl(value: string): string {
  try {
    const u = new URL(value.trim());
    const protocol = u.protocol.toLowerCase();
    const host = u.hostname.toLowerCase();
    const port = u.port ? `:${u.port}` : "";
    const path = (u.pathname || "").replace(/\/+$/, "");
    return `${protocol}//${host}${port}${path}`;
  } catch {
    return value.trim().toLowerCase().replace(/\/+$/, "");
  }
}

function uniqueTrackers(trackers: Iterable<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tracker of trackers) {
    const trimmed = tracker.trim();
    if (!trimmed) continue;
    const key = normalizeAnnounceUrl(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function trackerHost(value: string): string | null {
  try {
    return new URL(value.trim()).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = nums;
  return (
    a === 127 ||
    a === 10 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31)
  );
}

function isLocalAnnounce(tracker: string): boolean {
  const host = trackerHost(tracker);
  if (!host) return false;
  return host === "localhost" || host === "::1" || isPrivateIpv4(host);
}

function localOnlyAnnounce(trackers: readonly string[]): boolean {
  return trackers.length > 0 && trackers.every(isLocalAnnounce);
}

function fallbackTrackersMissingFromMagnet(uri: string): string[] {
  if (!uri.trim().startsWith("magnet:")) return [...PUBLIC_TRACKERS];
  try {
    const magnet = new URL(uri.trim());
    const trackers = magnet.searchParams.getAll("tr");
    if (localOnlyAnnounce(trackers)) return [];
    const seen = new Set<string>();
    for (const tr of trackers) {
      seen.add(normalizeAnnounceUrl(tr));
    }
    return PUBLIC_TRACKERS.filter((tr) => !seen.has(normalizeAnnounceUrl(tr)));
  } catch {
    return [...PUBLIC_TRACKERS];
  }
}

/**
 * Add public trackers without throwing away the release's own announce list.
 *
 * This is no longer the engine's primary add path — `client.add(...,
 * { announce })` covers magnets, .torrent buffers and info hashes alike. The
 * string helper remains exported because tests and small probes use it to check
 * the rule directly: a magnet with one dead tracker is still a thin swarm, so
 * "has any `tr=`" must never disable the public list.
 */
export function withPublicTrackers(uri: string): string {
  const u = uri.trim();
  if (!u.startsWith("magnet:")) return u;
  try {
    const magnet = new URL(u);
    const existing = magnet.searchParams.getAll("tr");
    const trackers = localOnlyAnnounce(existing)
      ? uniqueTrackers(existing)
      : uniqueTrackers([...existing, ...PUBLIC_TRACKERS]);
    magnet.searchParams.delete("tr");
    for (const tr of trackers) {
      magnet.searchParams.append("tr", tr);
    }
    return magnet.toString();
  } catch {
    let out = u;
    for (const tr of PUBLIC_TRACKERS) {
      out += `&tr=${encodeURIComponent(tr)}`;
    }
    return out;
  }
}

function addOptionsForInput(
  input: string | Uint8Array,
  dest: string,
  overrides: Partial<BuiltinAddOptions> = {},
): BuiltinAddOptions {
  const announce =
    typeof input === "string"
      ? fallbackTrackersMissingFromMagnet(input)
      : [...PUBLIC_TRACKERS];
  return { ...ADD_OPTIONS, ...overrides, announce: uniqueTrackers(announce), path: dest };
}

function enforcePrewarmPeerCap(torrent: WtTorrent, cap = PREWARM_PEER_CAP): void {
  if (!Number.isFinite(cap) || cap <= 0) return;
  const trim = () => {
    const wires = readProp(() => torrent.wires, []);
    if (Array.isArray(wires) && wires.length > cap) {
      for (const wire of wires.slice(cap)) {
        try {
          wire.destroy?.();
        } catch {
          /* best-effort */
        }
      }
    }
  };
  try {
    torrent.on("wire", trim);
  } catch {
    /* best-effort */
  }
  trim();
}

export function addTorrentWithEngineDefaults(
  client: Pick<WebTorrentLike, "add">,
  input: string | Uint8Array,
  dest: string,
  cb?: (t: WtTorrent) => void,
  opts: Partial<BuiltinAddOptions> = {},
): WtTorrent {
  return client.add(input, addOptionsForInput(input, dest, opts), cb);
}

export const FOREGROUND_UPLOAD_LIMIT_BPS = 64 * 1024;
const UNLIMITED_UPLOAD_LIMIT = -1;
const UPLOAD_THROTTLE_POLL_MS = 5_000;
const CLIENT_LISTENING_TIMEOUT_MS = 10_000;
const CLIENT_LISTENING_TIMEOUT_WARNING =
  "[builtin-engine] peer listener did not open within 10s; continuing anyway. " +
  "Torrent adds may briefly register one WebTorrent listening listener each until the peer server opens.";

let clientListeningTimeoutWarned = false;
let clientListeningWaitOverrideForTests:
  | { timeoutMs?: number; forceTimeout?: boolean }
  | null = null;

function applyForegroundUploadThrottle(
  client: Pick<WebTorrentLike, "throttleUpload" | "throttleDownload"> | null | undefined,
  active: boolean,
): void {
  if (typeof client?.throttleUpload !== "function") return;
  // WebTorrent 3.0.16 exposes `throttleUpload(rate)` and
  // `throttleDownload(rate)` methods, with `-1` meaning unlimited. We never
  // call the download side: playback is already sequential and file-prioritised,
  // and a download cap would punish the stream we are trying to protect.
  const rate = active ? FOREGROUND_UPLOAD_LIMIT_BPS : UNLIMITED_UPLOAD_LIMIT;
  if (rate === 0) return;
  try {
    client.throttleUpload(rate);
  } catch {
    /* best-effort; a missing throttle must not take the engine down */
  }
}

export function applyForegroundUploadThrottleForTests(
  client: Pick<WebTorrentLike, "throttleUpload" | "throttleDownload">,
  active: boolean,
): void {
  applyForegroundUploadThrottle(client, active);
}

function warnClientListeningTimeoutOnce(): void {
  if (clientListeningTimeoutWarned) return;
  clientListeningTimeoutWarned = true;
  console.warn(CLIENT_LISTENING_TIMEOUT_WARNING);
}

async function waitForClientListening(client: WebTorrentLike): Promise<void> {
  const override = clientListeningWaitOverrideForTests;
  if (!override?.forceTimeout && readProp(() => client.listening, false)) return;
  const subscribe = client.once ?? client.on;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (timedOut = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.removeListener?.("listening", onListening);
      if (timedOut) warnClientListeningTimeoutOnce();
      resolve();
    };
    const onListening = () => finish();
    const timer = setTimeout(
      () => finish(true),
      override?.timeoutMs ?? CLIENT_LISTENING_TIMEOUT_MS,
    );
    timer.unref?.();
    if (!override?.forceTimeout) {
      subscribe.call(client, "listening", onListening);
      if (readProp(() => client.listening, false)) finish();
    }
  });
}

export function configureBuiltinClientListeningWaitForTests(
  opts: { timeoutMs?: number; forceTimeout?: boolean } | null,
): void {
  clientListeningWaitOverrideForTests = opts;
  clientListeningTimeoutWarned = false;
}

export async function waitForClientListeningForTests(
  client: WebTorrentLike,
): Promise<void> {
  await waitForClientListening(client);
}

/** Select all files so every piece is wanted. Does NOT change pause state. */
function selectAllFiles(t: WtTorrent): void {
  try {
    if (Array.isArray(t.files)) {
      for (const f of t.files) {
        try {
          f.select?.();
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* best-effort */
  }
}

const SEEK_FILE_PRIORITY = 3;
const STREAM_HEAD_PRIORITY_BYTES = 2 * 1024 * 1024;
// While the head (or seek) window is still incomplete, the moov/tail prefetch
// must not claim equal peer bandwidth. Selecting it below the head priority
// keeps it wanted — so idle wires still fill it — without letting it race the
// very first bytes of playback.
const STREAM_TAIL_DEFERRED_PRIORITY = 1;

/**
 * Decide the tail's selection priority for a stream file.
 *
 * The head (or the seek target) must own the swarm until its window lands; only
 * then may the tail — the MP4/MKV moov/cues the player needs to keep going —
 * claim equal priority. Given whether that primary window is already complete,
 * a complete window promotes the tail to the head priority; an incomplete one
 * holds it at the deferred priority so it cannot starve the first frame.
 */
export function resolveStreamTailPriority(primaryWindowComplete: boolean): number {
  return primaryWindowComplete ? SEEK_FILE_PRIORITY : STREAM_TAIL_DEFERRED_PRIORITY;
}

type StreamPriorityOptions = {
  seekOffset?: number;
  prefetchEdges?: typeof prefetchBuiltinFileEdges;
  onPrefetchError?: (err: unknown) => void;
};

type StreamPriorityState = {
  key: string;
  headRange: { start: number; end: number } | null;
  tailRange: { start: number; end: number } | null;
  seekRange: { start: number; end: number } | null;
  tailDeferred: boolean;
};

let prioritizedStreamFiles = new WeakMap<object, StreamPriorityState>();
let prioritizedEdgePrefetches = new WeakMap<object, Set<string>>();

const MATROSKA_EXTENSIONS = new Set([".mkv", ".webm"]);

/** True for Matroska-family containers (MKV/WebM), which seek through Cues. */
export function isMatroskaContainer(pathOrName: string): boolean {
  const clean = (pathOrName || "").split(/[\\/]/).pop() ?? "";
  const dot = clean.lastIndexOf(".");
  const ext = dot >= 0 ? clean.slice(dot).toLowerCase() : "";
  return MATROSKA_EXTENSIONS.has(ext);
}

/**
 * Decide how a seek should treat a container's index regions.
 *
 * Matroska (MKV/WebM) resolves a seek through two index elements: the SeekHead
 * near the file head points at the Cues near the tail, and the Cues map each
 * timestamp onto a cluster byte offset. If either is missing when the browser
 * honours a seek, the demuxer estimates cluster positions and lands audio and
 * video on different clusters — the A/V desync a viewer sees after tapping the
 * arrow keys.
 *
 * A plain open already fetches the head window critically and prefetches the
 * tail, so the index is present by the time playback starts. A seek is the
 * dangerous case: the normal path drops the head window and leaves the tail
 * non-critical, so the seek-target cluster can arrive before the index. For
 * Matroska we therefore keep BOTH index regions selected and critical while a
 * seek is in flight; other containers keep the existing seek-only behaviour.
 */
export function seekIndexPlan(args: {
  isMatroska: boolean;
  seeking: boolean;
}): { holdHeadIndex: boolean; tailCritical: boolean } {
  const indexRequired = args.isMatroska && args.seeking;
  return { holdHeadIndex: indexRequired, tailCritical: indexRequired };
}

function fileSelectionKey(file: BuiltinStreamFile): string {
  return normalizeTorrentFilePath(file.path || file.name);
}

function finitePiece(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

function filePieceRange(file: BuiltinStreamFile): { start: number; end: number } | null {
  const start = finitePiece((file as WtFile)._startPiece);
  const end = finitePiece((file as WtFile)._endPiece);
  if (start == null || end == null || end < start) return null;
  return { start, end };
}

function seekPieceRange(
  torrent: BuiltinStreamTorrent,
  file: BuiltinStreamFile,
  seekOffset: number | undefined,
): { start: number; end: number } | null {
  if (seekOffset == null || !Number.isFinite(seekOffset) || seekOffset <= 0) return null;
  const pieceLength = readProp(() => (torrent as WtTorrent).pieceLength, 0);
  const fileOffset = readProp(() => (file as WtFile).offset, 0) ?? 0;
  if (!pieceLength || pieceLength <= 0) return null;
  const fileRange = filePieceRange(file);
  if (!fileRange) return null;
  const start = Math.min(
    fileRange.end,
    Math.max(fileRange.start, Math.floor((fileOffset + seekOffset) / pieceLength)),
  );
  const pieces = Math.max(0, Math.ceil(STREAM_HEAD_PRIORITY_BYTES / pieceLength) - 1);
  return { start, end: Math.min(fileRange.end, start + pieces) };
}

function headPieceRange(
  torrent: BuiltinStreamTorrent,
  file: BuiltinStreamFile,
): { start: number; end: number } | null {
  const fileRange = filePieceRange(file);
  if (!fileRange) return null;
  const pieceLength = readProp(() => (torrent as WtTorrent).pieceLength, 0);
  if (!pieceLength || pieceLength <= 0) return fileRange;
  const pieces = Math.max(0, Math.ceil(STREAM_HEAD_PRIORITY_BYTES / pieceLength) - 1);
  return { start: fileRange.start, end: Math.min(fileRange.end, fileRange.start + pieces) };
}

function tailPieceRange(
  torrent: BuiltinStreamTorrent,
  file: BuiltinStreamFile,
): { start: number; end: number } | null {
  const fileRange = filePieceRange(file);
  if (!fileRange) return null;
  const pieceLength = readProp(() => (torrent as WtTorrent).pieceLength, 0);
  if (!pieceLength || pieceLength <= 0) return null;
  const pieces = Math.max(0, Math.ceil(STREAM_HEAD_PRIORITY_BYTES / pieceLength) - 1);
  const filePieces = fileRange.end - fileRange.start + 1;
  if (filePieces <= pieces + 1) return null;
  return { start: Math.max(fileRange.start, fileRange.end - pieces), end: fileRange.end };
}

function samePieceRange(
  a: { start: number; end: number } | null,
  b: { start: number; end: number } | null,
): boolean {
  return a?.start === b?.start && a?.end === b?.end;
}

/**
 * True only when every piece in the range is already verified in the torrent's
 * bitfield. Used to decide whether the head/seek window has landed so the tail
 * may be promoted off its deferred priority.
 */
function isPieceRangeComplete(
  torrent: BuiltinStreamTorrent,
  range: { start: number; end: number } | null,
): boolean {
  if (!range) return false;
  const bitfield = readProp(() => (torrent as WtTorrent).bitfield, undefined);
  const get = bitfield?.get;
  if (typeof get !== "function") return false;
  try {
    for (let piece = range.start; piece <= range.end; piece += 1) {
      if (!get.call(bitfield, piece)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function torrentPieceRange(
  torrent: BuiltinStreamTorrent,
): { start: number; end: number } | null {
  const pieces = readProp(() => (torrent as WtTorrent).pieces, undefined);
  if (Array.isArray(pieces) && pieces.length > 0) {
    return { start: 0, end: pieces.length - 1 };
  }
  const files = readProp(() => torrent.files, undefined);
  if (!Array.isArray(files)) return null;
  let end = -1;
  for (const file of files) {
    const range = filePieceRange(file);
    if (range) end = Math.max(end, range.end);
  }
  return end >= 0 ? { start: 0, end } : null;
}

function selectPieceRange(
  torrent: BuiltinStreamTorrent,
  range: { start: number; end: number },
  priority: number,
): boolean {
  const t = torrent as WtTorrent;
  try {
    if (typeof t._select === "function") {
      t._select(range.start, range.end, priority, null, true);
      return true;
    }
    t.select?.(range.start, range.end, priority);
    return typeof t.select === "function";
  } catch {
    return false;
  }
}

function markCriticalPieceRange(
  torrent: BuiltinStreamTorrent,
  range: { start: number; end: number } | null,
): void {
  if (!range) return;
  try {
    (torrent as WtTorrent).critical?.(range.start, range.end);
  } catch {
    /* best-effort */
  }
}

function deselectStreamPieceRange(
  torrent: BuiltinStreamTorrent,
  range: { start: number; end: number } | null,
): void {
  if (!range) return;
  try {
    (torrent as WtTorrent)._deselect?.(range.start, range.end, true);
  } catch {
    /* best-effort */
  }
}

function deselectRegularPieceRange(
  torrent: BuiltinStreamTorrent,
  range: { start: number; end: number } | null,
): void {
  if (!range) return;
  const t = torrent as WtTorrent;
  try {
    if (typeof t.deselect === "function") {
      t.deselect(range.start, range.end);
      return;
    }
    t._deselect?.(range.start, range.end, false);
  } catch {
    /* best-effort */
  }
}

function deselectAllFiles(torrent: BuiltinStreamTorrent): void {
  const files = readProp(() => torrent.files, undefined);
  if (Array.isArray(files)) {
    for (const file of files) {
      try {
        file.deselect?.();
      } catch {
        /* best-effort */
      }
    }
  }
  deselectRegularPieceRange(torrent, torrentPieceRange(torrent));
}

function triggerPriorityEdgePrefetch(
  torrent: BuiltinStreamTorrent,
  file: BuiltinStreamFile,
  opts: StreamPriorityOptions,
): void {
  const key = fileSelectionKey(file);
  let files = prioritizedEdgePrefetches.get(torrent);
  if (!files) {
    files = new Set<string>();
    prioritizedEdgePrefetches.set(torrent, files);
  }
  if (files.has(key)) return;
  files.add(key);
  const prefetchEdges = opts.prefetchEdges ?? prefetchBuiltinFileEdges;
  void prefetchEdges(torrent, file).catch((err) => {
    files.delete(key);
    opts.onPrefetchError?.(err);
  });
}

/**
 * Tell WebTorrent which file is actually on screen.
 *
 * Opening one file in a pack must behave like opening a single-file torrent:
 * the requested bytes own the swarm first. WebTorrent creates a whole-torrent
 * selection at startup; if we leave that in place, a mid-season episode competes
 * with earlier files in the pack. Drop regular selections, then add a small
 * stream-priority window for the wanted head (or the seek point). FileIterator
 * selections widen naturally as the player requests more ranges.
 */
export function prioritizeBuiltinStreamFile(
  torrent: BuiltinStreamTorrent,
  file: BuiltinStreamFile,
  opts: StreamPriorityOptions = {},
): void {
  const key = fileSelectionKey(file);
  const seek = seekPieceRange(torrent, file, opts.seekOffset);
  // Matroska (MKV/WebM) resolves a seek through its SeekHead (near the head) and
  // Cues (near the tail). Keep both index regions available and critical while a
  // seek is in flight so the demuxer maps the target timestamp onto the same
  // audio and video cluster instead of estimating and landing them apart.
  const { holdHeadIndex, tailCritical } = seekIndexPlan({
    isMatroska: isMatroskaContainer(file.path || file.name),
    seeking: seek != null,
  });
  const head = seek && !holdHeadIndex ? null : headPieceRange(torrent, file);
  const tail = tailPieceRange(torrent, file);
  const wantsTail = tail != null && !samePieceRange(tail, head);
  // The head (or seek target) must own the swarm until its window lands. Hold
  // the tail below the head priority until then, so the moov/cues prefetch
  // never competes with the very first frame for peer bandwidth.
  const primaryWindow = seek ?? head;
  const primaryComplete = primaryWindow ? isPieceRangeComplete(torrent, primaryWindow) : true;
  const tailPriority = resolveStreamTailPriority(primaryComplete);
  const effectiveTailPriority = tailCritical ? SEEK_FILE_PRIORITY : tailPriority;
  const tailDeferred = wantsTail && effectiveTailPriority !== SEEK_FILE_PRIORITY;
  const previous = prioritizedStreamFiles.get(torrent);
  if (
    previous?.key === key &&
    samePieceRange(previous.headRange, head) &&
    samePieceRange(previous.tailRange, tail) &&
    samePieceRange(previous.seekRange, seek) &&
    previous.tailDeferred === tailDeferred
  ) {
    markCriticalPieceRange(torrent, head);
    if (tailCritical) markCriticalPieceRange(torrent, tail);
    markCriticalPieceRange(torrent, seek);
    triggerPriorityEdgePrefetch(torrent, file, opts);
    return;
  }

  const headChanged = !samePieceRange(previous?.headRange ?? null, head);
  if (previous?.key !== key || headChanged) {
    deselectStreamPieceRange(torrent, previous?.headRange ?? null);
  }
  deselectStreamPieceRange(torrent, previous?.seekRange ?? null);
  // Drop the old tail selection when its range changed, or when we are promoting
  // it out of the deferred priority, so the stale low-priority selection is gone
  // before the equal-priority one lands.
  if (
    !samePieceRange(previous?.tailRange ?? null, tail) ||
    (previous?.tailDeferred ?? false) !== tailDeferred
  ) {
    deselectStreamPieceRange(torrent, previous?.tailRange ?? null);
  }
  if (previous?.key !== key) {
    deselectAllFiles(torrent);
  }
  prioritizedStreamFiles.set(torrent, {
    key,
    headRange: head,
    tailRange: tail,
    seekRange: seek,
    tailDeferred,
  });

  if (head && (previous?.key !== key || headChanged)) {
    selectPieceRange(torrent, head, SEEK_FILE_PRIORITY);
    markCriticalPieceRange(torrent, head);
  }
  if (tail && !samePieceRange(tail, head)) {
    selectPieceRange(torrent, tail, effectiveTailPriority);
    if (tailCritical) markCriticalPieceRange(torrent, tail);
  }

  if (seek) {
    selectPieceRange(torrent, seek, SEEK_FILE_PRIORITY);
    markCriticalPieceRange(torrent, seek);
  }

  // The byte route marks the foreground timestamp after the first chunk proves
  // the request is real. Priority selection happens a little earlier, while the
  // first chunk is still fighting for the wire. Cap upload here too so old
  // completed seeds cannot crowd out the very first bytes of playback.
  applyForegroundUploadThrottle(state().client, true);
  triggerPriorityEdgePrefetch(torrent, file, opts);
}

export function resetBuiltinStreamPriorityForTests(): void {
  prioritizedStreamFiles = new WeakMap<object, StreamPriorityState>();
  prioritizedEdgePrefetches = new WeakMap<object, Set<string>>();
}

/**
 * Select all files and resume so the download actually starts.
 *
 * Only call this from paths where starting is the user's intent (add, explicit
 * resume, rehydrate of a non-paused row). Never call it from a read path such
 * as listTorrents: doing so silently un-pauses everything on every poll and
 * makes pause a no-op.
 */
function ensureDownloading(t: WtTorrent): void {
  selectAllFiles(t);
  try {
    t.resume();
  } catch {
    /* best-effort */
  }
}
/**
 * Resume, re-selecting files before the re-announce so the first peer to arrive
 * finds every piece wanted.
 */
function resumeTransfer(t: WtTorrent): void {
  resumeTransferCore(t, (x) => ensureDownloading(x as WtTorrent));
}

/**
 * Resume a torrent honouring its persisted acquisition intent (issue C).
 *
 * A bare {@link resumeTransfer} whole-file selects on every resume. Doing that
 * to a `stream`/`prewarm` row silently converts a Play into a full download —
 * the same restart-reclassification bug that put whole files on disk before.
 * So the stored origin decides the shape:
 *   - `keep`             → select all + resume (the download must continue).
 *   - `stream`/`prewarm` → reconnect peers but leave files DESELECTED (the
 *                          stream route re-selects only the ranges the player
 *                          asks for); prewarm additionally keeps its peer cap.
 *   - missing / read error → `leave`: never reselect (would convert a stream)
 *                          and never deselect (would halt a kept download);
 *                          just reconnect peers with selection untouched.
 */
function resumeTransferForLookup(t: WtTorrent, lookup: ExistingOriginLookup): void {
  const selection = resumeSelectionForLookup(lookup);
  if (selection === "select-all") {
    resumeTransferCore(t, (x) => ensureDownloading(x as WtTorrent));
    return;
  }
  if (selection === "leave") {
    resumeTransferCore(t);
    return;
  }
  resumeTransferCore(t, (x) => {
    deselectAllFiles(x as WtTorrent);
    if (selection === "deselect-cap") enforcePrewarmPeerCap(x as WtTorrent);
  });
}

/**
 * Apply the persisted status to a freshly re-added torrent.
 *
 * Origin decides the shape, not just the status: a `stream`/`prewarm` row must
 * NEVER be whole-file selected on restart, or a Play the user made once would
 * silently become a full download every time the process comes back. Streams
 * stay deselected (the stream route re-selects the ranges the player asks for);
 * prewarms stay deselected and peer-capped.
 */
function applyPersistedStatus(
  t: WtTorrent,
  status: string | null | undefined,
  origin?: string | null,
): void {
  if (purposeFromOrigin(origin) !== "keep") {
    deselectAllFiles(t);
    if (purposeFromOrigin(origin) === "prewarm") enforcePrewarmPeerCap(t);
    if (status === "paused") haltTransfer(t);
    return;
  }
  if (status === "paused") {
    selectAllFiles(t);
    haltTransfer(t);
    return;
  }
  ensureDownloading(t);
}

/**
 * Claim (or deliberately do not claim) pieces on a live torrent for a resolved
 * add intent. `leave` is the issue-A guard: a Play that meets a kept download,
 * or an add whose origin could not be read, must not deselect or reselect.
 */
function applyAddSelection(
  t: WtTorrent,
  selection: AddSelection,
  capPeers: boolean,
): void {
  if (selection === "select-all") {
    ensureDownloading(t);
    return;
  }
  if (selection === "deselect") {
    deselectAllFiles(t);
    if (capPeers) enforcePrewarmPeerCap(t);
    return;
  }
  // "leave": never halt or reselect. Used for kept downloads and read errors.
}

const REHYDRATE_METADATA_TIMEOUT_MS = 90_000;
const UNOWNED_HANDLE_RELEASE_WAIT_MS = 15_000;

type PersistedFileFingerprint = {
  path: string;
  size: number;
  mtimeMs: number;
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function rehydrateFailureData(err: unknown): { status: "error"; error: string } {
  const message = errorMessage(err).trim();
  return {
    status: "error",
    error: message || "Built-in engine could not restore this torrent",
  };
}

export function rehydrateFailureDataForTests(
  err: unknown,
): { status: "error"; error: string } {
  return rehydrateFailureData(err);
}

async function waitForUnownedHandleRelease(
  client: WebTorrentLike,
  torrent: WtTorrent,
  hash: string,
): Promise<void> {
  const deadline = Date.now() + UNOWNED_HANDLE_RELEASE_WAIT_MS;
  while (
    Date.now() < deadline &&
    !state().meta.has(hash) &&
    findTorrent(client, hash) === torrent
  ) {
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
}

async function recordRehydrateFailure(
  row: EngineTorrentRehydrateRow,
  err: unknown,
): Promise<void> {
  if (err instanceof InvalidCompletedMediaError) {
    await prisma.$transaction([
      prisma.engineTorrent.updateMany({
        where: { id: row.id },
        data: {
          progress: 1,
          status: "error",
          error: INVALID_COMPLETED_MEDIA_MESSAGE,
        },
      }),
      prisma.acquisitionTarget.updateMany({
        where: { infoHash: { in: [row.hash, row.hash.toUpperCase()] } },
        data: {
          progress: 0,
          status: "failed",
          error: INVALID_COMPLETED_MEDIA_MESSAGE,
        },
      }),
    ]);
    return;
  }
  await prisma.engineTorrent.updateMany({
    where: { id: row.id },
    data: rehydrateFailureData(err),
  });
}

function scheduleRehydrateReadyPersist(
  row: EngineTorrentRehydrateRow,
  t: WtTorrent,
): void {
  if (isComplete(t)) {
    void persistAndParkCompletedTorrent(row.userId, t);
    return;
  }
  scheduleProgressPersist(
    row.userId,
    t,
    row.status === "paused" ? "paused" : "downloading",
  );
}

type TorrentMeta = {
  savePath?: string;
  category?: string;
  name?: string;
  /** Owning user — used to scope list/pause/delete in multi-user process */
  userId?: string;
};

type EngineTorrentRehydrateRow = {
  id: string;
  userId: string;
  hash: string;
  name: string;
  magnet: string | null;
  torrentUrl: string | null;
  savePath: string | null;
  category: string | null;
  status: string;
  /**
   * Acquisition intent as persisted. Rehydrate and retry derive their purpose
   * from this so a stream is never resurrected as a whole-file download.
   */
  origin: string;
  verifiedBitfield: string | null;
  verifiedFilesJson: string | null;
};

type EngineState = {
  client: WebTorrentLike | null;
  loading: Promise<WebTorrentLike> | null;
  uploadThrottleTimer: ReturnType<typeof setInterval> | null;
  /** Replaces stale interval closures after a development hot reload. */
  uploadThrottleVersion: number;
  /** hash -> last known save path / category for list enrichment */
  meta: Map<string, TorrentMeta>;
  /** userIds (or "*" for all-users) already rehydrated this process */
  rehydrated: Set<string>;
  /** in-flight rehydrate promises keyed by userId or "*" */
  rehydrating: Map<string, Promise<void>>;
  /** Torrent objects already wired to the completion observer. */
  completionObserved: WeakSet<object>;
  /** userId:hash -> one durable completion/park transition. */
  parking: Map<string, Promise<boolean>>;
  /** Failed detach retries; completed torrents stay disconnected meanwhile. */
  parkingRetryTimers: Map<string, ReturnType<typeof setTimeout>>;
  /** Active engine-backed HTTP responses keyed by info hash. */
  streamLeases: Map<string, number>;
  streamLeaseWaiters: Map<string, Set<() => void>>;
  /** Releases shared DHT/listener resources after the final torrent leaves. */
  idleDestroyTimer: ReturnType<typeof setTimeout> | null;
};

const g = globalThis as unknown as { __tfBuiltinEngine?: EngineState };

function state(): EngineState {
  if (!g.__tfBuiltinEngine) {
    g.__tfBuiltinEngine = {
      client: null,
      loading: null,
      uploadThrottleTimer: null,
      uploadThrottleVersion: 0,
      meta: new Map(),
      rehydrated: new Set(),
      rehydrating: new Map(),
      completionObserved: new WeakSet(),
      parking: new Map(),
      parkingRetryTimers: new Map(),
      streamLeases: new Map(),
      streamLeaseWaiters: new Map(),
      idleDestroyTimer: null,
    };
  }
  // Backfill fields if an older singleton is still hot-reloaded in dev
  const s = g.__tfBuiltinEngine;
  (s as Partial<EngineState>).uploadThrottleTimer ??= null;
  (s as Partial<EngineState>).uploadThrottleVersion ??= 0;
  if (!s.rehydrated) s.rehydrated = new Set();
  if (!s.rehydrating) s.rehydrating = new Map();
  if (!s.completionObserved) s.completionObserved = new WeakSet();
  if (!s.parking) s.parking = new Map();
  if (!s.parkingRetryTimers) s.parkingRetryTimers = new Map();
  if (!s.streamLeases) s.streamLeases = new Map();
  if (!s.streamLeaseWaiters) s.streamLeaseWaiters = new Map();
  (s as Partial<EngineState>).idleDestroyTimer ??= null;
  return s;
}

/**
 * How long after the last foreground playback sample the sweep leaves the
 * foreground hash alone. A paused player holds no stream lease, so without this
 * the sweep could park the exact torrent the viewer is about to resume.
 */
const COMPLETION_SWEEP_FOREGROUND_GRACE_MS = 120_000;

/**
 * Catch torrents that finished without a completion event, on the 5s beat.
 *
 * See `completion-sweep.ts` for why this is needed at all: park is otherwise
 * only reachable from `download`/`done`/`verified` or attach, so a torrent
 * whose last piece verifies after its final triggering event seeds forever.
 * Deliberately reuses this loop rather than adding a timer — a CPU-pressure fix
 * that arms another interval is not a fix.
 */
export function sweepCompletedBuiltinTorrents(): CompletionSweepStats {
  const s = state();
  const torrents = s.client?.torrents ?? [];
  return runCompletionSweep<WtTorrent>({
    torrents: torrents as WtTorrent[],
    hashOf: (t) => readProp(() => t.infoHash, "")?.toLowerCase?.() ?? "",
    // The full verification predicate — never the latched WebTorrent done flag
    // and never bare progress. `isComplete` short-circuits on progress before
    // touching the bitfield, so the per-beat cost for an incomplete torrent is
    // one float compare, and a bitfield hole always reads as incomplete.
    isVerifiedComplete: (t) => isComplete(t),
    leaseCount: (hash) => s.streamLeases.get(hash) ?? 0,
    // A *paused* player holds no lease, so leases alone would let the sweep
    // park a torrent the viewer is about to resume. Parking is recoverable
    // (Play rehydrates from the persisted files), but re-attaching costs a
    // visible stall, so the recently-foreground hash gets a grace window.
    isForeground: (hash) =>
      !!hash &&
      foregroundHash()?.toLowerCase() === hash &&
      foregroundIdleMs() < COMPLETION_SWEEP_FOREGROUND_GRACE_MS,
    isParking: (hash) => s.parking.has(hash),
    // The engine's own 30 s park-retry backoff owns the torrent while it is
    // armed; the sweep must not shortcut it into a tighter 5 s retry loop.
    isParkRetryPending: (hash) => s.parkingRetryTimers.has(hash),
    ownerOf: (hash) => s.meta.get(hash)?.userId?.trim() || undefined,
    // In-memory meta can be missing after a restart that has not rehydrated
    // this hash. Fall back to the durable row on the sweep's bounded owner
    // retry cadence — never per beat — and only backfill meta, so the next
    // sweep can park it normally. The promise is returned so a transient
    // failure is retried later instead of being written off permanently.
    onMissingOwner: (hash) => backfillSweepOwnerFromDatabase(hash),
    parkBudget: Math.max(
      0,
      MAX_CONCURRENT_COMPLETION_PARKS - s.parking.size,
    ),
    // Deselect only: no pause, no destroy, no file or DB mutation. A completed
    // torrent needs no pieces, so dropping the selection stops the redundant
    // request/discard traffic while every byte, row and resume path survives.
    // Reuses `parkBuiltinStreamTorrent` so the stream-priority bookkeeping is
    // cleared the same way it is everywhere else — a raw deselect would leave
    // `prioritizeBuiltinStreamFile` short-circuiting on a selection that no
    // longer exists, and a later Play stalled.
    quiesce: (t) => {
      const hash = readProp(() => t.infoHash, "") ?? "";
      if (!hash || !parkBuiltinStreamTorrent(hash)) {
        deselectAllFiles(t);
        prioritizedStreamFiles.delete(t as unknown as object);
        prioritizedEdgePrefetches.delete(t as unknown as object);
      }
    },
    park: (userId, t) => persistAndParkCompletedTorrent(userId, t),
  });
}

/**
 * Recover an owning user id for a swept hash from the durable engine row.
 *
 * Purely a read plus an in-memory meta backfill: it creates nothing and deletes
 * nothing. Returns whether an owner was actually recovered, so the sweep can
 * tell "no durable row" and "the query failed" apart from success and retry
 * only on its bounded cadence — a lookup that failed once must not be
 * suppressed for the life of the process, or the torrent stays quiesced but
 * live forever. While unresolved the hash stays quiesced and unparked, visible
 * in the sweep's `parkSkippedNoOwner` counter.
 */
async function backfillSweepOwnerFromDatabase(hash: string): Promise<boolean> {
  const expectedClient = state().client;
  if (!expectedClient) return false;
  try {
    const row = await prisma.engineTorrent.findFirst({
      where: { hash },
      select: { userId: true, savePath: true, category: true, name: true },
    });
    const userId = row?.userId?.trim();
    if (!userId) return false;
    // The lookup may outlive an idle destroy or explicit shutdown. Never
    // resurrect meta for the dead engine, or let its owner leak into a fresh
    // client created while this query was in flight.
    if (state().client !== expectedClient) return false;
    const s = state();
    const existing = s.meta.get(hash);
    s.meta.set(hash, {
      savePath: existing?.savePath ?? row?.savePath ?? undefined,
      category: existing?.category ?? row?.category ?? undefined,
      name: existing?.name ?? row?.name ?? undefined,
      userId,
    });
    return true;
  } catch (err) {
    console.warn(
      `[completion-sweep] durable owner lookup failed for ${hash}:`,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

function resetEngineBookkeeping(s: EngineState): void {
  for (const timer of s.parkingRetryTimers.values()) clearTimeout(timer);
  s.parkingRetryTimers.clear();
  if (s.uploadThrottleTimer) clearInterval(s.uploadThrottleTimer);
  s.uploadThrottleTimer = null;
  s.uploadThrottleVersion = 0;
  s.meta.clear();
  clearCompletionSweepOwnerState();
  s.rehydrated.clear();
  s.rehydrating.clear();
}

const UPLOAD_THROTTLE_LOOP_VERSION = 2;

function startUploadThrottleLoop(client: WebTorrentLike): void {
  const s = state();
  if (
    s.uploadThrottleTimer &&
    s.uploadThrottleVersion === UPLOAD_THROTTLE_LOOP_VERSION
  ) {
    return;
  }
  if (s.uploadThrottleTimer) clearInterval(s.uploadThrottleTimer);
  s.uploadThrottleVersion = UPLOAD_THROTTLE_LOOP_VERSION;
  applyForegroundUploadThrottle(client, foregroundActive());
  s.uploadThrottleTimer = setInterval(() => {
    applyForegroundUploadThrottle(client, foregroundActive());
    // Re-check live torrents for completions no event ever reported.
    try {
      sweepCompletedBuiltinTorrents();
    } catch (err) {
      console.warn(
        "[completion-sweep] sweep failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
    // Same 5s beat drives the swarm-delivery watchdog: when a torrent is the
    // foreground stream, sample it and fail over if it has stalled. Loaded
    // dynamically so the watchdog (which imports this engine for its effects)
    // does not create a static import cycle. `driveForegroundSwarmWatch` never
    // throws and reports its own failures observably, so this stays fire-and-
    // forget without an empty catch hiding a dead watchdog; the remaining catch
    // only fires if the module itself fails to load, which is loud on purpose.
    void import("@/lib/playback/swarm-delivery-watchdog")
      .then((m) => m.driveForegroundSwarmWatch())
      .catch((err) =>
        console.error(
          "[swarm-watch] watchdog module failed to load; stall detection is down:",
          err instanceof Error ? err.message : String(err),
        ),
      );
  }, UPLOAD_THROTTLE_POLL_MS);
  s.uploadThrottleTimer.unref?.();
}

/**
 * Stops the in-process engine without touching downloaded files.
 *
 * Called when the primary client changes away from `builtin`. Without this the
 * WebTorrent client stays alive with every torrent still connected: invisible
 * in the UI (which now lists the newly selected client) but still consuming
 * bandwidth, disk and peer slots.
 *
 * `EngineTorrent` rows are deliberately left in place — switching back
 * rehydrates from them, so a round trip costs a re-verify, not the download.
 * Resets the rehydrate bookkeeping so the next `getWtClient()` starts clean.
 */
export async function shutdownBuiltinEngine(): Promise<boolean> {
  const s = state();
  const client = s.client ?? (s.loading ? await s.loading.catch(() => null) : null);

  s.client = null;
  s.loading = null;
  if (s.idleDestroyTimer) clearTimeout(s.idleDestroyTimer);
  s.idleDestroyTimer = null;
  resetEngineBookkeeping(s);

  if (!client) return false;

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    // destroy() with no opts leaves files on disk.
    try {
      client.destroy(() => finish());
    } catch (err) {
      console.warn(
        "[builtin-engine] shutdown failed",
        err instanceof Error ? err.message : err,
      );
      finish();
      return;
    }
    // Never let a stuck destroy hang the settings save.
    setTimeout(finish, 5000);
  });

  return true;
}

/**
 * What is already sitting at a path we intend to write to.
 *
 * Walks every ancestor as well as the leaf. A file named `Subs` where we want
 * `Subs/en.srt` makes `lstat` on the leaf throw `ENOTDIR`, which naively reads
 * as "nothing is there" — and the chunk store then fails when it tries to
 * create the directory. A junction anywhere along the path is worse: the store
 * follows it and writes outside the library entirely.
 */
function probeExisting(
  dest: string,
  rel: string,
  ownerOf: (dest: string, rel: string) => string | null,
): { size: number; owner: string | null; isDirectory?: boolean } | null {
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  let current = dest;

  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      // A missing path is the normal case. Anything else — notably ENOTDIR,
      // meaning a file blocks one of our folders — must block the rewrite.
      if (code === "ENOENT") return null;
      return { size: -1, owner: null, isDirectory: true };
    }

    if (stat.isSymbolicLink()) {
      return { size: -1, owner: null, isDirectory: true };
    }

    const isLeaf = i === parts.length - 1;
    if (!isLeaf) {
      // A parent that is not a directory blocks the whole path.
      if (!stat.isDirectory()) return { size: -1, owner: null, isDirectory: true };
      continue;
    }
    return {
      size: stat.size,
      owner: ownerOf(dest, rel),
      isDirectory: stat.isDirectory(),
    };
  }
  return null;
}

async function getWtClient(): Promise<WebTorrentLike> {
  const s = state();
  if (s.idleDestroyTimer) {
    clearTimeout(s.idleDestroyTimer);
    s.idleDestroyTimer = null;
  }
  if (s.client) return s.client;
  if (s.loading) return s.loading;

  s.loading = (async () => {
    // Dynamic import keeps Next bundler from packing native deps into edge
    const mod = await import("webtorrent");
    const WebTorrent =
      (mod as { default?: new (opts?: object) => WebTorrentLike }).default ??
      (mod as unknown as new (opts?: object) => WebTorrentLike);
    // Must run before any wire connects: WebTorrent's request scheduler throws
    // on pieces it has already nulled (see webtorrent-piece-race).
    const { patchWebTorrentPieceRace } = await import(
      "@/lib/clients/webtorrent-piece-race"
    );
    if (!(await patchWebTorrentPieceRace())) {
      console.warn(
        "[builtin-engine] could not patch WebTorrent piece race; expect noisy uncaughtException logs",
      );
    }
    // Must run before any metadata arrives: WebTorrent's own `_onMetadata`
    // guard is defeated by its own `await`, so concurrent peers re-initialise
    // the torrent and corrupt the bitfield (see webtorrent-metadata-race).
    const { patchWebTorrentMetadataRace } = await import(
      "@/lib/clients/webtorrent-metadata-race"
    );
    if (!(await patchWebTorrentMetadataRace())) {
      console.warn(
        "[builtin-engine] could not patch WebTorrent metadata race; expect bogus progress on freshly added torrents",
      );
    }
    // Outgoing message encryption XORs in place, and `_message` forwards the
    // caller's own buffer — so announcing our bitfield to an encrypted peer
    // overwrites it with ciphertext (see webtorrent-wire-encrypt).
    const { patchWebTorrentWireEncrypt } = await import(
      "@/lib/clients/webtorrent-wire-encrypt"
    );
    if (!(await patchWebTorrentWireEncrypt())) {
      console.warn(
        "[builtin-engine] could not patch wire encryption aliasing; expect corrupted progress and spurious hash failures",
      );
    }
    // Peer sockets get only a `once('error')` from WebTorrent, so a second
    // reset on the same socket has no listener and crashes out of Node.
    const { patchWebTorrentConnErrors } = await import(
      "@/lib/clients/webtorrent-conn-errors"
    );
    const conns = await patchWebTorrentConnErrors();
    if (!conns.outgoing || !conns.incoming) {
      console.warn(
        `[builtin-engine] could not guard peer sockets (outgoing=${conns.outgoing} incoming=${conns.incoming}); expect UTP_ECONNRESET uncaughtException logs`,
      );
    }
    // Must run before any metadata arrives: this is what stops WebTorrent
    // creating a redundant release-root folder inside our smart path.
    const { patchWebTorrentContentLayout } = await import(
      "@/lib/clients/content-layout"
    );
    const { ownerOf, claimPaths } = await import(
      "@/lib/clients/layout-ownership"
    );
    const applied = await patchWebTorrentContentLayout(
      (dest, rel) => probeExisting(dest, rel, ownerOf),
      claimPaths,
    );
    if (!applied) {
      console.warn(
        "[builtin-engine] could not patch WebTorrent layout; downloads will nest under a release folder",
      );
    }
    const client = new WebTorrent(BUILTIN_CLIENT_OPTIONS);
    // WebTorrent queues every torrent added before the peer server emits
    // "listening" by attaching `client.once("listening")` in torrent.js. A
    // cold rehydrate can add dozens of rows synchronously, tripping
    // MaxListenersExceededWarning and retaining per-torrent closures until the
    // socket opens. Wait once here so all later adds take WebTorrent's direct
    // `client.listening` branch instead of registering one listener per torrent.
    await waitForClientListening(client);
    s.client = client;
    startUploadThrottleLoop(client);
    return client;
  })();

  try {
    return await s.loading;
  } finally {
    s.loading = null;
  }
}

/**
 * Freeing bytes changes the answer to "how big is the download folder", and the
 * folder-size memo would otherwise serve the pre-release figure for another 30s
 * — long enough for the very next Play to be refused over space that no longer
 * exists. Fire-and-forget so cleanup paths stay synchronous.
 */
function invalidateDirectorySizeCache(): void {
  void import("@/lib/library/disk-space")
    .then((m) => m.resetDirectorySizeCache())
    .catch(() => {
      /* best-effort */
    });
}

/**
 * Remember this torrent's info dictionary so it never has to be fetched again.
 *
 * Called on every path that reaches `ready`, because that is precisely the
 * moment metadata is known to be complete and correct. Best-effort: a failure
 * here costs a future offline start, never the current add.
 */
function cacheTorrentMetadata(root: string, hash: string, torrent: WtTorrent): void {
  const bytes = readProp(() => torrent.torrentFile, undefined);
  if (!bytes) return;
  saveTorrentMetadata(root, hash, bytes);
}

/**
 * Automatic storage budget + free-space floor (see library/disk-space).
 *
 * This is the *second* place a send is checked — the route-level gate
 * (`library/storage-gate`) runs first and is the one that reclaims cache for a
 * Play and asks the owner about the cap. This check exists because callers can
 * reach the engine directly, so it must stay.
 *
 * What it must not do is re-litigate a decision the owner already made. It used
 * to: an over-cap Download the owner had explicitly confirmed passed the gate
 * and was then refused here, with the gate's own message, as a 502. Honouring
 * `overrideStorageCap` — through the same `isOverridableLimit` rule, so a
 * `wont-fit` or `setup` refusal is still absolute — is what makes the two
 * checks agree.
 */
async function checkStoragePolicy(
  config: ClientConnectionConfig,
  dest: string,
  incomingBytes?: number | null,
  overrideStorageCap?: boolean,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { assertStorageBudget } = await import("@/lib/library/disk-space");
  const { isOverridableLimit } = await import("@/lib/library/storage-override");
  const root =
    config.baseDownloadPath?.trim() ||
    config.savePath?.trim() ||
    dest;
  const r = await assertStorageBudget({
    root,
    maxStorageBytes: config.maxStorageBytes,
    incomingBytes: incomingBytes ?? null,
  });
  if (r.ok) return { ok: true };
  if (overrideStorageCap && isOverridableLimit(r.limit)) return { ok: true };
  return { ok: false, message: r.message };
}

function magnetForPersist(
  payload: AddTorrentPayload,
  uri: string,
  torrent?: WtTorrent,
): string | null {
  if (payload.magnet?.trim()) return payload.magnet.trim();
  if (uri.startsWith("magnet:")) return uri;
  if (torrent?.magnetURI) return torrent.magnetURI;
  return null;
}

function selectBuiltinAddUri(payload: AddTorrentPayload): string | null {
  // A .torrent URL/file already carries metadata, so prefer it over a magnet
  // that would first spend cold-start time resolving metadata from peers.
  const torrentUrl = payload.torrentUrl?.trim();
  if (torrentUrl) return torrentUrl;
  return payload.magnet?.trim() || null;
}

export function selectBuiltinAddUriForTests(payload: AddTorrentPayload): string | null {
  return selectBuiltinAddUri(payload);
}

/**
 * Make a live torrent fetch its WHOLE content at full speed.
 *
 * ## The bug this exists for
 *
 * A Play adds a torrent with every file **deselected** — deliberately, so the
 * stream route can select only the window around the playhead and a Play never
 * silently becomes a full download. Pressing Download on that same release
 * promotes it: `promoteTorrentToKept` flips the stored origin to `user`.
 *
 * But that only rewrote a database row. The *live* torrent kept the stream's
 * piece selection, so the engine went on fetching a narrow window around the
 * playhead while the Client page showed a download in progress and the progress
 * bar crawled. The owner's words: *"when i stream but want to download it, it
 * tracks the download but it's not fast... it's being limited."* It was not
 * bandwidth-limited — nothing throttles download rate — it was only ever being
 * asked for a sliver of the file.
 *
 * Selecting every file and clearing the stream-priority bookkeeping is what
 * turns the intent into actual bytes. Safe to call when nothing matches: an
 * unknown hash is a no-op, so callers never have to check first.
 *
 * @returns true when a live torrent was found and re-selected.
 */
export async function resumeFullDownload(
  config: ClientConnectionConfig,
  hash: string | null | undefined,
): Promise<boolean> {
  const h = hash?.trim().toLowerCase();
  if (!h) return false;
  try {
    const client = await ensureClientAndRehydrate(config);
    const t = findTorrent(client, h);
    if (!t) return false;
    // Drop the stream window bookkeeping first. `applyStreamPriority` short
    // -circuits when its cached state already matches the request and only
    // re-marks pieces critical — without clearing it, a later Play on this same
    // torrent could reason from a window that no longer describes the selection.
    prioritizedStreamFiles.delete(t as unknown as object);
    selectAllFiles(t);
    ensureDownloading(t);
    return true;
  } catch {
    // Never let a promotion fail because the engine was mid-restart: the DB row
    // is already correct, and a rehydrate re-selects from the stored origin.
    return false;
  }
}

/**
 * Test seam for the engine-side storage check.
 *
 * Exported specifically because this check is *invisible* from the route: the
 * gate says yes, and then this said no, and the only symptom was a 502 carrying
 * the gate's own message. A rule that can disagree with another rule silently
 * needs to be assertable on its own.
 */
export function checkStoragePolicyForTests(
  config: ClientConnectionConfig,
  dest: string,
  incomingBytes: number | null,
  overrideStorageCap?: boolean,
): Promise<{ ok: true } | { ok: false; message: string }> {
  return checkStoragePolicy(config, dest, incomingBytes, overrideStorageCap);
}

function torrentFileDiskPath(torrent: WtTorrent, file: WtFile): string | null {
  const root = readProp(() => torrent.path, "").trim();
  const rel = (file.path || file.name || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!root || !rel) return null;
  const rootPath = path.resolve(root);
  const filePath = path.resolve(rootPath, ...rel.split("/").filter(Boolean));
  const between = path.relative(rootPath, filePath);
  if (!between || between.startsWith("..") || path.isAbsolute(between)) return null;
  return filePath;
}

async function collectTorrentFileFingerprints(
  torrent: WtTorrent,
): Promise<PersistedFileFingerprint[] | null> {
  const files = readProp(() => torrent.files, undefined);
  if (!Array.isArray(files) || files.length === 0) return null;
  const out: PersistedFileFingerprint[] = [];
  for (const file of files) {
    const filePath = torrentFileDiskPath(torrent, file);
    if (!filePath) return null;
    try {
      const s = await fs.promises.stat(filePath);
      if (!s.isFile() || s.size !== file.length) return null;
      out.push({ path: filePath, size: s.size, mtimeMs: s.mtimeMs });
    } catch {
      return null;
    }
  }
  return out;
}

function bitfieldBase64(torrent: WtTorrent): string | null {
  const pieces = readProp(() => torrent.pieces, undefined);
  const buffer = readProp(() => torrent.bitfield?.buffer, undefined);
  if (!Array.isArray(pieces) || pieces.length === 0 || !(buffer instanceof Uint8Array)) {
    return null;
  }
  const bytes = Math.ceil(pieces.length / 8);
  if (buffer.length < bytes) return null;
  return Buffer.from(buffer.slice(0, bytes)).toString("base64");
}

async function persistedVerifiedState(torrent: WtTorrent): Promise<{
  verifiedBitfield: string;
  verifiedFilesJson: string;
} | null> {
  if (!readProp(() => torrent.ready, false)) return null;
  const verifiedBitfield = bitfieldBase64(torrent);
  if (!verifiedBitfield) return null;
  const files = await collectTorrentFileFingerprints(torrent);
  if (!files) return null;
  return { verifiedBitfield, verifiedFilesJson: JSON.stringify(files) };
}

async function validatedPersistedVerifiedState(torrent: WtTorrent): Promise<{
  verifiedBitfield: string;
  verifiedFilesJson: string;
} | null> {
  const verified = await persistedVerifiedState(torrent);
  if (!verified) return null;
  const files = JSON.parse(verified.verifiedFilesJson) as PersistedFileFingerprint[];
  const videos = files.filter((file) => isSupportedVideoFileName(file.path));
  if (videos.length === 0) throw new InvalidCompletedMediaError();

  for (const file of videos) {
    const outcome = await probeFile(file.path, { timeoutMs: 15_000 });
    if (!outcome.ok) {
      if (outcome.error.message.includes("ffprobe is unavailable")) {
        throw new Error(outcome.error.message);
      }
      throw new InvalidCompletedMediaError();
    }
    if (!outcome.result.streams.some((stream) => stream.codecType === "video")) {
      throw new InvalidCompletedMediaError();
    }
  }
  return verified;
}

async function startupBitfieldForRow(
  row: Pick<EngineTorrentRehydrateRow, "verifiedBitfield" | "verifiedFilesJson">,
): Promise<Uint8Array | null> {
  if (!row.verifiedBitfield || !row.verifiedFilesJson) return null;
  let files: PersistedFileFingerprint[];
  try {
    files = JSON.parse(row.verifiedFilesJson) as PersistedFileFingerprint[];
  } catch {
    return null;
  }
  if (!Array.isArray(files) || files.length === 0) return null;
  for (const f of files) {
    if (!f || typeof f.path !== "string" || typeof f.size !== "number" || typeof f.mtimeMs !== "number") {
      return null;
    }
    try {
      const s = await fs.promises.stat(f.path);
      if (!s.isFile() || s.size !== f.size || s.mtimeMs !== f.mtimeMs) return null;
    } catch {
      return null;
    }
  }
  try {
    const bytes = Buffer.from(row.verifiedBitfield, "base64");
    return bytes.length > 0 ? new Uint8Array(bytes) : null;
  } catch {
    return null;
  }
}

/**
 * Read the origin already persisted for a hash, distinguishing three cases that
 * MUST NOT be conflated: the row is absent (`missing`), present (`found`), or we
 * could not tell because the read threw (`error`). Issue D: a failed read is
 * never permission to treat a row as absent — that is how a genuine `user`
 * download used to get quietly demoted and made evictable.
 */
async function lookupExistingOrigin(
  userId: string | null | undefined,
  hash: string | null,
): Promise<ExistingOriginLookup> {
  const uid = userId?.trim();
  if (!uid || !hash) return { status: "missing" };
  try {
    const row = await prisma.engineTorrent.findUnique({
      where: { userId_hash: { userId: uid, hash } },
      select: { origin: true },
    });
    return row ? { status: "found", origin: row.origin } : { status: "missing" };
  } catch {
    return { status: "error" };
  }
}

async function upsertEngineTorrent(opts: {
  userId: string;
  hash: string;
  name: string;
  magnet: string | null;
  torrentUrl?: string | null;
  savePath: string;
  category?: string | null;
  status?: string;
  progress?: number;
  sizeBytes?: number;
  torrent?: WtTorrent | null;
  /**
   * Origin to stamp when the row is first created. Decided authoritatively at
   * add time from the effective purpose. The UPDATE clause never touches origin
   * — an existing row's classification is only ever changed by the explicit,
   * monotonic {@link promoteTo}/{@link promoteFrom} compare-and-set below.
   */
  birthOrigin?: OriginValue;
  /** Monotonic promote target, applied only when the current origin is in {@link promoteFrom}. */
  promoteTo?: OriginValue | null;
  /** The only origins {@link promoteTo} is allowed to overwrite. `user` is never listed → never demotes. */
  promoteFrom?: OriginValue[];
}): Promise<void> {
  if (!opts.hash || typeof opts.hash !== "string") {
    console.warn("[builtin-engine] upsertEngineTorrent missing hash", opts.name);
    return;
  }
  const hash = opts.hash.toLowerCase();
  try {
    const verified = opts.torrent ? await persistedVerifiedState(opts.torrent) : null;
    await prisma.engineTorrent.upsert({
      where: {
        userId_hash: { userId: opts.userId, hash },
      },
      create: {
        userId: opts.userId,
        hash,
        name: opts.name,
        magnet: opts.magnet,
        torrentUrl: opts.torrentUrl ?? null,
        savePath: opts.savePath,
        category: opts.category ?? null,
        status: opts.status ?? "downloading",
        origin: opts.birthOrigin ?? USER_ORIGIN,
        progress: opts.progress ?? 0,
        sizeBytes: BigInt(Math.max(0, Math.floor(opts.sizeBytes ?? 0))),
        verifiedBitfield: verified?.verifiedBitfield ?? null,
        verifiedFilesJson: verified?.verifiedFilesJson ?? null,
        verifiedAt: verified ? new Date() : null,
      },
      update: {
        name: opts.name,
        magnet: opts.magnet ?? undefined,
        torrentUrl: opts.torrentUrl ?? null,
        savePath: opts.savePath,
        category: opts.category ?? null,
        status: opts.status ?? "downloading",
        progress: opts.progress ?? 0,
        sizeBytes: BigInt(Math.max(0, Math.floor(opts.sizeBytes ?? 0))),
        // NOTE: origin is deliberately absent — see promote CAS below.
        ...(verified
          ? {
              verifiedBitfield: verified.verifiedBitfield,
              verifiedFilesJson: verified.verifiedFilesJson,
              verifiedAt: new Date(),
            }
          : {}),
        error: null,
      },
    });
    // Explicit, monotonic origin transition. Guarded so it is a no-op unless the
    // current origin is one we are allowed to overwrite: prewarm→stream on Play,
    // prewarm|stream→user on Download, and evicting→(stream|user) when a user add
    // STEALS a lease a sweep is holding. `user` is never a source, so a Download
    // or Play can never demote a genuine kept row. Clearing evictLease/evictFrom
    // makes the steal visible to the sweep's re-check (it aborts when its token no
    // longer owns the row); it is a harmless no-op for non-evicting sources.
    if (opts.promoteTo && opts.promoteFrom && opts.promoteFrom.length > 0) {
      await prisma.engineTorrent.updateMany({
        where: { userId: opts.userId, hash, origin: { in: opts.promoteFrom } },
        data: { origin: opts.promoteTo, evictLease: null, evictFrom: null },
      });
    }
  } catch (err) {
    console.warn("[builtin-engine] EngineTorrent upsert failed", err);
  }
}

/**
 * Load durable EngineTorrent rows and re-add magnets into the live WebTorrent client.
 * Non-blocking per torrent: errors are caught individually; we do not wait for metadata.
 */
async function rehydrateFromDb(
  client: WebTorrentLike,
  userId?: string | null,
): Promise<void> {
  const s = state();
  const key = userId?.trim() || "*";
  if (s.rehydrated.has(key)) return;
  // If we already rehydrated all users, skip per-user
  if (key !== "*" && s.rehydrated.has("*")) return;

  const existing = s.rehydrating.get(key);
  if (existing) {
    await existing;
    return;
  }

  const work = (async () => {
    let succeeded = false;
    let retryNeeded = false;
    try {
      const rows = await prisma.engineTorrent.findMany({
        where: {
          ...(userId?.trim() ? { userId: userId.trim() } : {}),
          status: { notIn: ["removed", "error"] },
          OR: [{ magnet: { not: null } }, { torrentUrl: { not: null } }],
        },
      });

      for (const row of rows) {
        if (!shouldRehydrateTorrent(row)) continue;
        const addUri = row.torrentUrl?.trim() || row.magnet?.trim();
        if (!addUri) continue;
        if (!row.hash) continue;
        const hash = row.hash.toLowerCase();
        try {
          // Must use findTorrent — client.get() is async in WebTorrent 3 and
          // a bare Promise is always truthy (would skip re-add forever).
          let already = findTorrent(client, hash);
          if (already && !s.meta.has(hash)) {
            await waitForUnownedHandleRelease(client, already, hash);
            already = findTorrent(client, hash);
          }
          if (already && !s.meta.has(hash)) {
            retryNeeded = true;
            continue;
          }
          if (already) {
            const acceptExisting = () => {
              if (!hasSupportedVideoPayload(already.files ?? [])) {
                s.meta.delete(hash);
                try {
                  already.destroy?.({ destroyStore: false });
                } catch {
                  /* best-effort */
                }
                void recordRehydrateFailure(
                  row,
                  new InvalidCompletedMediaError(),
                ).catch(() => {
                  /* best-effort */
                });
                return;
              }
              s.meta.set(hash, {
                savePath: row.savePath ?? undefined,
                category: row.category ?? undefined,
                name: row.name,
                userId: row.userId,
              });
            };
            if (already.ready) {
              acceptExisting();
            } else {
              const onExistingReady = () => {
                already.removeListener?.("ready", onExistingReady);
                acceptExisting();
              };
              already.on("ready", onExistingReady);
              if (already.ready) onExistingReady();
            }
            continue;
          }

          const dest =
            row.savePath?.trim() ||
            path.join(process.cwd(), "downloads");
          try {
            fs.mkdirSync(dest, { recursive: true });
          } catch {
            /* best-effort */
          }
          repairExistingLayout(dest, row.name);

          s.meta.set(hash, {
            savePath: dest,
            category: row.category ?? undefined,
            name: row.name,
            userId: row.userId,
          });

          const startupBitfield = await startupBitfieldForRow(row);
          // Prefer the cached info dictionary over the magnet. A magnet asks the
          // swarm for metadata we already have, so under network restrictions
          // `ready` never fires, the timeout below destroys this handle, and the
          // stream route answers 404 for a file sitting complete on disk —
          // which is exactly why the disk fast path never got a chance to run.
          const addInput = preferredAddInput(dest, hash, addUri);
          const t = addTorrentWithEngineDefaults(
            client,
            addInput.input,
            dest,
            undefined,
            startupBitfield ? { bitfield: startupBitfield } : {},
          );
          let settled = false;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const onError = (err: unknown) => {
            console.warn(
              `[builtin-engine] rehydrate error for ${hash}:`,
              errorMessage(err),
            );
            fail(err);
          };
          const onReady = () => {
            if (settled) return;
            if (!hasSupportedVideoPayload(t.files ?? [])) {
              fail(new InvalidCompletedMediaError());
              return;
            }
            settled = true;
            cleanup();
            const h = t.infoHash?.toLowerCase?.() || hash;
            applyPersistedStatus(t, row.status, row.origin);
            cacheTorrentMetadata(dest, h, t);
            scheduleRehydrateReadyPersist(row, t);
            observeCompletion(row.userId, t);
            s.meta.set(h, {
              savePath: dest,
              category: row.category ?? undefined,
              name: t.name || row.name,
              userId: row.userId,
            });
          };
          // I35: one settled path. Clearing the timer AND removing both listeners
          // together means a late 'error' emitted by destroy (or a 'ready' racing
          // the timeout) cannot re-enter and overwrite the diagnostics of
          // whichever outcome actually settled this torrent first.
          const cleanup = () => {
            if (timer) clearTimeout(timer);
            timer = undefined;
            t.removeListener?.("error", onError);
            t.removeListener?.("ready", onReady);
          };
          const fail = (err: unknown) => {
            if (settled) return;
            settled = true;
            cleanup();
            try {
              t.destroy?.({ destroyStore: false });
            } catch {
              /* best-effort */
            }
            s.meta.delete(hash);
            void recordRehydrateFailure(row, err).catch(() => {
              /* best-effort */
            });
          };
          timer = setTimeout(() => {
            fail(
              new Error(
                "Timed out restoring torrent metadata; the magnet may be dead or the content may be gone. Re-add the release to retry.",
              ),
            );
          }, REHYDRATE_METADATA_TIMEOUT_MS);
          t.on("error", onError);
          t.on("ready", onReady);
        } catch (err) {
          console.warn(
            `[builtin-engine] failed to re-add ${hash}:`,
            errorMessage(err),
          );
          await recordRehydrateFailure(row, err).catch(() => {
            /* best-effort */
          });
        }
      }
      succeeded = !retryNeeded;
      if (retryNeeded) {
        const retry = setTimeout(() => {
          void rehydrateFromDb(client, userId);
        }, 1_000);
        retry.unref?.();
      }
    } catch (err) {
      console.warn("[builtin-engine] rehydrate query failed", err);
    } finally {
      if (succeeded) s.rehydrated.add(key);
      s.rehydrating.delete(key);
    }
  })();

  s.rehydrating.set(key, work);
  await work;
}

async function ensureClientAndRehydrate(
  config?: ClientConnectionConfig,
): Promise<WebTorrentLike> {
  const client = await getWtClient();
  // Rehydrate for this user (or all rows if no userId) on first list/add
  await rehydrateFromDb(client, config?.userId);
  return client;
}

export function rehydrateBuiltinEngineInBackground(
  config: ClientConnectionConfig,
): void {
  setTimeout(() => {
    void ensureClientAndRehydrate(config).catch((err) => {
      console.warn(
        "[builtin-engine] background rehydrate failed",
        err instanceof Error ? err.message : err,
      );
    });
  }, 0);
}

let runtimeStartScheduled = false;
const BUILTIN_RUNTIME_RETRY_MS = 30_000;

export function startBuiltinEngineRuntime(): void {
  if (runtimeStartScheduled) return;
  runtimeStartScheduled = true;
  const timer = setTimeout(() => {
    void (async () => {
      const externalUsers = await prisma.clientSettings.findMany({
        where: { clientType: { in: ["qbittorrent", "transmission"] } },
        select: { userId: true },
      });
      const excludedUsers = new Set(externalUsers.map((row) => row.userId));
      const rows = await prisma.engineTorrent.findMany({
        where: {
          status: { notIn: ["removed", "error"] },
          OR: [{ magnet: { not: null } }, { torrentUrl: { not: null } }],
        },
        select: {
          userId: true,
          progress: true,
          status: true,
          magnet: true,
          torrentUrl: true,
          verifiedBitfield: true,
          verifiedFilesJson: true,
        },
      });
      for (const userId of new Set(
        rows
          .filter(
            (row) =>
              !excludedUsers.has(row.userId) && shouldRehydrateTorrent(row),
          )
          .map((row) => row.userId),
      )) {
        await ensureClientAndRehydrate({
          clientType: "builtin",
          host: "",
          userId,
        });
      }
    })().catch((err) => {
      runtimeStartScheduled = false;
      console.warn(
        "[builtin-engine] startup rehydrate failed",
        err instanceof Error ? err.message : err,
      );
      const retry = setTimeout(
        startBuiltinEngineRuntime,
        BUILTIN_RUNTIME_RETRY_MS,
      );
      retry.unref?.();
    });
  }, 0);
  timer.unref?.();
}

/**
 * WebTorrent's getters are not total. `get downloaded()` walks `pieces[]` and
 * dereferences each entry, but the library nulls entries out as pieces verify
 * and during teardown — so `downloaded`, and `progress`/`timeRemaining` which
 * call it, can throw `Cannot read properties of null` on a perfectly ordinary
 * torrent. Reading them bare meant a single wobbly torrent took out the whole
 * Client page with a 502, and threw from the background persist as an
 * uncaughtException. Every read of a live torrent goes through here.
 */
export function readProp<T>(read: () => T, fallback: T): T {
  try {
    const v = read();
    if (v == null) return fallback;
    if (typeof v === "number" && !Number.isFinite(v)) return fallback;
    return v;
  } catch {
    return fallback;
  }
}

type TorrentTransferMetrics = {
  at: number;
  downloaded: number;
  length: number;
  progress: number;
  remainingMs: number;
};

const TORRENT_TRANSFER_METRICS_TTL_MS = 500;
const torrentTransferMetricsCache = new WeakMap<object, TorrentTransferMetrics>();

/**
 * WebTorrent derives `downloaded`, `progress`, and `timeRemaining` by walking
 * every piece. Cache that snapshot briefly so a block event, status render, and
 * persistence request share one walk instead of repeating it on the event loop.
 */
function torrentTransferMetrics(
  t: WtTorrent,
  now = Date.now(),
): TorrentTransferMetrics {
  const cached = torrentTransferMetricsCache.get(t as object);
  if (cached && now - cached.at < TORRENT_TRANSFER_METRICS_TTL_MS) return cached;

  const length = Math.max(0, readProp(() => t.length, 0));
  const rawDownloaded = readProp<number>(
    () => t.downloaded ?? Number.NaN,
    Number.NaN,
  );
  const hasDownloaded = Number.isFinite(rawDownloaded);
  const fallbackProgress = hasDownloaded
    ? 0
    : Math.max(0, Math.min(1, readProp(() => t.progress, 0)));
  const downloaded = hasDownloaded
    ? Math.max(0, Math.min(length, rawDownloaded))
    : Math.round(length * fallbackProgress);
  const progress =
    length > 0 ? Math.max(0, Math.min(1, downloaded / length)) : fallbackProgress;
  const remainingMs = readProp(() => t.timeRemaining, 0);
  const metrics = { at: now, downloaded, length, progress, remainingMs };
  torrentTransferMetricsCache.set(t as object, metrics);
  return metrics;
}

function invalidateTorrentTransferMetrics(t: WtTorrent): void {
  torrentTransferMetricsCache.delete(t as object);
}

/**
 * Client-facing status for a live torrent, derived defensively.
 *
 * The names match qBittorrent's, because the /client page already filters on
 * them (`isDownloading`/`isSeeding`/`isPaused` in `app/client/page.tsx`) and
 * the qBittorrent adapter passes its own through untouched. One vocabulary for
 * every backend means the UI never has to know which engine it is talking to.
 *
 * Previously this collapsed everything into downloading/seeding/stalledDL,
 * which reported a torrent that was busy hash-checking 4 GB of existing data as
 * "stalledDL 0.0%" — indistinguishable from a dead swarm, and the single most
 * misleading thing on the page after a restart.
 */
/**
 * True when the torrent actually holds every piece.
 *
 * Not `t.done`: WebTorrent latches per-file `done` and never re-evaluates it
 * (`_checkDone`, torrent.js:2028), so the torrent-level flag sticks at the
 * optimistic high-water mark even after `_markUnverified` clears bits on a
 * failed hash check. `progress` is recomputed from the bitfield on every read.
 */
function everyPieceVerified(t: WtTorrent): boolean {
  const pieces = readProp(() => t.pieces, undefined);
  const get = readProp(() => t.bitfield?.get, undefined);
  if (!Array.isArray(pieces) || pieces.length === 0 || typeof get !== "function") {
    return false;
  }
  for (let index = 0; index < pieces.length; index += 1) {
    if (!get.call(t.bitfield, index)) return false;
  }
  return true;
}

function isComplete(t: WtTorrent): boolean {
  const atCompleteProgress =
    torrentTransferMetrics(t).progress >= DOWNLOAD_COMPLETE_PROGRESS;
  if (!atCompleteProgress) return false;
  const verified = everyPieceVerified(t);
  // Observational only: the return value below is unchanged either way. This
  // just makes the "100% but the bitfield disagrees" case leave a record the
  // first time it happens for a hash, instead of being silently invisible.
  noteCompletionVerificationGap(
    readProp(() => t.infoHash, ""),
    atCompleteProgress,
    verified,
  );
  return verified;
}

export function torrentStatus(t: WtTorrent): string {
  if (isComplete(t)) return "downloaded";
  if (readProp(() => t.paused, false)) return "paused";

  // `ready` flips only after existing data has been hash-checked, so anything
  // before it is work in progress, not a stall. Metadata arrives first, so its
  // presence separates "still finding the .torrent" from "checking files".
  if (!readProp(() => t.ready, true)) {
    const hasMetadata = readProp(() => (t.pieces?.length ?? 0) > 0, false);
    return hasMetadata ? "checkingDL" : "metaDL";
  }

  const peers = readProp(() => t.numPeers, 0);

  // `t.done` cannot be trusted here — see {@link isComplete}. Observed live:
  // three torrents reporting `done` at 47–52% progress, drawn as "Seeding"
  // while they were still missing half their data.
  return peers > 0 ? "downloading" : "stalledDL";
}

export function mapTorrent(
  t: WtTorrent,
  extra?: TorrentMeta,
): ClientTorrent {
  const metrics = torrentTransferMetrics(t);
  const st = torrentStatus(t);
  const files = readProp(() => t.files, undefined);
  const playable =
    readProp(() => t.ready, false) && Array.isArray(files)
      ? hasSupportedVideoPayload(files)
      : undefined;
  const remainingMs = metrics.remainingMs;
  const eta =
    remainingMs > 0 && remainingMs < 8640000 * 1000
      ? Math.round(remainingMs / 1000)
      : undefined;

  return {
    hash: t.infoHash,
    name: readProp(() => t.name, "") || extra?.name || t.infoHash,
    progress: metrics.progress,
    sizeBytes: metrics.length,
    dlspeed: readProp(() => t.downloadSpeed, 0),
    upspeed: readProp(() => t.uploadSpeed, 0),
    state: st,
    playable,
    eta,
    peers: readProp(() => t.numPeers, 0),
    category: extra?.category,
    savePath: extra?.savePath || readProp(() => t.path, "") || null,
  };
}

export type BuiltinTorrentPresence = "present" | "absent" | "unknown";

/**
 * Availability probe with a non-blocking warm-up. It may start the normal
 * rehydrate path, but never waits for it. Until this user's rehydrate pass has
 * finished, absence is not evidence; during that cold-start window callers must
 * use `unknown`, not turn Play off.
 */
export function getBuiltinTorrentPresenceForAvailability(
  userId: string,
  hash: string,
): BuiltinTorrentPresence {
  const normalizedHash = hash.toLowerCase().trim();
  if (!normalizedHash) return "unknown";

  const s = state();
  if (!s.client || s.loading) return "unknown";

  return findTorrent(s.client, normalizedHash) ? "present" : "absent";
}

/** Hashes this user may see/control (meta + durable EngineTorrent rows). */
async function allowedHashesForUser(userId: string): Promise<Set<string>> {
  const s = state();
  const allowed = new Set<string>();
  for (const [hash, m] of s.meta) {
    if (m.userId === userId) allowed.add(hash.toLowerCase());
  }
  try {
    const rows = await prisma.engineTorrent.findMany({
      where: { userId, status: { not: "removed" } },
      select: { hash: true },
    });
    for (const r of rows) allowed.add(r.hash.toLowerCase());
  } catch {
    /* table may be missing until db push */
  }
  return allowed;
}

/**
 * Locate a live torrent by info-hash.
 * WebTorrent 3 made `client.get()` async (returns a Promise). Calling it
 * without await made pause/resume/delete see a Promise → "t.destroy is not a function".
 * Scanning `client.torrents` is sync and reliable for hex info hashes.
 */
function findTorrent(
  client: WebTorrentLike,
  hash: string,
): WtTorrent | undefined {
  return findTorrentByHash(client.torrents, hash);
}

/**
 * The live WebTorrent client, for the swarm probe.
 *
 * Returns the same patched singleton every other add path uses, so a probe's
 * `addTorrentWithEngineDefaults` inherits the private-swarm tracker rule, the
 * wire-encryption/metadata-race patches, and the µTP-off setting. A probe must
 * never construct its own `new WebTorrent()` — that would bypass all of it.
 */
export async function getBuiltinClientForProbe(): Promise<
  Pick<WebTorrentLike, "add" | "torrents">
> {
  return getWtClient();
}

/**
 * A live torrent the engine already holds, or null.
 *
 * The probe consults this before attaching to anything: if the info-hash is
 * already a real download, the probe must read that torrent's live figures and
 * must **never** add or destroy it. Destroying it would delete a user's
 * download. Sync `findTorrent` scan (never `client.get()`, which is async).
 */
export function findLiveBuiltinTorrent(hash: string): WtTorrent | null {
  const s = state();
  if (!s.client) return null;
  const normalized = hash.trim().toLowerCase();
  if (!normalized) return null;
  return findTorrent(s.client, normalized) ?? null;
}

export function acquireBuiltinStreamLease(infoHash: string): () => void {
  const hash = infoHash.trim().toLowerCase();
  const s = state();
  s.streamLeases.set(hash, (s.streamLeases.get(hash) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = Math.max(0, (s.streamLeases.get(hash) ?? 1) - 1);
    if (remaining > 0) {
      s.streamLeases.set(hash, remaining);
      return;
    }
    s.streamLeases.delete(hash);
    const waiters = s.streamLeaseWaiters.get(hash);
    s.streamLeaseWaiters.delete(hash);
    for (const resolve of waiters ?? []) resolve();
  };
}

const STREAM_LEASE_RELEASE_WAIT_MS = 15_000;
let streamLeaseReleaseWaitMsOverrideForTests: number | null = null;

async function waitForBuiltinStreamLeases(infoHash: string): Promise<void> {
  const hash = infoHash.trim().toLowerCase();
  const s = state();
  if ((s.streamLeases.get(hash) ?? 0) === 0) return;
  await new Promise<void>((resolve, reject) => {
    const waiters = s.streamLeaseWaiters.get(hash) ?? new Set();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const currentWaiters = s.streamLeaseWaiters.get(hash);
      currentWaiters?.delete(onReleased);
      if (currentWaiters?.size === 0) s.streamLeaseWaiters.delete(hash);
      if (err) reject(err);
      else resolve();
    };
    const onReleased = () => finish();
    waiters.add(onReleased);
    s.streamLeaseWaiters.set(hash, waiters);
    const timeoutMs =
      streamLeaseReleaseWaitMsOverrideForTests ?? STREAM_LEASE_RELEASE_WAIT_MS;
    timer = setTimeout(() => {
      finish(new Error(`stream lease did not release within ${timeoutMs}ms`));
    }, timeoutMs);
    if (streamLeaseReleaseWaitMsOverrideForTests === null) timer.unref?.();
    if ((s.streamLeases.get(hash) ?? 0) === 0) finish();
  });
}

export function configureBuiltinStreamLeaseWaitForTests(
  timeoutMs: number | null,
): void {
  streamLeaseReleaseWaitMsOverrideForTests = timeoutMs;
}

export async function waitForBuiltinStreamLeasesForTests(
  infoHash: string,
): Promise<void> {
  await waitForBuiltinStreamLeases(infoHash);
}

/**
 * Stop a stream-only torrent from pulling pieces once the player closes.
 *
 * A stream is an evictable cache of what is on screen, not a download the user
 * asked to keep; when the viewer closes the player we must not keep pulling it
 * into their storage without consent. Deselecting the files stops WebTorrent
 * requesting pieces, while the torrent stays in the client so a later Play can
 * re-select and resume from whatever already landed on disk.
 *
 * Clearing the stream-priority bookkeeping is load-bearing:
 * `prioritizeBuiltinStreamFile` short-circuits when its recorded selection
 * already matches the request and only re-marks pieces critical — it does not
 * re-`select` them. After a raw deselect that path would leave the file with no
 * selection and the resume would stall. Dropping the entry forces the next Play
 * to make a fresh selection.
 *
 * Returns true when a live torrent was found and parked.
 */
export function parkBuiltinStreamTorrent(infoHash: string): boolean {
  const torrent = findLiveBuiltinTorrent(infoHash);
  if (!torrent) return false;
  deselectAllFiles(torrent);
  prioritizedStreamFiles.delete(torrent as object);
  prioritizedEdgePrefetches.delete(torrent as object);
  return true;
}

export type BuiltinStreamFile = WtFile;
export type BuiltinStreamTorrent = Pick<
  WtTorrent,
  | "infoHash"
  | "name"
  | "progress"
  | "downloadSpeed"
  | "numPeers"
  | "files"
  | "emit"
  | "listenerCount"
> & {
  /**
   * Total byte length and absolute bytes fetched so far — the honest,
   * monotonic byte-progress signal the stream stall guard samples (I45/I44).
   * Optional so existing FakeTorrent fixtures that predate the guard still
   * satisfy this type; the sampler treats `undefined` as "no reading yet".
   */
  length?: number;
  downloaded?: number;
};

export type BuiltinStreamLookup =
  | { status: "found"; torrent: BuiltinStreamTorrent; file: BuiltinStreamFile }
  | { status: "not_found" }
  | { status: "metadata_pending"; torrent: BuiltinStreamTorrent };

function normalizeTorrentFilePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\/+/, "");
}

/**
 * Look up a live built-in torrent file for streaming.
 *
 * This intentionally scans the live WebTorrent client's `torrents` array with
 * `findTorrentByHash`; WebTorrent 3's `client.get()` is async and unsafe to use
 * as a synchronous handle.
 */
export async function findBuiltinTorrentFile(
  config: ClientConnectionConfig,
  hash: string,
  filePath?: string,
): Promise<BuiltinStreamLookup> {
  const client = await ensureClientAndRehydrate(config);
  return lookupBuiltinTorrentFile(client, config, hash, filePath);
}

export async function findLiveBuiltinTorrentFile(
  config: ClientConnectionConfig,
  hash: string,
  filePath?: string,
): Promise<BuiltinStreamLookup> {
  const client = state().client;
  if (!client) return { status: "not_found" };
  return lookupBuiltinTorrentFile(client, config, hash, filePath);
}

async function lookupBuiltinTorrentFile(
  client: WebTorrentLike,
  config: ClientConnectionConfig,
  hash: string,
  filePath?: string,
): Promise<BuiltinStreamLookup> {
  const normalizedHash = hash.toLowerCase().trim();
  const torrent = findTorrentByHash(client.torrents, normalizedHash);
  if (!torrent) return { status: "not_found" };

  const uid = config.userId?.trim() || null;
  if (uid) {
    const allowed = await allowedHashesForUser(uid);
    if (!allowed.has(normalizedHash)) return { status: "not_found" };
  }

  const files = torrent.files ?? [];
  if (files.length === 0) return { status: "metadata_pending", torrent };
  if (!filePath) return { status: "found", torrent, file: files[0] };

  const wanted = normalizeTorrentFilePath(filePath);
  const file = files.find((f) => normalizeTorrentFilePath(f.path) === wanted);
  return file
    ? { status: "found", torrent, file }
    : { status: "not_found" };
}

export const BUILTIN_STREAM_EDGE_PREFETCH_BYTES = 2 * 1024 * 1024;

async function drainBuiltinFileRange(
  torrent: BuiltinStreamTorrent,
  file: BuiltinStreamFile,
  range: { start: number; end: number },
  timeoutMs: number,
): Promise<void> {
  const stream = file.stream(range);
  const reader = stream.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error("prefetch stalled"));
      }, timeoutMs);
    });
    for (;;) {
      const next = await Promise.race([reader.read(), timeout]);
      if (next.done) return;
    }
  } finally {
    if (timer) clearTimeout(timer);
    if (timedOut) {
      const cancel = reader.cancel("prefetch stalled").catch(() => undefined);
      try {
        torrent.emit?.("verified", -1);
      } catch {
        /* best-effort */
      }
      await Promise.race([
        cancel,
        new Promise((resolve) => setTimeout(resolve, 25)),
      ]);
    } else {
      reader.releaseLock();
    }
  }
}

/**
 * Pull the file's first and last bytes into WebTorrent's piece selector.
 * Chromium usually probes the tail first for MP4 `moov` / MKV `Cues`; without
 * this a barely-started large file can appear to spin forever.
 *
 * Drain the head before the tail so the Cues prefetch cannot compete with the
 * bytes needed for the first frame.
 */
export async function prefetchBuiltinFileEdges(
  torrent: BuiltinStreamTorrent,
  file: BuiltinStreamFile,
  opts: {
    bytes?: number;
    timeoutMs?: number;
  } = {},
): Promise<void> {
  const bytes = Math.max(1, Math.floor(opts.bytes ?? BUILTIN_STREAM_EDGE_PREFETCH_BYTES));
  const timeoutMs = Math.max(1, Math.floor(opts.timeoutMs ?? 15_000));
  const lastByte = Math.max(0, file.length - 1);
  const headEnd = Math.min(lastByte, bytes - 1);
  await drainBuiltinFileRange(torrent, file, { start: 0, end: headEnd }, timeoutMs);
  if (file.length > bytes) {
    await drainBuiltinFileRange(
      torrent,
      file,
      { start: Math.max(0, file.length - bytes), end: lastByte },
      timeoutMs,
    );
  }
}

/** Destroy a live torrent; rejects with a clear message if handle is invalid. */
function destroyLiveTorrent(
  t: WtTorrent,
  deleteFiles: boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!t || typeof t.destroy !== "function") {
      reject(
        new Error(
          "Torrent handle is not a live WebTorrent instance (cannot destroy)",
        ),
      );
      return;
    }

    try {
      const hash = readProp(() => t.infoHash, "");
      const savePath = readProp(() => t.path, "");
      t.destroy({ destroyStore: deleteFiles }, (err) => {
        if (err) {
          reject(err);
          return;
        }
        // Only give up the claim once the files are actually gone, and only
        // for the destination that was deleted — the same torrent may still
        // have a copy somewhere else whose files must stay protected.
        if (deleteFiles && hash) releasePaths(hash, savePath || undefined);
        resolve();
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function quiesceCompletedTorrent(t: WtTorrent): void {
  try {
    t.pause();
  } catch {
    // Destroy remains the authoritative cleanup.
  }
  for (const wire of readProp(() => t.wires, []) ?? []) {
    try {
      wire.destroy?.();
    } catch {
      // Continue disconnecting the remaining peers.
    }
  }
  for (const peer of (readProp(() => t._peers, new Map()) ?? new Map()).values()) {
    try {
      peer.destroy?.();
    } catch {
      // Continue disconnecting the remaining peers.
    }
  }
}

function scheduleIdleClientDestroy(): void {
  const s = state();
  if (s.idleDestroyTimer || !s.client || s.client.torrents.length > 0) return;
  const timer = setTimeout(() => {
    s.idleDestroyTimer = null;
    const client = s.client;
    if (!client || client.torrents.length > 0) return;
    s.client = null;
    s.loading = null;
    // This is the same engine-generation boundary as explicit shutdown. A
    // fresh client must rehydrate again and must not inherit owners/cooldowns
    // from the destroyed instance.
    resetEngineBookkeeping(s);
    client.destroy((err) => {
      if (err) {
        console.warn(
          "[builtin-engine] failed to destroy idle WebTorrent client:",
          errorMessage(err),
        );
      }
    });
  }, 2_000);
  timer.unref?.();
  s.idleDestroyTimer = timer;
}

async function assertOwnsTorrent(
  config: ClientConnectionConfig,
  hash: string,
): Promise<boolean> {
  if (!config.userId?.trim()) return true;
  const allowed = await allowedHashesForUser(config.userId.trim());
  return allowed.has(hash.toLowerCase());
}

type ProgressSnapshot = {
  progress: number;
  sizeBytes: bigint;
  status: string;
  name: string | undefined;
};

const progressSnapshotScheduler = createSnapshotScheduler<string, ProgressSnapshot>({
  intervalMs: 5_000,
  persist: async (key, snapshot) => {
    const separator = key.indexOf(":");
    const userId = key.slice(0, separator);
    const hash = key.slice(separator + 1);
    await prisma.engineTorrent.updateMany({
      where: { userId, hash },
      data: snapshot,
    });
  },
});

/** Best-effort throttled progress snapshot from engine events. */
function scheduleProgressPersist(
  userId: string | null | undefined,
  t: WtTorrent,
  status: string,
): void {
  if (!userId?.trim()) return;
  const hash = t.infoHash?.toLowerCase?.();
  if (!hash) return;
  const uid = userId.trim();
  const metrics = torrentTransferMetrics(t);
  progressSnapshotScheduler.schedule(`${uid}:${hash}`, {
    progress: metrics.progress,
    sizeBytes: BigInt(
      Math.floor(metrics.length),
    ),
    status,
    name: readProp(() => t.name, "") || undefined,
  });
}

/**
 * Persist the final verified snapshot durably before releasing WebTorrent.
 *
 * A completed download is a local media file, not an indefinitely live seed.
 * The DB/filesystem become the source of truth and WebTorrent is destroyed with
 * `destroyStore:false`, preserving every byte while releasing trackers, peers,
 * piece caches, sockets and file handles.
 */
async function persistAndParkCompletedTorrent(
  userId: string,
  t: WtTorrent,
): Promise<boolean> {
  if (!isComplete(t)) return false;
  const hash = t.infoHash?.toLowerCase?.();
  if (!hash) return false;

  const key = hash;
  const s = state();
  const existing = s.parking.get(key);
  if (existing) return existing;
  const admission = decideCompletionParkingAdmission({
    leases: s.streamLeases.get(hash) ?? 0,
    activeParking: s.parking.size,
  });
  if (admission !== "start") return false;

  const work = (async () => {
    if (!isComplete(t)) return false;
    const afterDetach = () => {
      state().meta.delete(hash);
      const retry = state().parkingRetryTimers.get(key);
      if (retry) clearTimeout(retry);
      state().parkingRetryTimers.delete(key);
      scheduleIdleClientDestroy();
    };
    let ownerIds = [userId];
    let finalized: boolean;
    try {
      finalized = await finalizeCompletedDownload({
        quiesce: () => quiesceCompletedTorrent(t),
        drainSnapshots: async () => {
          const owners = await prisma.engineTorrent.findMany({
            where: { hash },
            select: { userId: true },
          });
          ownerIds = [...new Set([userId, ...owners.map((row) => row.userId)])];
          await Promise.all(
            ownerIds.map((ownerId) =>
              progressSnapshotScheduler.cancelAndDrain(`${ownerId}:${hash}`),
            ),
          );
        },
        buildManifest: () => validatedPersistedVerifiedState(t),
        persistManifest: async (verified) => {
          const [updated] = await prisma.$transaction([
            prisma.engineTorrent.updateMany({
              where: { hash },
              data: {
                progress: 1,
                status: "downloaded",
                error: null,
                sizeBytes: BigInt(
                  Math.max(0, Math.floor(readProp(() => t.length, 0))),
                ),
                name: readProp(() => t.name, "") || undefined,
                verifiedBitfield: verified.verifiedBitfield,
                verifiedFilesJson: verified.verifiedFilesJson,
                verifiedAt: new Date(),
              },
            }),
            prisma.acquisitionTarget.updateMany({
              where: {
                infoHash: { in: [hash, hash.toUpperCase()] },
                status: { in: ["queued", "downloading"] },
              },
              data: { progress: 1, status: "downloaded", error: null },
            }),
          ]);
          if (updated.count < 1) {
            throw new Error("completion manifest did not match a durable torrent row");
          }
        },
        detachPreservingFiles: async () => {
          await waitForBuiltinStreamLeases(hash);
          await destroyLiveTorrent(t, false);
        },
        afterDetach,
      });
    } catch (err) {
      if (!(err instanceof InvalidCompletedMediaError)) throw err;
      const [updated] = await prisma.$transaction([
        prisma.engineTorrent.updateMany({
          where: { hash },
          data: {
            progress: 1,
            status: "error",
            error: INVALID_COMPLETED_MEDIA_MESSAGE,
          },
        }),
        prisma.acquisitionTarget.updateMany({
          where: { infoHash: { in: [hash, hash.toUpperCase()] } },
          data: {
            progress: 0,
            status: "failed",
            error: INVALID_COMPLETED_MEDIA_MESSAGE,
          },
        }),
      ]);
      if (updated.count < 1) {
        throw new Error("invalid media result did not match a durable torrent row");
      }
      await waitForBuiltinStreamLeases(hash);
      await destroyLiveTorrent(t, false);
      afterDetach();
      console.warn(`[builtin-engine] rejected completed non-media payload ${hash}`);
      return true;
    }
    if (!finalized) {
      throw new Error("completed torrent manifest is not yet durable");
    }
    return true;
  })()
    .catch((err) => {
      console.warn(
        `[builtin-engine] failed to park completed torrent ${hash}:`,
        errorMessage(err),
      );
      if (!state().parkingRetryTimers.has(key)) {
        const timer = setTimeout(() => {
          state().parkingRetryTimers.delete(key);
          void persistAndParkCompletedTorrent(userId, t);
        }, 30_000);
        timer.unref?.();
        state().parkingRetryTimers.set(key, timer);
      }
      return false;
    })
    .finally(() => {
      state().parking.delete(key);
    });

  state().parking.set(key, work);
  return work;
}

function observeCompletion(
  userId: string | null | undefined,
  t: WtTorrent,
): void {
  const uid = userId?.trim();
  if (!uid || state().completionObserved.has(t as object)) return;
  state().completionObserved.add(t as object);

  let lastCheckAt = 0;
  const check = (force = false) => {
    const now = Date.now();
    if (!force && now - lastCheckAt < 1_000) return;
    lastCheckAt = now;
    invalidateTorrentTransferMetrics(t);
    if (isComplete(t)) {
      void persistAndParkCompletedTorrent(uid, t);
      return;
    }
    scheduleProgressPersist(uid, t, torrentStatus(t));
  };
  t.on("download", () => check());
  t.on("verified", () => check());
  t.on("done", () => check(true));
  check(true);
}

function defaultDownloadRoot(config: ClientConnectionConfig): string {
  const root =
    config.baseDownloadPath?.trim() ||
    config.savePath?.trim() ||
    path.join(process.cwd(), "downloads");
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/**
 * Lines up whatever is already on disk with the flat paths the engine now
 * uses. Folders downloaded before the layout rewrite — and any pack that
 * nested its release name more than once — sit one or two levels too deep, so
 * a resumed torrent would find nothing and re-download from zero.
 *
 * Call this only before the torrent is added: at that point nothing holds a
 * file handle, which is what makes the rename safe.
 */
function repairExistingLayout(dest: string, torrentName?: string | null): void {
  try {
    const { moved, roots, renamed } = repairContentLayout(dest, torrentName);
    if (moved > 0) {
      console.info(
        `[builtin-engine] repaired nested layout in ${dest} — lifted ${moved} entr${
          moved === 1 ? "y" : "ies"
        } out of ${roots.map((r) => `"${r}"`).join(" / ")}`,
      );
    }
    if (renamed.length > 0) {
      console.info(
        `[builtin-engine] renamed season folders in ${dest} — ${renamed.join(", ")}`,
      );
    }
  } catch (err) {
    console.warn(
      "[builtin-engine] layout repair failed",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * There is deliberately NO post-download flatten.
 *
 * `done` means every piece verified, not that the chunk store closed its
 * handles — the torrent goes straight on to seed from exactly those paths.
 * Renaming underneath a live store fails outright on Windows, and on Linux
 * succeeds while leaving every reopened read pointing at a path that no longer
 * exists, which silently breaks seeding.
 *
 * That was true even in the "already complete when added" case: WebTorrent
 * verified those bytes and is serving them.
 *
 * So the on-disk repair only ever runs *before* `client.add()`, in
 * {@link repairExistingLayout}, which is the one moment nothing holds a
 * handle. A torrent that lands nested because the prototype patch could not be
 * applied stays nested until the next add or restart. Nested is survivable;
 * a broken seed is not.
 */

/**
 * The absolute file paths this torrent owns on disk, read before its row is
 * deleted. Prefers `verifiedFilesJson` (absolute paths the engine wrote after
 * every file verified), and supplements with the live torrent's own file paths
 * when a handle is still present. This is the evidence a delete needs to remove
 * real bytes even when nothing is live in memory.
 */
async function ownedFilesForDelete(
  config: ClientConnectionConfig,
  hashLower: string,
  live: WtTorrent | undefined,
): Promise<{ files: string[]; savePath: string | null }> {
  const files = new Set<string>();
  let savePath: string | null = null;

  try {
    const row = await prisma.engineTorrent.findFirst({
      where: config.userId
        ? { userId: config.userId, hash: hashLower }
        : { hash: hashLower },
      select: { savePath: true, verifiedFilesJson: true },
    });
    savePath = row?.savePath?.trim() || null;
    if (row?.verifiedFilesJson?.trim()) {
      try {
        const parsed = JSON.parse(row.verifiedFilesJson) as unknown;
        if (Array.isArray(parsed)) {
          for (const entry of parsed) {
            const p = (entry as { path?: unknown })?.path;
            if (typeof p === "string" && p.trim()) files.add(p.trim());
          }
        }
      } catch {
        /* a malformed list contributes nothing rather than a partial delete */
      }
    }
  } catch {
    /* DB optional — fall back to whatever the live handle can tell us */
  }

  if (live && Array.isArray(live.files)) {
    for (const file of live.files) {
      const disk = torrentFileDiskPath(live, file);
      if (disk) files.add(disk);
    }
  }

  return { files: [...files], savePath };
}

/**
 * Paths still owned by OTHER non-removed torrents, so a shared category/show
 * directory is never removed out from under a sibling download.
 */
async function otherOwnedPaths(
  config: ClientConnectionConfig,
  hashLower: string,
): Promise<string[]> {
  try {
    const rows = await prisma.engineTorrent.findMany({
      where: { hash: { not: hashLower }, status: { not: "removed" } },
      select: { savePath: true, verifiedFilesJson: true },
      take: 2000,
    });
    const out: string[] = [];
    for (const row of rows) {
      const sp = row.savePath?.trim();
      if (sp) out.push(sp);
      if (!row.verifiedFilesJson?.trim()) continue;
      try {
        const parsed = JSON.parse(row.verifiedFilesJson) as unknown;
        if (Array.isArray(parsed)) {
          for (const entry of parsed) {
            const p = (entry as { path?: unknown })?.path;
            if (typeof p === "string" && p.trim()) out.push(p.trim());
          }
        }
      } catch {
        /* skip malformed */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Remove a deleted release's files and, when it created its own folder, that
 * folder — sidecar junk included — while refusing to touch a shared parent.
 *
 * Best-effort by design: this runs on the delete path, so a locked file or a
 * missing base must never turn into a thrown error that aborts the delete.
 */
async function removeReleaseFilesFromDisk(
  config: ClientConnectionConfig,
  hashLower: string,
  savePath: string | null,
  ownedFiles: readonly string[],
  baseRoot: string,
): Promise<void> {
  try {
    const otherPaths = await otherOwnedPaths(config, hashLower);
    const plan = planReleaseRemoval({
      ownedFiles,
      savePath,
      baseRoot,
      otherPaths,
    });
    const result = executeReleaseRemoval(plan);
    if (result.removed.length || result.folderRemoved) {
      console.info(
        `[builtin-engine] removed release files: ${result.removed.length} file(s)` +
          `${result.folderRemoved ? `, folder ${result.folderRemoved}` : ""}` +
          ` (${result.freedBytes} bytes)`,
      );
    } else if (plan.folderReason && ownedFiles.length) {
      console.info(
        `[builtin-engine] kept release folder (${plan.folderReason}); removed only recorded files`,
      );
    }
  } catch (err) {
    console.warn(
      "[builtin-engine] release file removal failed",
      err instanceof Error ? err.message : err,
    );
  }
}

export class BuiltinClient implements TorrentClientAdapter {
  readonly type = "builtin" as const;

  async testConnection(
    config: ClientConnectionConfig,
  ): Promise<AddTorrentResult> {
    try {
      await ensureClientAndRehydrate(config);
      const root = defaultDownloadRoot(config);
      return {
        ok: true,
        message: `Built-in engine ready · download root ${root}`,
      };
    } catch (err) {
      return {
        ok: false,
        message:
          err instanceof Error
            ? err.message
            : "Built-in engine failed to start",
      };
    }
  }

  async addTorrent(
    config: ClientConnectionConfig,
    payload: AddTorrentPayload,
  ): Promise<AddTorrentResult> {
    const uri = selectBuiltinAddUri(payload);
    if (!uri) {
      return { ok: false, message: "No magnet or torrent URL provided" };
    }

    try {
      const client = await ensureClientAndRehydrate(config);
      const dest =
        payload.savePath?.trim() ||
        defaultDownloadRoot(config);

      const space = await checkStoragePolicy(
        config,
        dest,
        null,
        payload.overrideStorageCap,
      );
      if (!space.ok) {
        return { ok: false, message: space.message };
      }

      fs.mkdirSync(dest, { recursive: true });

      const addUri = uri.trim();
      const existingHash =
        extractInfoHash(payload.magnet || "") ||
        extractInfoHash(payload.torrentUrl || "") ||
        extractInfoHash(addUri);
      if (config.userId && existingHash) {
        const knownBad = await prisma.engineTorrent.findUnique({
          where: {
            userId_hash: {
              userId: config.userId,
              hash: existingHash.toLowerCase(),
            },
          },
          select: { status: true, error: true },
        });
        if (
          knownBad?.status === "error" &&
          knownBad.error === INVALID_COMPLETED_MEDIA_MESSAGE
        ) {
          return {
            ok: false,
            message: "That release was already rejected because it contains no playable video.",
          };
        }
      }
      // Resolve intent → mechanism ONCE, from the stated purpose plus the origin
      // already on disk. This is where issue A (never halt a kept download) and
      // issue B (monotonic origin transitions) are enforced.
      const existingOrigin = await lookupExistingOrigin(config.userId, existingHash);
      const eff = resolveEffectiveAdd(payload.purpose, existingOrigin);
      if (eff.degraded) {
        console.warn(
          `[builtin-engine] add purpose="${payload.purpose}" hash=${existingHash || "?"} ` +
            `existing=${existingOrigin.status} → degraded; not converting silently ` +
            `(selection=${eff.selection}, birthOrigin=${eff.birthOrigin})`,
        );
      }
      if (existingHash) {
        const normalizedExistingHash = existingHash.toLowerCase();
        let existing = findTorrent(client, normalizedExistingHash);
        if (existing && !state().meta.has(normalizedExistingHash)) {
          await waitForUnownedHandleRelease(
            client,
            existing,
            normalizedExistingHash,
          );
          existing = findTorrent(client, normalizedExistingHash);
        }
        if (existing && !state().meta.has(normalizedExistingHash)) {
          return {
            ok: false,
            message: "That release is still being checked. Try again in a moment.",
          };
        }
        if (existing) {
          const hash = (
            existing.infoHash ||
            existingHash ||
            ""
          ).toLowerCase();
          if (!hash) {
            return {
              ok: false,
              message: "Existing torrent has no info hash",
            };
          }
          // Resume / re-select files — "already added" was leaving stalled torrents idle
          applyAddSelection(existing, eff.selection, eff.capPeers);
          state().meta.set(hash, {
            savePath: dest,
            category: payload.category ?? undefined,
            name: payload.name || existing.name,
            userId: config.userId ?? undefined,
          });
          if (config.userId) {
            await upsertEngineTorrent({
              userId: config.userId,
              hash,
              name: payload.name || existing.name || hash,
              magnet: magnetForPersist(payload, addUri, existing),
              torrentUrl: payload.torrentUrl?.trim() || null,
              savePath: dest,
              category: payload.category,
              status: isComplete(existing) ? "downloaded" : "downloading",
              progress: readProp(() => existing.progress, 0),
              sizeBytes: readProp(() => existing.length, 0),
              torrent: existing,
              birthOrigin: eff.birthOrigin,
              promoteTo: eff.promoteTo,
              promoteFrom: eff.promoteFrom,
            });
            const completed = isComplete(existing);
            if (completed) {
              void persistAndParkCompletedTorrent(config.userId, existing);
            } else {
              observeCompletion(config.userId, existing);
            }
            if (completed) {
              return {
                ok: true,
                message: "",
                details: {
                  type: "builtin-transfer",
                  action: "already_complete",
                  pct: 100,
                  peers: 0,
                },
              };
            }
          }
          const peers = readProp(() => existing.numPeers, 0);
          const pct = Math.round(readProp(() => existing.progress, 0) * 100);
          return {
            ok: true,
            message: "",
            details: {
              type: "builtin-transfer",
              action: isComplete(existing)
                ? "already_complete"
                : "already_downloading",
              pct,
              peers,
            },
          };
        }
      }

      const torrent = await new Promise<WtTorrent>((resolve, reject) => {
        // Existing bytes may still sit under a release root from before the
        // layout rewrite. Lift them now, while nothing has the files open.
        repairExistingLayout(dest, payload.name);
        // Taken *before* the add so that anything appearing under `dest`
        // afterwards is unambiguously this add's own preallocation. Without it
        // a failed add cannot tell its own full-length placeholder apart from
        // media the owner already had.
        const existedBefore = snapshotAllocation(dest);
        let settled = false;
        // A magnet that never resolves metadata stays in client.torrents
        // forever unless we destroy it, leaking handles/sockets and showing up
        // as a permanent "Fetching metadata…" row.
        const holder: { t?: WtTorrent } = {};
        const reap = () => {
          // WebTorrent preallocates every file at full length as soon as
          // metadata parses — which routinely happens on the way to a timeout.
          // `destroyStore: false` alone abandoned that allocation with no
          // EngineTorrent row to reach it by, so every failed add leaked its
          // whole size. Release exactly what this add created, and nothing the
          // owner already had, before tearing the handle down.
          const t = holder.t;
          if (!t) return;
          try {
            const released = releaseFailedAllocation(
              t as unknown as AllocationTorrent,
              existedBefore,
            );
            if (released.freedBytes > 0) {
              console.warn(
                `[builtin-engine] released ${released.freedBytes} bytes from a failed add ` +
                  `(${released.removed.length} file(s); kept ${released.keptPreexisting} pre-existing)`,
              );
              invalidateDirectorySizeCache();
            }
          } catch {
            /* best-effort */
          }
          try {
            t.destroy?.({ destroyStore: false });
          } catch {
            /* best-effort */
          }
        };
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reap();
          reject(
            new Error(
              "Timed out waiting for torrent metadata (no peers / blocked DHT?). Try another release or check network.",
            ),
          );
        }, 90_000);
        const t = addTorrentWithEngineDefaults(client, addUri, dest, (ready) => {
          if (settled) return;
          const validation = validateTorrentMediaPayload(ready.files ?? []);
          if (!validation.ok) {
            settled = true;
            clearTimeout(timer);
            holder.t = ready;
            reap();
            reject(new Error(validation.message));
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve(ready);
        }, eff.selection === "deselect" ? { deselect: true } : {});
        if (eff.capPeers) enforcePrewarmPeerCap(t);
        holder.t = t;
        t.on("error", (err: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reap();
          reject(err instanceof Error ? err : new Error(String(err)));
        });
      });

      // Metadata ready. Download selects every file and keeps them; stream-only
      // and connect-only prewarm stay deselected so only the pieces the player
      // (or nothing, for prewarm) explicitly selects are ever fetched. `leave`
      // (a kept download re-added, or an unreadable origin) keeps WebTorrent's
      // default whole-file selection without us forcing it either way.
      applyAddSelection(torrent, eff.selection, eff.capPeers);

      const hash = (torrent.infoHash || existingHash || "").toLowerCase();
      if (!hash) {
        return {
          ok: false,
          message:
            "Torrent metadata ready but info hash missing — try again or use a different magnet",
        };
      }
      state().meta.set(hash, {
        savePath: dest,
        category: payload.category ?? undefined,
        name: payload.name || torrent.name,
        userId: config.userId ?? undefined,
      });
      // Metadata resolved. Cache it now so this release can be brought back
      // into the engine — and played from disk — with no swarm at all.
      cacheTorrentMetadata(dest, hash, torrent);

      // Multi-file → often savePath/torrentName/…; flatten junk root when done

      if (config.userId) {
        const transferMetrics = torrentTransferMetrics(torrent);
        const completed = isComplete(torrent);
        await upsertEngineTorrent({
          userId: config.userId,
          hash,
          name: payload.name || torrent.name || hash,
          magnet: magnetForPersist(payload, addUri, torrent),
          torrentUrl: payload.torrentUrl?.trim() || null,
          savePath: dest,
          category: payload.category,
          status: completed ? "downloaded" : "downloading",
          progress: transferMetrics.progress,
          sizeBytes: transferMetrics.length,
          torrent,
          birthOrigin: eff.birthOrigin,
          promoteTo: eff.promoteTo,
          promoteFrom: eff.promoteFrom,
        });
        if (completed) {
          void persistAndParkCompletedTorrent(config.userId, torrent);
        } else {
          observeCompletion(config.userId, torrent);
        }
        if (completed) {
          return {
            ok: true,
            message: "",
            details: {
              type: "builtin-transfer",
              action: "already_complete",
              pct: 100,
              peers: 0,
            },
          };
        }
      }

      // Verify still in live client (defensive)
      const live = findTorrent(client, hash);
      if (!live) {
        return {
          ok: false,
          message:
            "Torrent was added but dropped from the engine immediately — check server logs",
        };
      }

      const peers = readProp(() => live.numPeers, 0);
      const pct = Math.round(readProp(() => live.progress, 0) * 100);
      return {
        ok: true,
        message: "",
        details: {
          type: "builtin-transfer",
          action: isComplete(live) ? "already_complete" : "started",
          pct,
          peers,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      if (stack) {
        console.warn("[builtin-engine] addTorrent failed:", message, "\n", stack);
      }
      return {
        ok: false,
        message,
      };
    }
  }

  async listTorrents(
    config: ClientConnectionConfig,
  ): Promise<ClientTorrent[]> {
    const s = state();
    const uid = config.userId?.trim() || null;
    const persistedRows = uid
      ? await prisma.engineTorrent.findMany({
          where: { userId: uid, status: { not: "removed" } },
        })
      : [];
    // Listing is observational. Process startup restores incomplete transfers;
    // opening Downloads only overlays already-live engine state on durable rows.
    const client = s.client;
    // A dev hot reload can leave the process-global client alive with an older
    // interval closure. Re-arm only lifecycle maintenance; never create or
    // rehydrate a client from this read path.
    if (client) startUploadThrottleLoop(client);
    const allowed = uid && client ? await allowedHashesForUser(uid) : null;

    const out: ClientTorrent[] = [];
    const seen = new Set<string>();

    for (const t of client?.torrents ?? []) {
      // A torrent mid-teardown can throw from its own getters. Degrade that one
      // row instead of failing the whole list — the Client page is how the user
      // finds and removes a bad torrent in the first place.
      try {
        // Still warming metadata — keep in list as metaDL so Client isn't empty
        const h = (readProp(() => t.infoHash, "") || "").toLowerCase();
        if (!h) {
          // The key must be stable across polls. `pending-${out.length}` was
          // derived from list position, so a second pending torrent renumbered
          // the first and React remounted the row every 5 seconds. Fall back to
          // the info hash embedded in the magnet, which exists before metadata
          // does; only a torrent with neither is keyed by name.
          const magnet = readProp(() => t.magnetURI, "") || "";
          const btih = /xt=urn:btih:([a-z0-9]+)/i.exec(magnet)?.[1];
          const name = readProp(() => t.name, "") || "Fetching metadata…";
          out.push({
            hash: btih ? btih.toLowerCase() : `pending-${name}`,
            name,
            progress: 0,
            sizeBytes: 0,
            dlspeed: 0,
            upspeed: 0,
            state: "metaDL",
            category: undefined,
            savePath: readProp(() => t.path, "") || null,
          });
          continue;
        }
        if (allowed && !allowed.has(h)) continue;
        seen.add(h);
        const m = s.meta.get(h);
        out.push(
          mapTorrent(t, {
            savePath: m?.savePath || readProp(() => t.path, "") || undefined,
            // A torrent with no recorded category is uncategorised. Borrowing
            // the client's default label here would display a guess as a fact.
            category: m?.category || undefined,
            name: m?.name,
            userId: m?.userId,
          }),
        );
      } catch {
        /* skip an unreadable torrent rather than 502 the page */
      }
    }

    // DB rows not yet live (after restart / before rehydrate peers) — still show
    if (uid) {
      try {
        for (const row of persistedRows) {
          const h = row.hash.toLowerCase();
          if (seen.has(h)) continue;
          out.push({
            hash: row.hash,
            name: row.name,
            progress: row.progress ?? 0,
            sizeBytes: Number(row.sizeBytes ?? 0),
            dlspeed: 0,
            upspeed: 0,
            // Prefer "downloading" so UI filters show it; metaDL was easy to miss
            state: persistedTorrentDisplayState(row),
            playable: persistedTorrentHasInvalidMedia(row) ? false : undefined,
            category: row.category ?? undefined,
            savePath: row.savePath,
            error: row.error ?? undefined,
          });
          seen.add(h);
        }
      } catch {
        /* ignore */
      }
    }

    // Deterministic order.
    //
    // Rows come from two sources: live engine torrents first, then DB rows that
    // are not live yet. `client.torrents` is an internal array and `findMany`
    // has no ORDER BY, so a torrent visibly JUMPED from the tail of the list
    // into the middle the moment it went live. The Client page polls this every
    // 5 seconds and renders it verbatim, so rows moved under the cursor while
    // the user was reaching for a button.
    //
    // Sorting here (rather than only in the page) keeps every consumer
    // consistent. `hash` is the final tiebreaker so the order is total and
    // cannot depend on the order the two sources happened to be concatenated.
    out.sort(
      (a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true }) ||
        a.hash.localeCompare(b.hash),
    );

    return out;
  }

  async pauseTorrent(
    config: ClientConnectionConfig,
    hash: string,
  ): Promise<AddTorrentResult> {
    try {
      const client = await ensureClientAndRehydrate(config);
      if (!(await assertOwnsTorrent(config, hash))) {
        return { ok: false, message: "Torrent not found in engine" };
      }
      const t = findTorrent(client, hash);
      if (!t) return { ok: false, message: "Torrent not found in engine" };
      if (isComplete(t)) {
        if (config.userId) void persistAndParkCompletedTorrent(config.userId, t);
        return { ok: false, message: "Downloaded files cannot be paused" };
      }
      haltTransfer(t);
      if (config.userId) {
        try {
          await progressSnapshotScheduler.cancelAndDrain(
            `${config.userId}:${hash.toLowerCase()}`,
          );
          await prisma.engineTorrent.updateMany({
            where: {
              userId: config.userId,
              hash: hash.toLowerCase(),
            },
            data: { status: "paused" },
          });
        } catch {
          /* best-effort */
        }
      }
      return { ok: true, message: "Paused" };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async resumeTorrent(
    config: ClientConnectionConfig,
    hash: string,
  ): Promise<AddTorrentResult> {
    try {
      const client = await ensureClientAndRehydrate(config);
      if (!(await assertOwnsTorrent(config, hash))) {
        return { ok: false, message: "Torrent not found in engine" };
      }
      const t = findTorrent(client, hash);
      if (!t) return { ok: false, message: "Torrent not found in engine" };
      if (isComplete(t)) {
        if (config.userId) {
          void persistAndParkCompletedTorrent(config.userId, t);
        }
        return { ok: true, message: "Already downloaded" };
      }
      const lookup = await lookupExistingOrigin(config.userId, hash.toLowerCase());
      resumeTransferForLookup(t, lookup);
      if (config.userId) {
        try {
          await prisma.engineTorrent.updateMany({
            where: {
              userId: config.userId,
              hash: hash.toLowerCase(),
            },
            data: {
              status: "downloading",
            },
          });
        } catch {
          /* best-effort */
        }
      }
      return { ok: true, message: "Resumed" };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Retry the SAME release after a transient DELIVERY failure (I19b).
   *
   * A no-peer / connection-blocked failure (e.g. the user briefly turned a VPN
   * off) is not a reason to permanently dead-mark an infoHash. This clears any
   * "error" dead-mark so the release is eligible for rehydration/re-add again,
   * then either re-announces the live torrent or re-adds it from the persisted
   * magnet/torrentUrl — the SAME infoHash, never a failover to a different
   * release. Playability failures (corrupt/undecodable) are handled by
   * failover, not here.
   */
  async retryTorrent(
    config: ClientConnectionConfig,
    hash: string,
  ): Promise<AddTorrentResult> {
    const h = hash.toLowerCase();
    try {
      const row = config.userId
        ? await prisma.engineTorrent.findFirst({
            where: { userId: config.userId, hash: h },
          })
        : null;
      if (row && persistedTorrentIsDownloaded(row)) {
        return { ok: false, message: "Downloaded files do not need retrying" };
      }

      // Lift any dead-mark first so a re-add is not filtered out by rehydrate's
      // status notIn ["removed","error"] guard.
      if (config.userId) {
        try {
          await prisma.engineTorrent.updateMany({
            where: { userId: config.userId, hash: h },
            data: { status: "downloading", error: null },
          });
        } catch {
          /* best-effort: the retry can still proceed against the live engine */
        }
      }

      // The persisted origin decides how a retry behaves: a stream/prewarm must
      // NOT be resurrected as a whole-file download (issue C). Read it once, up
      // front, so both the live and the re-add path can honour it.
      const purpose = purposeFromOrigin(row?.origin);
      const client = await ensureClientAndRehydrate(config);

      // Still live in the engine? A transient no-peer failure only needs a fresh
      // announce. A kept download re-selects and re-announces; a stream/prewarm
      // only re-announces so the stream route can re-request its ranges — it is
      // never whole-file selected behind the user's back.
      const live = findTorrent(client, h);
      if (live) {
        if (purpose === "keep") {
          resumeTransfer(live);
        } else {
          resumeTransferCore(live);
        }
        return { ok: true, message: "Re-announced" };
      }

      // Not live — re-add from the persisted source (SAME infoHash), carrying the
      // stored intent so a stream stays a stream.
      const magnet = row?.magnet?.trim() || undefined;
      const torrentUrl = row?.torrentUrl?.trim() || undefined;
      if (!magnet && !torrentUrl) {
        return { ok: false, message: "No saved source to retry this release" };
      }
      return this.addTorrent(config, {
        magnet,
        torrentUrl,
        name: row?.name ?? undefined,
        savePath: row?.savePath ?? undefined,
        category: row?.category ?? undefined,
        purpose,
      });
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async deleteTorrent(
    config: ClientConnectionConfig,
    hash: string,
    deleteFiles = false,
  ): Promise<AddTorrentResult> {
    try {
      if (!(await assertOwnsTorrent(config, hash))) {
        return { ok: false, message: "Torrent not found in engine" };
      }
      const client = state().client;
      const t = client ? findTorrent(client, hash) : null;
      const h = hash.toLowerCase();
      const meta = state().meta.get(h);

      // The torrent's own recorded files + save path, read BEFORE the row is
      // deleted. This is what lets a delete remove the actual bytes even when no
      // live WebTorrent handle exists — the case that left whole release folders
      // on disk after "Delete + files".
      const owned = deleteFiles
        ? await ownedFilesForDelete(config, h, t ?? undefined)
        : { files: [] as string[], savePath: null as string | null };

      // Capture leaf path before destroy (for empty-parent prune)
      let leafPath: string | null =
        meta?.savePath?.trim() ||
        t?.path?.trim() ||
        owned.savePath ||
        null;
      if (!leafPath && config.userId) {
        try {
          const row = await prisma.engineTorrent.findFirst({
            where: { userId: config.userId, hash: h },
            select: { savePath: true },
          });
          leafPath = row?.savePath?.trim() || null;
        } catch {
          /* optional */
        }
      }

      // Multi-user: only destroy the live torrent if no other user still owns it
      let otherOwners = 0;
      if (config.userId) {
        try {
          otherOwners = await prisma.engineTorrent.count({
            where: {
              hash: h,
              userId: { not: config.userId },
              status: { not: "removed" },
            },
          });
        } catch {
          otherOwners = 0;
        }
      }

      if (!t) {
        state().meta.delete(h);
        // Still remove files if a live handle was already gone but the release
        // folder and its bytes remain on disk. This is the path that used to
        // only prune EMPTY folders and so left everything behind.
        if (deleteFiles && leafPath && otherOwners === 0) {
          forgetTorrentMetadata(leafPath, h);
          const base = defaultDownloadRoot(config);
          await removeReleaseFilesFromDisk(config, h, leafPath, owned.files, base);
          pruneEmptyDescendants(leafPath, base);
          pruneEmptyParents(leafPath, base);
        }
        if (config.userId) {
          await prisma.engineTorrent.deleteMany({
            where: {
              userId: config.userId,
              hash: h,
            },
          });
        } else {
          await prisma.engineTorrent.deleteMany({
            where: { hash: { equals: h } },
          });
        }
        scheduleIdleClientDestroy();
        return { ok: true, message: "Already removed" };
      }

      if (otherOwners === 0) {
        await destroyLiveTorrent(t, deleteFiles);
        state().meta.delete(h);
        scheduleIdleClientDestroy();

        // Remove empty Season NN / Show folders left after file delete
        if (deleteFiles && leafPath) {
          // The cached .torrent describes media that no longer exists, so it
          // goes with it. Before the prune, so the now-empty cache folders are
          // themselves prunable. Deliberately NOT done when files are kept:
          // that release is still playable offline and needs its metadata.
          forgetTorrentMetadata(leafPath, h);
          try {
            const base = defaultDownloadRoot(config);
            // WebTorrent's store destroy removes the files it wrote but leaves
            // the release folder and its sidecar junk (Featurettes, .torrentflow,
            // "Torrent Downloaded From …" txt, .part). Remove the torrent's own
            // folder explicitly — never a shared parent — then prune empties.
            await removeReleaseFilesFromDisk(config, h, leafPath, owned.files, base);
            // DOWN first, then UP. A multi-file torrent owns a folder *below*
            // savePath; leaving it there also blocks the upward walk, because
            // savePath then still looks non-empty.
            const below = pruneEmptyDescendants(leafPath, base);
            const pruned = pruneEmptyParents(leafPath, base);
            const removed = [...below.removed, ...pruned.removed];
            if (removed.length) {
              console.info(
                `[builtin-engine] pruned empty folders: ${removed.join(" → ")}`,
              );
            }
          } catch (err) {
            console.warn(
              "[builtin-engine] prune empty folders failed",
              err instanceof Error ? err.message : err,
            );
          }
        }
      } else {
        // Keep live torrent for other users; drop our meta ownership only
        const m = state().meta.get(h);
        if (m?.userId === config.userId) {
          state().meta.set(h, { ...m, userId: undefined });
        }
      }

      try {
        if (config.userId) {
          await prisma.engineTorrent.deleteMany({
            where: {
              userId: config.userId,
              hash: h,
            },
          });
        } else {
          await prisma.engineTorrent.deleteMany({
            where: { hash: { equals: h } },
          });
        }
      } catch {
        /* optional table */
      }
      return {
        ok: true,
        message: deleteFiles
          ? "Removed torrent and files from built-in engine"
          : "Removed from built-in engine (files kept)",
      };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

function extractInfoHash(uri: string): string | null {
  const m = uri.match(/btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i);
  if (!m) return null;
  const h = m[1];
  if (h.length === 40) return h.toLowerCase();
  return null; // base32 — WebTorrent handles; skip dedupe
}

export const builtinClient = new BuiltinClient();
