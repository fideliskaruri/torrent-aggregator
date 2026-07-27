/**
 * Verifies the session stall watchdog against a source that goes quiet.
 *
 * This is the scenario `-rw_timeout` alone does not cover. Measured against the
 * bundled ffmpeg 6.1.1: when an HTTP source stops sending data without closing
 * the connection, `-rw_timeout` does abort the demuxer — but ffmpeg then exits
 * with **code 0**, which the original exit handler read as "finished cleanly".
 * The session would sit in `stopped` with a truncated playlist and the player
 * would buffer forever.
 *
 * Two independent guards are asserted here:
 *   1. the stderr scan that reclassifies an exit-0-after-demux-abort as stalled;
 *   2. the output-progress watchdog, which marks a session stalled when no new
 *      segment appears while ffmpeg is still alive.
 *
 * Run: npx tsx scripts/media-stall-watchdog.mts
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { probeUrl } from "../src/lib/media/probe";
import { decidePlayback } from "../src/lib/media/decide";
import { DEFAULT_CAPABILITIES, type ClientCapabilities } from "../src/lib/media/capabilities";
import { getOrCreateSession, waitForSessionFile, stopAllSessions } from "../src/lib/media/session";

const require = createRequire(import.meta.url);
const FFMPEG: string = require("ffmpeg-static");

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "tf-stall-"));
const SOURCE = path.join(WORK, "stall.mkv");

const CAPS: ClientCapabilities = {
  ...DEFAULT_CAPABILITIES,
  ua: "stall-test",
  codecs: [
    { mime: 'video/mp4; codecs="avc1.640028"', canPlay: "probably", mse: true },
    { mime: 'audio/mp4; codecs="mp4a.40.2"', canPlay: "probably", mse: true },
    { mime: 'video/x-matroska; codecs="avc1.640028,mp4a.40.2"', canPlay: "", mse: false },
  ],
};

/**
 * Serves `stallAfterBytes` and then holds the socket open forever without
 * sending or closing — the exact failure mode of a torrent whose swarm dries up
 * mid-file. A connection that merely closed would surface as a clean EOF and
 * would not exercise anything.
 */
function startStallingServer(file: string, stallAfterBytes: number) {
  const size = fs.statSync(file).size;
  const held: http.ServerResponse[] = [];
  const server = http.createServer((req, res) => {
    const range = /^bytes=(\d*)-(\d*)$/.exec((req.headers.range ?? "").trim());
    const start = range && range[1] ? Number(range[1]) : 0;
    const end = range && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;

    const headers: Record<string, string> = {
      "Accept-Ranges": "bytes",
      "Content-Type": "video/x-matroska",
      "Content-Length": String(end - start + 1),
    };
    if (range) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    res.writeHead(range ? 206 : 200, headers);

    // Serve the head of the requested range, then go silent while promising
    // (via Content-Length) that more is coming.
    const sendable = Math.max(0, Math.min(end - start + 1, stallAfterBytes - start));
    if (sendable > 0) {
      res.write(fs.readFileSync(file).subarray(start, start + sendable));
    }
    held.push(res);
  });

  return new Promise<{ origin: string; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => {
          for (const res of held) {
            try {
              res.destroy();
            } catch {
              /* already gone */
            }
          }
          server.closeAllConnections?.();
          server.close();
        },
      });
    });
  });
}

function serveWhole(file: string) {
  const size = fs.statSync(file).size;
  const server = http.createServer((req, res) => {
    const range = /^bytes=(\d*)-(\d*)$/.exec((req.headers.range ?? "").trim());
    const start = range && range[1] ? Number(range[1]) : 0;
    const end = range && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    const headers: Record<string, string> = {
      "Accept-Ranges": "bytes",
      "Content-Type": "video/x-matroska",
      "Content-Length": String(end - start + 1),
    };
    if (range) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    res.writeHead(range ? 206 : 200, headers);
    fs.createReadStream(file, { start, end }).pipe(res);
  });
  return new Promise<{ origin: string; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => {
          server.closeAllConnections?.();
          server.close();
        },
      });
    });
  });
}

let failures = 0;

function report(name: string, ok: boolean, detail: string) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}

