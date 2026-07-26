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
import { pruneEmptyParents } from "./prune-empty-parents";
import { findTorrentByHash } from "./find-torrent-by-hash";
import { haltTransfer, resumeTransfer as resumeTransferCore } from "./transfer-control";
import prisma from "@/lib/prisma";

type WebTorrentLike = {
  torrents: Array<WtTorrent>;
  add: (
    uri: string,
    opts?: { path?: string },
    cb?: (t: WtTorrent) => void,
  ) => WtTorrent;
  /** WebTorrent 3+: async; prefer findTorrent (scans torrents) instead */
  get: (id: string) => WtTorrent | void | Promise<WtTorrent | null | void>;
  remove?: (
    id: string | WtTorrent,
    opts?: { destroyStore?: boolean } | ((err?: Error) => void),
    cb?: (err?: Error) => void,
  ) => void | Promise<void>;
  destroy: (cb?: (err?: Error) => void) => void;
  on: (ev: string, fn: (...args: unknown[]) => void) => void;
};

type WtFile = {
  name: string;
  path: string;
  length: number;
};

type WtTorrent = {
  infoHash: string;
  name: string;
  progress: number;
  length: number;
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
  pieces?: Array<unknown>;
  files?: Array<WtFile & { select?: () => void; deselect?: () => void }>;
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
 * `maxConns` is left at WebTorrent's 55 for the same reason — no observed
 * swarm ever came close to saturating it.
 */
const BUILTIN_CLIENT_OPTIONS = { utp: false } as const;

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
const ADD_OPTIONS = { strategy: "sequential" } as const;

export const builtinAddOptions = ADD_OPTIONS;

/** Public trackers so magnets without announce still find peers (common on TPB/CSV). */
const FALLBACK_TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "wss://tracker.openwebtorrent.com",
  "wss://tracker.webtorrent.dev",
];

/**
 * Ensure magnet has trackers; WebTorrent won't download if magnet is bare btih
 * and DHT is blocked/slow.
 */
function withPublicTrackers(uri: string): string {
  const u = uri.trim();
  if (!u.startsWith("magnet:")) return u;
  if (/tr=/i.test(u)) return u;
  let out = u;
  for (const tr of FALLBACK_TRACKERS) {
    out += `&tr=${encodeURIComponent(tr)}`;
  }
  return out;
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

/** Apply the persisted status to a freshly re-added torrent. */
function applyPersistedStatus(t: WtTorrent, status: string | null | undefined): void {
  if (status === "paused") {
    selectAllFiles(t);
    haltTransfer(t);
    return;
  }
  ensureDownloading(t);
}

type TorrentMeta = {
  savePath?: string;
  category?: string;
  name?: string;
  /** Owning user — used to scope list/pause/delete in multi-user process */
  userId?: string;
};

type EngineState = {
  client: WebTorrentLike | null;
  loading: Promise<WebTorrentLike> | null;
  /** hash -> last known save path / category for list enrichment */
  meta: Map<string, TorrentMeta>;
  /** userIds (or "*" for all-users) already rehydrated this process */
  rehydrated: Set<string>;
  /** in-flight rehydrate promises keyed by userId or "*" */
  rehydrating: Map<string, Promise<void>>;
};

const g = globalThis as unknown as { __tfBuiltinEngine?: EngineState };

function state(): EngineState {
  if (!g.__tfBuiltinEngine) {
    g.__tfBuiltinEngine = {
      client: null,
      loading: null,
      meta: new Map(),
      rehydrated: new Set(),
      rehydrating: new Map(),
    };
  }
  // Backfill fields if an older singleton is still hot-reloaded in dev
  const s = g.__tfBuiltinEngine;
  if (!s.rehydrated) s.rehydrated = new Set();
  if (!s.rehydrating) s.rehydrating = new Map();
  return s;
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
  s.meta.clear();
  s.rehydrated.clear();
  s.rehydrating.clear();

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
    s.client = client;
    return client;
  })();

  try {
    return await s.loading;
  } finally {
    s.loading = null;
  }
}

