/**
 * Real-torrent end-to-end proof for the playback ladder.
 *
 * Every other harness serves its fixtures over plain HTTP, which means the one
 * path a real user's bytes actually travel — WebTorrent → `file.stream()` →
 * `api/stream/[infoHash]/[...filePath]/route.ts` → ffmpeg — had never been
 * exercised. That route carries hard-won knowledge (parked `FileIterator`
 * wake-ups, `end: 0` silently widening to the whole file, a stall guard on
 * every read, the edge prefetch) and none of it was covered.
 *
 * Nothing here touches the public swarm: a tracker and a seeder run in this
 * process, and the leecher is the app's own built-in engine. The only piece
 * injected into the route is `getConfig`, so that the run needs neither the
 * database nor a session — the torrent lookup, the file stream and the stall
 * handling are all the real thing.
 *
 * Run: npm run test:media:torrent
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { builtinClient } from "../src/lib/clients/builtin-engine";
import type { ClientConnectionConfig } from "../src/lib/clients";
import { handleStreamFileRequest } from "../src/app/api/stream/[infoHash]/[...filePath]/route";
import { probeUrl } from "../src/lib/media/probe";
import { decidePlayback } from "../src/lib/media/decide";
import {
  getOrCreateSession,
  waitForSessionFile,
  stopAllSessions,
  unrefSession,
  cleanupStaleSessionDirs,
} from "../src/lib/media/session";
import {
  EDGE_CAPS,
  generateFixture,
  probeFile,
  probeHlsOutput,
  table,
  torrentFixtures,
  type Fixture,
} from "./lib/media-e2e-support.mjs";
import { startLocalSwarm, ensureDir } from "./lib/local-swarm.mjs";

/** Long enough that the transfer is a real transfer, short enough to stay fast. */
const CLIP_SECONDS = 40;

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "tf-torrent-"));
const SEED_DIR = ensureDir(path.join(WORK, "seed"));
const LEECH_DIR = ensureDir(path.join(WORK, "leech"));

/**
 * No userId: `findBuiltinTorrentFile` only consults the per-user allow-list
 * when one is set, and `addTorrent` only writes an `EngineTorrent` row when one
 * is set. Leaving it unset is what keeps this harness out of the database.
 */
const CONFIG: ClientConnectionConfig = {
  clientType: "builtin",
  host: "",
  username: null,
  password: null,
  category: null,
  savePath: LEECH_DIR,
} as ClientConnectionConfig;

type Row = {
  name: string;
  infoHash: string;
  peers: string;
  rung: string;
  videoOut: string;
  audioOut: string;
  channels: string;
  ttfs: string;
  result: "PASS" | "FAIL";
  detail: string;
};

const rows: Row[] = [];
let failures = 0;

function fail(row: Row, detail: string): Row {
  row.result = "FAIL";
  row.detail = detail;
  failures += 1;
  return row;
}

/**
 * The real route handler behind a real HTTP server, so ffmpeg reaches the
 * torrent exactly as it does in the app — including range requests, which are
 * what `-ss` seeking and MKV Cues reads depend on.
 */
function startStreamServer(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const parts = url.pathname.split("/").filter(Boolean);
      // /api/stream/<infoHash>/<...filePath>
      if (parts.length < 4 || parts[0] !== "api" || parts[1] !== "stream") {
        res.writeHead(404).end();
        return;
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers.set(key, value);
      }
      const request = new Request(`http://127.0.0.1${url.pathname}${url.search}`, {
        method: req.method,
        headers,
      });
      const response = await handleStreamFileRequest(
        request,
        {
          infoHash: decodeURIComponent(parts[2]),
          filePath: parts.slice(3).map((p) => decodeURIComponent(p)),
        },
        { getConfig: async () => CONFIG },
      );
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      if (!response.body || req.method === "HEAD") {
        res.end();
        return;
      }
      const reader = response.body.getReader();
      for (;;) {
        const next = await reader.read().catch(() => ({ done: true, value: undefined }) as const);
        if (next.done) break;
        if (next.value && !res.write(Buffer.from(next.value))) {
          await new Promise((resolve) => res.once("drain", resolve));
        }
      }
      res.end();
    })().catch((err) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(err));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

