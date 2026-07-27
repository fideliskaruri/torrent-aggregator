import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { Server as TrackerServer } from "bittorrent-tracker";
import WebTorrent from "webtorrent";

import type { ClientConnectionConfig } from "../../src/lib/clients";
import { handleStreamIndexRequest } from "../../src/app/api/stream/[infoHash]/route";

const WORK = path.join(process.cwd(), "scripts", "probes", ".range-manifest-pack-work");
const SEED_ROOT = path.join(WORK, "seed");
const PACK_ROOT = path.join(SEED_ROOT, "TorrentFlow.S01.Pack");
const LEECH_ROOT = path.join(WORK, "leech");
const FILE_SIZE = 16 * 1024 * 1024;

const CONFIG: ClientConnectionConfig = {
  clientType: "builtin",
  host: "",
};

type WebTorrentTorrent = {
  infoHash: string;
  magnetURI: string;
  progress: number;
  files: Array<{ path: string; length: number }>;
  on: (event: "error", fn: (err: Error) => void) => void;
};

type WebTorrentClient = {
  seed: (
    input: string,
    opts: { announce: string[] },
    cb: (torrent: WebTorrentTorrent) => void,
  ) => void;
  add: (
    input: string,
    opts: { announce: string[]; path: string; strategy: "sequential" },
    cb: (torrent: WebTorrentTorrent) => void,
  ) => WebTorrentTorrent;
  destroy: (cb?: () => void) => void;
  throttleDownload?: (rate: number) => unknown;
};

async function writeFixture(filePath: string, fill: number) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const handle = await fs.open(filePath, "w");
  try {
    const chunk = Buffer.alloc(1024 * 1024, fill);
    for (let written = 0; written < FILE_SIZE; written += chunk.length) {
      await handle.write(chunk, 0, Math.min(chunk.length, FILE_SIZE - written));
    }
  } finally {
    await handle.close();
  }
}

function listenTracker(tracker: TrackerServer): Promise<string> {
  return new Promise((resolve, reject) => {
    tracker.listen(0, "127.0.0.1", () => {
      const addr = tracker.http?.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("tracker did not report a TCP port"));
        return;
      }
      resolve(`http://127.0.0.1:${addr.port}/announce`);
    });
  });
}

async function destroyClient(client: WebTorrentClient) {
  await new Promise<void>((resolve) => {
    try {
      client.destroy(() => resolve());
    } catch {
      resolve();
    }
  });
}

async function closeTracker(tracker: TrackerServer) {
  await new Promise<void>((resolve) => {
    try {
      tracker.close(() => resolve());
    } catch {
      resolve();
    }
    setTimeout(resolve, 2_000).unref();
  });
}

function waitForSeed(
  client: WebTorrentClient,
  trackerUrl: string,
): Promise<{ infoHash: string; magnetURI: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out seeding pack")), 60_000);
    client.seed(PACK_ROOT, { announce: [trackerUrl] }, (torrent) => {
      clearTimeout(timer);
      resolve({ infoHash: torrent.infoHash, magnetURI: torrent.magnetURI });
    });
  });
}

function waitForLeecher(
  client: WebTorrentClient,
  magnetURI: string,
  trackerUrl: string,
): Promise<WebTorrentTorrent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out loading pack metadata")), 60_000);
    const torrent = client.add(
      magnetURI,
      { announce: [trackerUrl], path: LEECH_ROOT, strategy: "sequential" },
      (ready) => {
        clearTimeout(timer);
        resolve(ready);
      },
    );
    torrent.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function main() {
  await fs.rm(WORK, { recursive: true, force: true });
  await writeFixture(path.join(PACK_ROOT, "TorrentFlow.S01E01.mkv"), 0x11);
  await writeFixture(path.join(PACK_ROOT, "TorrentFlow.S01E03.mkv"), 0x33);
  await fs.mkdir(LEECH_ROOT, { recursive: true });

  const tracker = new TrackerServer({ udp: false, ws: false, stats: false, http: true });
  tracker.on("error", () => undefined);
  tracker.on("warning", () => undefined);

  const seeder = new WebTorrent({ dht: false, utp: false }) as WebTorrentClient;
  const leecher = new WebTorrent({ dht: false, utp: false }) as WebTorrentClient;
  leecher.throttleDownload?.(8 * 1024);

  try {
    const trackerUrl = await listenTracker(tracker);
    const seeded = await waitForSeed(seeder, trackerUrl);
    const torrent = await waitForLeecher(leecher, seeded.magnetURI, trackerUrl);

    assert.ok(torrent.files.length >= 2, `expected a multi-file pack, got ${torrent.files.length}`);
    assert.ok(torrent.progress < 1, `probe must be still-downloading, progress=${torrent.progress}`);

    const res = await handleStreamIndexRequest(
      { infoHash: seeded.infoHash },
      {
        getConfig: async () => CONFIG,
        findFile: (async () => ({
          status: "found" as const,
          torrent,
          file: torrent.files[0],
        })) as never,
        quiet: true,
      },
    );
    const body = await res.json();

    console.log("── Real incomplete multi-file manifest probe ──");
    console.log(`HTTP ${res.status}`);
    console.log(`progress=${torrent.progress}`);
    console.log(JSON.stringify(body, null, 2));
  } finally {
    await destroyClient(leecher);
    await destroyClient(seeder);
    await closeTracker(tracker);
    await fs.rm(WORK, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
