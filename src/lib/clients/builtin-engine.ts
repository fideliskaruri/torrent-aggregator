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
import { flattenSingleReleaseRoot } from "./flatten-release-root";
import { pruneEmptyParents } from "./prune-empty-parents";
import { findTorrentByHash } from "./find-torrent-by-hash";
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
  numPeers: number;
  timeRemaining: number;
  path: string;
  magnetURI?: string;
  files?: Array<WtFile & { select?: () => void; deselect?: () => void }>;
  pause: () => void;
  resume: () => void;
  destroy: (opts?: { destroyStore?: boolean }, cb?: (err?: Error) => void) => void;
  on: (ev: string, fn: (...args: unknown[]) => void) => void;
};

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

/** Select all files and resume so download actually starts. */
function ensureDownloading(t: WtTorrent): void {
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
    if (t.paused) t.resume();
    else t.resume(); // no-op if already running; ensures not left paused
  } catch {
    /* best-effort */
  }
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

async function getWtClient(): Promise<WebTorrentLike> {
  const s = state();
  if (s.client) return s.client;
  if (s.loading) return s.loading;

  s.loading = (async () => {
    // Dynamic import keeps Next bundler from packing native deps into edge
    const mod = await import("webtorrent");
    const WebTorrent = (mod as { default?: new () => WebTorrentLike }).default ??
      (mod as unknown as new () => WebTorrentLike);
    const client = new WebTorrent();
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

          s.meta.set(hash, {
            savePath: dest,
            category: row.category ?? undefined,
            name: row.name,
            userId: row.userId,
          });

          // Fire-and-forget: do not wait for metadata (can hang on dead magnets)
          const t = client.add(withPublicTrackers(row.magnet), {
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
            ensureDownloading(t);
            s.meta.set(h, {
              savePath: dest,
              category: row.category ?? undefined,
              name: t.name || row.name,
              userId: row.userId,
            });
            scheduleReleaseRootFlatten(t, dest);
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

function mapTorrent(
  t: WtTorrent,
  extra?: TorrentMeta,
): ClientTorrent {
  let st = "downloading";
  if (t.paused) st = "paused";
  else if (t.done) st = "seeding";
  else if (t.numPeers === 0 && t.progress < 1) st = "stalledDL";

  const eta =
    t.timeRemaining && t.timeRemaining < 8640000 * 1000
      ? Math.round(t.timeRemaining / 1000)
      : undefined;

  return {
    hash: t.infoHash,
    name: t.name || extra?.name || t.infoHash,
    progress: t.progress ?? 0,
    sizeBytes: t.length ?? 0,
    dlspeed: t.downloadSpeed ?? 0,
    upspeed: t.uploadSpeed ?? 0,
    state: st,
    eta,
    category: extra?.category,
    savePath: extra?.savePath || t.path || null,
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
      t.destroy({ destroyStore: deleteFiles }, (err) => {
        if (err) reject(err);
        else resolve();
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
        progress: t.progress ?? 0,
        sizeBytes: BigInt(Math.max(0, Math.floor(t.length ?? 0))),
        status,
        name: t.name || undefined,
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
 * WebTorrent multi-file packs write to savePath/<torrentName>/….
 * Single-file packs already land files directly under savePath.
 *
 * After the torrent finishes (files closed), best-effort flatten a single
 * junk release root so the leaf is Category/Show/Season NN/<episode files>.
 * Also try once on ready if already complete (rehydrate / fast local).
 */
function scheduleReleaseRootFlatten(t: WtTorrent, dest: string): void {
  const run = () => {
    try {
      const result = flattenSingleReleaseRoot(dest, t.name);
      if (result.flattened) {
        console.info(
          `[builtin-engine] flattened release root → ${dest} (moved ${result.moved})`,
        );
      }
    } catch (err) {
      console.warn(
        "[builtin-engine] flatten release root failed",
        err instanceof Error ? err.message : err,
      );
    }
  };

  // Prefer post-done so chunk store has released handles
  if (t.done) {
    // Defer so destroy/store settles after ready callback returns
    setTimeout(run, 250);
    return;
  }
  t.on("done", () => {
    setTimeout(run, 500);
  });
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
              status: existing.done
                ? "seeding"
                : "downloading",
              progress: existing.progress ?? 0,
              sizeBytes: existing.length ?? 0,
            });
          }
          const peers = existing.numPeers ?? 0;
          const pct = Math.round((existing.progress ?? 0) * 100);
          return {
            ok: true,
            message: existing.done
              ? `Already complete in built-in engine (${pct}% · ${existing.name || hash.slice(0, 8)})`
              : `Downloading in built-in engine (${pct}% · ${peers} peers · ${dest})`,
          };
        }
      }

      const torrent = await new Promise<WtTorrent>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(
            new Error(
              "Timed out waiting for torrent metadata (no peers / blocked DHT?). Try another release or check network.",
            ),
          );
        }, 90_000);
        const t = client.add(addUri, { path: dest }, (ready) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(ready);
        });
        t.on("error", (err: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
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
      scheduleReleaseRootFlatten(torrent, dest);

      if (config.userId) {
        await upsertEngineTorrent({
          userId: config.userId,
          hash,
          name: payload.name || torrent.name || hash,
          magnet: magnetForPersist(payload, addUri, torrent),
          savePath: dest,
          category: payload.category,
          status: torrent.done ? "seeding" : "downloading",
          progress: torrent.progress ?? 0,
          sizeBytes: torrent.length ?? 0,
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

      const peers = live.numPeers ?? 0;
      const pct = Math.round((live.progress ?? 0) * 100);
      return {
        ok: true,
        message: live.done
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
      // Still warming metadata — keep in list as metaDL so Client isn't empty
      const h = (t.infoHash || "").toLowerCase();
      if (!h) {
        out.push({
          hash: `pending-${out.length}`,
          name: t.name || "Fetching metadata…",
          progress: 0,
          sizeBytes: 0,
          dlspeed: 0,
          upspeed: 0,
          state: "metaDL",
          category: config.category || undefined,
          savePath: t.path || null,
        });
        continue;
      }
      if (allowed && !allowed.has(h)) continue;
      seen.add(h);
      const m = s.meta.get(h);
      ensureDownloading(t);
      const status = t.paused
        ? "paused"
        : t.done
          ? "seeding"
          : t.numPeers === 0 && t.progress < 1
            ? "stalledDL"
            : "downloading";
      scheduleProgressPersist(uid, t, status === "stalledDL" ? "downloading" : status);
      out.push(
        mapTorrent(t, {
          savePath: m?.savePath || t.path,
          category: m?.category || config.category || undefined,
          name: m?.name,
          userId: m?.userId,
        }),
      );
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
                const t = client.add(withPublicTrackers(row.magnet), {
                  path: dest,
                });
                t.on("ready", () => ensureDownloading(t));
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
      t.pause();
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
      t.resume();
      if (config.userId) {
        try {
          await prisma.engineTorrent.updateMany({
            where: {
              userId: config.userId,
              hash: hash.toLowerCase(),
            },
            data: { status: t.done ? "seeding" : "downloading" },
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