/** Automatic storage budget + free-space floor (see library/disk-space). */
async function checkStoragePolicy(
  config: ClientConnectionConfig,
  dest: string,
  incomingBytes?: number | null,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { assertStorageBudget } = await import("@/lib/library/disk-space");
  const root =
    config.baseDownloadPath?.trim() ||
    config.savePath?.trim() ||
    dest;
  const r = await assertStorageBudget({
    root,
    maxStorageBytes: config.maxStorageBytes,
    incomingBytes: incomingBytes ?? null,
  });
  if (!r.ok) return { ok: false, message: r.message };
  return { ok: true };
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

async function upsertEngineTorrent(opts: {
  userId: string;
  hash: string;
  name: string;
  magnet: string | null;
  savePath: string;
  category?: string | null;
  status?: string;
  progress?: number;
  sizeBytes?: number;
}): Promise<void> {
  if (!opts.hash || typeof opts.hash !== "string") {
    console.warn("[builtin-engine] upsertEngineTorrent missing hash", opts.name);
    return;
  }
  const hash = opts.hash.toLowerCase();
  try {
    await prisma.engineTorrent.upsert({
      where: {
        userId_hash: { userId: opts.userId, hash },
      },
      create: {
        userId: opts.userId,
        hash,
        name: opts.name,
        magnet: opts.magnet,
        savePath: opts.savePath,
        category: opts.category ?? null,
        status: opts.status ?? "downloading",
        progress: opts.progress ?? 0,
        sizeBytes: BigInt(Math.max(0, Math.floor(opts.sizeBytes ?? 0))),
      },
      update: {
        name: opts.name,
        magnet: opts.magnet ?? undefined,
        savePath: opts.savePath,
        category: opts.category ?? null,
        status: opts.status ?? "downloading",
        progress: opts.progress ?? 0,
        sizeBytes: BigInt(Math.max(0, Math.floor(opts.sizeBytes ?? 0))),
        error: null,
      },
    });
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
    try {
      const rows = await prisma.engineTorrent.findMany({
        where: {
          ...(userId?.trim() ? { userId: userId.trim() } : {}),
          status: { not: "removed" },
          magnet: { not: null },
        },
      });

      for (const row of rows) {
        if (!row.magnet) continue;
        if (!row.hash) continue;
        const hash = row.hash.toLowerCase();
        try {
          // Must use findTorrent — client.get() is async in WebTorrent 3 and
          // a bare Promise is always truthy (would skip re-add forever).
          const already = findTorrent(client, hash);
          if (already) {
            s.meta.set(hash, {
              savePath: row.savePath ?? undefined,
              category: row.category ?? undefined,
              name: row.name,
              userId: row.userId,
            });
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

          // Fire-and-forget: do not wait for metadata (can hang on dead magnets)
          const t = client.add(withPublicTrackers(row.magnet), {
            ...ADD_OPTIONS,
            path: dest,
          });
          t.on("error", (err: unknown) => {
            console.warn(
              `[builtin-engine] rehydrate error for ${hash}:`,
              err instanceof Error ? err.message : err,
            );
          });
          t.on("ready", () => {
            const h = t.infoHash?.toLowerCase?.() || hash;
            applyPersistedStatus(t, row.status);
            s.meta.set(h, {
              savePath: dest,
              category: row.category ?? undefined,
              name: t.name || row.name,
              userId: row.userId,
            });
          });
        } catch (err) {
          console.warn(
            `[builtin-engine] failed to re-add ${hash}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    } catch (err) {
      console.warn("[builtin-engine] rehydrate query failed", err);
    } finally {
      s.rehydrated.add(key);
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
function isComplete(t: WtTorrent): boolean {
  return readProp(() => t.progress, 0) >= 0.9999;
}

export function torrentStatus(t: WtTorrent): string {
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
  const complete = isComplete(t);
  if (complete) return peers > 0 ? "uploading" : "stalledUP";
  return peers > 0 ? "downloading" : "stalledDL";
}

export function mapTorrent(
  t: WtTorrent,
  extra?: TorrentMeta,
): ClientTorrent {
  const st = torrentStatus(t);
  const remainingMs = readProp(() => t.timeRemaining, 0);
  const eta =
    remainingMs > 0 && remainingMs < 8640000 * 1000
      ? Math.round(remainingMs / 1000)
      : undefined;

  return {
    hash: t.infoHash,
    name: readProp(() => t.name, "") || extra?.name || t.infoHash,
    progress: readProp(() => t.progress, 0),
    sizeBytes: readProp(() => t.length, 0),
    dlspeed: readProp(() => t.downloadSpeed, 0),
    upspeed: readProp(() => t.uploadSpeed, 0),
    state: st,
    eta,
    peers: readProp(() => t.numPeers, 0),
    category: extra?.category,
    savePath: extra?.savePath || readProp(() => t.path, "") || null,
  };
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

async function assertOwnsTorrent(
  config: ClientConnectionConfig,
  hash: string,
): Promise<boolean> {
  if (!config.userId?.trim()) return true;
  const allowed = await allowedHashesForUser(config.userId.trim());
  return allowed.has(hash.toLowerCase());
}

/** Best-effort progress snapshot into EngineTorrent (non-blocking). */
function scheduleProgressPersist(
  userId: string | null | undefined,
  t: WtTorrent,
  status: string,
): void {
  if (!userId?.trim()) return;
  const hash = t.infoHash?.toLowerCase?.();
  if (!hash) return;
  void prisma.engineTorrent
    .updateMany({
      where: { userId: userId.trim(), hash },
      data: {
        progress: readProp(() => t.progress, 0),
        sizeBytes: BigInt(
          Math.max(0, Math.floor(readProp(() => t.length, 0))),
        ),
        status,
        name: readProp(() => t.name, "") || undefined,
      },
    })
    .catch(() => {
      /* best-effort */
    });
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
    const uri = payload.magnet || payload.torrentUrl;
    if (!uri) {
      return { ok: false, message: "No magnet or torrent URL provided" };
    }

    try {
      const client = await ensureClientAndRehydrate(config);
      const dest =
        payload.savePath?.trim() ||
        defaultDownloadRoot(config);

      const space = await checkStoragePolicy(config, dest, null);
      if (!space.ok) {
        return { ok: false, message: space.message };
      }

      fs.mkdirSync(dest, { recursive: true });

      const addUri = withPublicTrackers(uri);
      const existingHash = extractInfoHash(addUri) || extractInfoHash(uri);
      if (existingHash) {
        const existing = findTorrent(client, existingHash);
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
          ensureDownloading(existing);
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
              savePath: dest,
              category: payload.category,
              status: isComplete(existing) ? "seeding" : "downloading",
              progress: readProp(() => existing.progress, 0),
              sizeBytes: readProp(() => existing.length, 0),
            });
          }
          const peers = readProp(() => existing.numPeers, 0);
          const pct = Math.round(readProp(() => existing.progress, 0) * 100);
          return {
            ok: true,
            message: isComplete(existing)
              ? `Already complete in built-in engine (${pct}% · ${existing.name || hash.slice(0, 8)})`
              : `Downloading in built-in engine (${pct}% · ${peers} peers · ${dest})`,
          };
        }
      }

      const torrent = await new Promise<WtTorrent>((resolve, reject) => {
        // Existing bytes may still sit under a release root from before the
        // layout rewrite. Lift them now, while nothing has the files open.
        repairExistingLayout(dest, payload.name);
        let settled = false;
        // A magnet that never resolves metadata stays in client.torrents
        // forever unless we destroy it, leaking handles/sockets and showing up
        // as a permanent "Fetching metadata…" row.
        const holder: { t?: WtTorrent } = {};
        const reap = () => {
          try {
            holder.t?.destroy?.({ destroyStore: false });
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
        const t = client.add(addUri, { ...ADD_OPTIONS, path: dest }, (ready) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(ready);
        });
        holder.t = t;
        t.on("error", (err: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reap();
          reject(err instanceof Error ? err : new Error(String(err)));
        });
      });

      // Metadata ready — force piece selection + resume so transfer actually starts
      ensureDownloading(torrent);

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

      // Multi-file → often savePath/torrentName/…; flatten junk root when done

      if (config.userId) {
        await upsertEngineTorrent({
          userId: config.userId,
          hash,
          name: payload.name || torrent.name || hash,
          magnet: magnetForPersist(payload, addUri, torrent),
          savePath: dest,
          category: payload.category,
          status: isComplete(torrent) ? "seeding" : "downloading",
          progress: readProp(() => torrent.progress, 0),
          sizeBytes: readProp(() => torrent.length, 0),
        });
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
        message: isComplete(live)
          ? `Already complete (${pct}%) → ${dest}`
          : `Download started (${pct}% · ${peers} peers) → ${dest}`,
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
    // Let failures propagate so the API can show builtin tips (not silent empty).
    const client = await ensureClientAndRehydrate(config);
    const s = state();
    const uid = config.userId?.trim() || null;
    const allowed = uid ? await allowedHashesForUser(uid) : null;

    const out: ClientTorrent[] = [];
    const seen = new Set<string>();

    for (const t of client.torrents) {
      // A torrent mid-teardown can throw from its own getters. Degrade that one
      // row instead of failing the whole list — the Client page is how the user
      // finds and removes a bad torrent in the first place.
      try {
        // Still warming metadata — keep in list as metaDL so Client isn't empty
        const h = (readProp(() => t.infoHash, "") || "").toLowerCase();
        if (!h) {
          out.push({
            hash: `pending-${out.length}`,
            name: readProp(() => t.name, "") || "Fetching metadata…",
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
        const status = torrentStatus(t);
        scheduleProgressPersist(
          uid,
          t,
          status === "stalledDL" ? "downloading" : status,
        );
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
        const rows = await prisma.engineTorrent.findMany({
          where: { userId: uid, status: { not: "removed" } },
        });
        for (const row of rows) {
          const h = row.hash.toLowerCase();
          if (seen.has(h)) continue;
          // Kick re-add if we have a magnet
          if (row.magnet?.trim()) {
            const dest =
              row.savePath?.trim() || defaultDownloadRoot(config);
            try {
              if (!findTorrent(client, h)) {
                repairExistingLayout(dest, row.name);
                const t = client.add(withPublicTrackers(row.magnet), {
                  ...ADD_OPTIONS,
                  path: dest,
                });
                t.on("ready", () => applyPersistedStatus(t, row.status));
                t.on("error", () => {
                  /* logged elsewhere */
                });
              }
            } catch {
              /* best-effort */
            }
          }
          out.push({
            hash: row.hash,
            name: row.name,
            progress: row.progress ?? 0,
            sizeBytes: Number(row.sizeBytes ?? 0),
            dlspeed: 0,
            upspeed: 0,
            // Prefer "downloading" so UI filters show it; metaDL was easy to miss
            state:
              row.status === "paused"
                ? "paused"
                : row.status === "seeding"
                  ? "seeding"
                  : row.progress > 0
                    ? "downloading"
                    : "metaDL",
            category: row.category ?? undefined,
            savePath: row.savePath,
          });
          seen.add(h);
        }
      } catch {
        /* ignore */
      }
    }

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
      haltTransfer(t);
      if (config.userId) {
        try {
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
      resumeTransfer(t);
      if (config.userId) {
        try {
          await prisma.engineTorrent.updateMany({
            where: {
              userId: config.userId,
              hash: hash.toLowerCase(),
            },
            data: {
              status: isComplete(t) ? "seeding" : "downloading",
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

  async deleteTorrent(
    config: ClientConnectionConfig,
    hash: string,
    deleteFiles = false,
  ): Promise<AddTorrentResult> {
    try {
      const client = await ensureClientAndRehydrate(config);
      if (!(await assertOwnsTorrent(config, hash))) {
        return { ok: false, message: "Torrent not found in engine" };
      }
      const t = findTorrent(client, hash);
      const h = hash.toLowerCase();
      const meta = state().meta.get(h);

      // Capture leaf path before destroy (for empty-parent prune)
      let leafPath: string | null =
        meta?.savePath?.trim() ||
        t?.path?.trim() ||
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
        if (config.userId) {
          try {
            await prisma.engineTorrent.deleteMany({
              where: {
                userId: config.userId,
                hash: h,
              },
            });
          } catch {
            /* optional */
          }
        } else {
          try {
            await prisma.engineTorrent.deleteMany({
              where: { hash: { equals: h } },
            });
          } catch {
            /* optional */
          }
        }
        // Still prune if files were already gone but empty season/show remain
        if (deleteFiles && leafPath) {
          pruneEmptyParents(leafPath, defaultDownloadRoot(config));
        }
        return { ok: true, message: "Already removed" };
      }

      if (otherOwners === 0) {
        await destroyLiveTorrent(t, deleteFiles);
        state().meta.delete(h);

        // Remove empty Season NN / Show folders left after file delete
        if (deleteFiles && leafPath) {
          try {
            const pruned = pruneEmptyParents(
              leafPath,
              defaultDownloadRoot(config),
            );
            if (pruned.removed.length) {
              console.info(
                `[builtin-engine] pruned empty parents: ${pruned.removed.join(" → ")}`,
              );
            }
          } catch (err) {
            console.warn(
              "[builtin-engine] prune empty parents failed",
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