async function main() {
  console.log("── Generating a source ──");
  const gen = spawnSync(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=120",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=120:sample_rate=48000",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "48",
    "-c:a", "aac", "-ac", "2", "-shortest", SOURCE,
  ], { encoding: "utf8", timeout: 180_000 });
  if (gen.status !== 0 || !fs.existsSync(SOURCE)) {
    console.error(`could not generate a source: ${gen.stderr}`);
    process.exit(1);
  }
  const size = fs.statSync(SOURCE).size;
  console.log(`  ${SOURCE} (${(size / 1024).toFixed(0)} KiB)\n`);

  // ── Probe the healthy file first: the plan must not depend on the stall. ──
  const healthy = await serveWhole(SOURCE);
  const probe = await probeUrl(`${healthy.origin}/stall.mkv`, { timeoutMs: 30_000 });
  healthy.close();
  if (!probe.ok) {
    console.error(`probe failed: ${probe.error.message}`);
    process.exit(1);
  }
  const plan = decidePlayback(probe.result, CAPS);
  console.log(`plan rung: ${plan.rung}\n`);

  // ── Case 1: the source goes quiet mid-file ──
  console.log("── A source that stops sending data mid-stream ──");
  const stalling = await startStallingServer(SOURCE, Math.floor(size * 0.35));
  const created = getOrCreateSession("stall1", "stall.mkv", plan, `${stalling.origin}/stall.mkv`);
  if (!created.ok) {
    console.error(`session failed: ${created.error}`);
    process.exit(1);
  }
  const session = created.session;

  // Enough data was served for a first segment; the stall comes after.
  const gotSegment = await waitForSessionFile(
    session,
    path.join(session.outputDir, "seg00000.m4s"),
    60_000,
  );
  report("first segment still arrives from the served prefix", gotSegment, `state=${session.state}`);

  const start = Date.now();
  const deadline = start + 120_000;
  while (session.state !== "stalled" && session.state !== "error" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    // A session that "finished" without consuming the whole file is the exact
    // silent failure this check exists for.
    if (session.state === "stopped") break;
  }
  const elapsed = Math.round((Date.now() - start) / 1000);

  report(
    "a stalled source is not reported as a clean finish",
    session.state === "stalled" || session.state === "error",
    `state=${session.state} after ${elapsed}s${session.error ? ` — ${session.error}` : ""}`,
  );
  report(
    "the watchdog's diagnosis survives the resulting ffmpeg exit",
    session.state === "stalled",
    `state=${session.state} (an exit handler must not overwrite it with a generic code)`,
  );
  report(
    "the session surfaces an actionable error",
    Boolean(session.error),
    session.error ?? "(none)",
  );
  report(
    "ffmpeg is not left running after the watchdog fires",
    session.process === null || session.process.killed,
    `process=${session.process === null ? "reaped" : session.process.killed ? "killed" : "ALIVE"}`,
  );

  stopAllSessions();
  stalling.close();

  // ── Case 2: a source that never sends anything at all ──
  console.log("\n── A source that never sends anything ──");
  const dead = await startStallingServer(SOURCE, 0);
  const created2 = getOrCreateSession("stall2", "stall.mkv", plan, `${dead.origin}/stall.mkv`);
  if (created2.ok) {
    const s2 = created2.session;
    const t0 = Date.now();
    const d2 = t0 + 120_000;
    while (s2.state === "starting" && Date.now() < d2) {
      await new Promise((r) => setTimeout(r, 500));
    }
    report(
      "a source that never delivers is failed, not left starting forever",
      s2.state !== "starting" && s2.state !== "running",
      `state=${s2.state} after ${Math.round((Date.now() - t0) / 1000)}s`,
    );
    report(
      "no orphaned ffmpeg after the startup timeout",
      s2.process === null || s2.process.killed,
      `process=${s2.process === null ? "reaped" : s2.process.killed ? "killed" : "ALIVE"}`,
    );
  } else {
    report("second session could be created", false, created2.error);
  }

  stopAllSessions();
  dead.close();
  fs.rmSync(WORK, { recursive: true, force: true });

  if (failures > 0) {
    console.error(`\nFAIL — ${failures} stall check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS — a stalled source can no longer hang a session.");
}

main().catch((err) => {
  console.error(err);
  stopAllSessions();
  fs.rmSync(WORK, { recursive: true, force: true });
  process.exit(1);
});