async function runCase(
  fixture: Fixture,
  origin: string,
  magnet: string,
  infoHash: string,
  torrentFilePath: string,
): Promise<Row> {
  const row: Row = {
    name: fixture.name,
    infoHash: infoHash.slice(0, 8),
    peers: "-",
    rung: "-",
    videoOut: "-",
    audioOut: "-",
    channels: "-",
    ttfs: "-",
    result: "PASS",
    detail: "-",
  };

  const added = await builtinClient.addTorrent(CONFIG, {
    magnet,
    savePath: LEECH_DIR,
    name: fixture.file,
    purpose: "keep",
  });
  if (!added.ok) return fail(row, `engine refused the torrent: ${added.message}`);

  const streamUrl = `${origin}/api/stream/${infoHash}/${torrentFilePath
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;

  // The probe is the first read, so it is also what proves the engine served a
  // byte at all. Everything downstream depends on it.
  const outcome = await probeUrl(streamUrl, { timeoutMs: 60_000 });
  if (!outcome.ok) return fail(row, `probe through the torrent failed: ${outcome.error}`);
  const probe = outcome.result;

  const live = await builtinClient.listTorrents(CONFIG);
  const listed = live.find((t) => t.hash?.toLowerCase() === infoHash.toLowerCase());
  row.peers = listed ? `${listed.peers ?? 0}` : "0";

  const plan = decidePlayback(probe, EDGE_CAPS);
  row.rung = plan.rung;
  if (plan.rung !== fixture.expectRung) {
    return fail(row, `expected rung ${fixture.expectRung}`);
  }

  const created = getOrCreateSession(infoHash, torrentFilePath, plan, streamUrl);
  if (!created.ok) return fail(row, `session refused: ${created.error}`);
  const session = created.session;

  try {
    const ready = await waitForSessionFile(
      session,
      path.join(session.outputDir, "seg00000.m4s"),
      120_000,
    );
    if (!ready) return fail(row, `no first segment: ${session.error ?? session.state}`);
    row.ttfs = session.timeToFirstSegmentMs != null ? `${session.timeToFirstSegmentMs}ms` : "?";

    const out = probeHlsOutput(session.outputDir);
    if (!out) return fail(row, "could not probe the produced fMP4");

    const video = out.streams.find((s) => s.codecType === "video");
    const audio = out.streams.find((s) => s.codecType === "audio");
    row.videoOut = video ? video.codec : "none";
    row.audioOut = audio ? audio.codec : "none";
    row.channels = `${probe.streams.find((s) => s.codecType === "audio")?.channels ?? "-"}→${audio?.channels ?? "-"}`;

    if (fixture.expectChannels != null && audio?.channels !== fixture.expectChannels) {
      return fail(row, `channels not preserved: expected ${fixture.expectChannels}, got ${audio?.channels ?? "none"}`);
    }
    return row;
  } finally {
    unrefSession(session.id);
  }
}

/**
 * A range request the player actually issues. `end: 0` is WebTorrent's falsy
 * trap — the route floors it, and this is the assertion that keeps that floor
 * honest against a live torrent rather than a mock.
 */
async function verifyRangeSemantics(
  origin: string,
  infoHash: string,
  torrentFilePath: string,
  fileLength: number,
): Promise<string[]> {
  const url = `${origin}/api/stream/${infoHash}/${torrentFilePath
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
  const notes: string[] = [];

  const probeByte = await fetch(url, { headers: { range: "bytes=0-0" } });
  const probeBody = await probeByte.arrayBuffer();
  if (probeByte.status === 206 && probeBody.byteLength === 1) {
    notes.push("PASS  bytes=0-0 returns exactly one byte (the `end: 0` widening trap is floored)");
  } else {
    failures += 1;
    notes.push(`FAIL  bytes=0-0 returned ${probeByte.status} with ${probeBody.byteLength} bytes`);
  }

  const tailStart = Math.max(0, fileLength - 64 * 1024);
  const tail = await fetch(url, { headers: { range: `bytes=${tailStart}-${fileLength - 1}` } });
  const tailBody = await tail.arrayBuffer();
  if (tail.status === 206 && tailBody.byteLength === fileLength - tailStart) {
    notes.push("PASS  a tail range is served whole (MKV Cues live at the end of the file)");
  } else {
    failures += 1;
    notes.push(`FAIL  tail range returned ${tail.status} with ${tailBody.byteLength} bytes`);
  }

  const bad = await fetch(url, { headers: { range: `bytes=${fileLength + 10}-${fileLength + 20}` } });
  if (bad.status === 416) {
    notes.push("PASS  an out-of-bounds range is refused with 416");
  } else {
    failures += 1;
    notes.push(`FAIL  out-of-bounds range returned ${bad.status}, expected 416`);
  }

  return notes;
}

async function main() {
  console.log("── Generating fixtures ──");
  const fixtures = torrentFixtures(CLIP_SECONDS);
  const seedFiles = fixtures.map((f) => {
    const out = generateFixture(f, SEED_DIR);
    const size = Math.round(fs.statSync(out).size / 1024);
    const probed = probeFile(out);
    const audio = probed?.streams.find((s) => s.codecType === "audio");
    console.log(`  ok   ${f.file} (${size} KiB, ${audio?.codec ?? "no audio"}/${audio?.channels ?? 0}ch)`);
    return out;
  });

  console.log("\n── Local swarm ──");
  const swarm = await startLocalSwarm();
  console.log(`  tracker ${swarm.trackerUrl} (no public tracker is ever contacted)`);

  const stream = await startStreamServer();
  console.log(`  stream route mounted at ${stream.origin}/api/stream/...`);

  const rangeNotes: string[] = [];
  try {
    console.log("\n── Torrent → stream route → ffmpeg ──");
    for (let i = 0; i < fixtures.length; i += 1) {
      const seeded = await swarm.seed(seedFiles[i]);
      console.log(`  seeding ${seeded.filePath} as ${seeded.infoHash.slice(0, 8)}`);
      rows.push(
        await runCase(fixtures[i], stream.origin, seeded.magnetURI, seeded.infoHash, seeded.filePath),
      );
      if (i === 0) {
        console.log("\n── Range semantics against a live torrent ──");
        rangeNotes.push(
          ...(await verifyRangeSemantics(
            stream.origin,
            seeded.infoHash,
            seeded.filePath,
            seeded.length,
          )),
        );
        for (const note of rangeNotes) console.log(`  ${note}`);
      }
    }
  } finally {
    stopAllSessions();
    await stream.close();
    // Destroy the engine's torrents before the seeder goes, or the leecher
    // spends its teardown retrying a peer that no longer exists.
    for (const t of await builtinClient.listTorrents(CONFIG).catch(() => [])) {
      if (t.hash) await builtinClient.deleteTorrent?.(CONFIG, t.hash, true).catch(() => undefined);
    }
    await swarm.close();
    // Windows holds the segment files open for a moment after the kill, so the
    // synchronous rmdir inside stopAllSessions can lose the race with EBUSY.
    await new Promise((resolve) => setTimeout(resolve, 750));
    await cleanupStaleSessionDirs().catch(() => undefined);
    fs.rmSync(WORK, { recursive: true, force: true });
  }

  console.log("\n── Results (bytes sourced from a real BitTorrent swarm) ──\n");
  console.log(
    table(
      ["Case", "Hash", "Peers", "Rung", "Video out", "Audio out", "Ch in→out", "TTFS", "Result", "Detail"],
      rows.map((r) => [
        r.name,
        r.infoHash,
        r.peers,
        r.rung,
        r.videoOut,
        r.audioOut,
        r.channels,
        r.ttfs,
        r.result,
        r.detail,
      ]),
    ),
  );

  console.log(
    failures === 0
      ? "\nPASS — the ladder works on bytes pulled through WebTorrent, not just HTTP."
      : `\nFAIL — ${failures} check(s) failed.`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nFAIL —", err instanceof Error ? err.stack : String(err));
  try {
    stopAllSessions();
    fs.rmSync(WORK, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  process.exit(1);
});
