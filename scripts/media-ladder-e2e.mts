/**
 * Real-media end-to-end verification of the playback ladder.
 *
 * Everything the ladder decides is downstream of two things: what ffprobe
 * actually reports for a real file, and what ffmpeg actually produces when we
 * spawn it. Synthetic ffprobe JSON verifies neither. This harness therefore:
 *
 *   1. Generates a matrix of real files with the *bundled* ffmpeg (no network,
 *      no torrent, no system dependencies).
 *   2. Serves them over a local range-capable HTTP server, so the pipeline sees
 *      exactly the kind of source it sees in production (`/api/stream/...`).
 *   3. Runs the real `probeUrl` → `decidePlayback` → `getOrCreateSession` chain.
 *   4. Re-probes the *output* (init segment + first media segment concatenated)
 *      and asserts codecs and channel counts survived. The owner's hard rule is
 *      that 5.1 must never silently become stereo — so we measure it.
 *
 * Run: npx tsx scripts/media-ladder-e2e.mts
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import os from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import { probeUrl } from "../src/lib/media/probe";
import {
  parseProbeOutput,
  type ProbeResult,
} from "../src/lib/media/probe-shape.js";
import { DEFAULT_CAPABILITIES, type ClientCapabilities } from "../src/lib/media/capabilities";
import { decidePlayback, type PlaybackPlan, type PlaybackRung } from "../src/lib/media/decide";
import {
  getOrCreateSession,
  waitForSessionFile,
  stopAllSessions,
  cleanupStaleSessionDirs,
  sessionsDir,
} from "../src/lib/media/session";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const FFMPEG: string = require("ffmpeg-static");
const FFPROBE: string = (require("ffprobe-static") as { path: string }).path;

/** Scratch lives outside the repo so a crashed run cannot leave junk behind. */
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "tf-ladder-"));

// ── Capabilities: the empirically measured Edge/Chromium profile ──
//
// Measured on the owner's machine with scripts/probe-codecs.mjs. The single
// most important fact is that `video/x-matroska` is NOT supported under
// MediaSource — that is what forces the remux rung for the majority of
// x265/Bluray releases.
const EDGE_MIMES: Array<[string, boolean]> = [
  ['video/mp4; codecs="avc1.640028"', true],
  ['video/mp4; codecs="avc1.42E01E"', true],
  ['video/mp4; codecs="hvc1.1.6.L93.B0"', true],
  ['video/mp4; codecs="hvc1.2.4.L120.B0"', true],
  ['video/mp4; codecs="hev1.1.6.L93.B0"', true],
  ['video/mp4; codecs="av01.0.08M.08"', true],
  ['video/mp4; codecs="vp09.00.10.08"', true],
  ['video/mp4; codecs="mp4a.40.2"', true],
  ['video/mp4; codecs="mp4a.40.5"', true],
  ['video/mp4; codecs="ac-3"', true],
  ['video/mp4; codecs="ec-3"', true],
  ['video/mp4; codecs="fLaC"', true],
  // Not supported — the real blockers.
  ["video/x-matroska", false],
  ['video/x-matroska; codecs="avc1.640028,mp4a.40.2"', false],
  ['video/mp4; codecs="dtsc"', false],
  ['video/mp4; codecs="mlpa"', false],
  ['video/mp4; codecs="mp2v.61"', false],
  ['video/mp4; codecs="vc-1"', false],
  ['video/mp4; codecs="wmv3"', false],
  ['audio/mp4; codecs="wmav2"', false],
];

const EDGE_CAPS: ClientCapabilities = {
  ...DEFAULT_CAPABILITIES,
  ua: "e2e-edge-chromium",
  mseSupported: true,
  codecs: EDGE_MIMES.map(([mime, ok]) => ({
    mime,
    canPlay: ok ? "probably" : "",
    mse: ok,
  })),
};

// ── Test matrix ──

type Case = {
  name: string;
  file: string;
  /** ffmpeg args after the shared `testsrc2`/`sine` inputs. */
  encode: string[];
  expectRung: PlaybackRung;
  /** Channels the pipeline must preserve end to end. */
  expectChannels: number | null;
  note?: string;
};

const DUR = "4";
/** Long, deliberately slow-served source used only by the orphan-kill check. */
const ORPHAN_SOURCE = "orphan_long.mkv";

/** Shared synthetic sources: colour bars + a tone per audio channel group. */
function inputArgs(channels: number): string[] {
  const args = ["-f", "lavfi", "-i", `testsrc2=size=640x360:rate=24:duration=${DUR}`];
  if (channels > 0) {
    args.push("-f", "lavfi", "-i", `sine=frequency=440:duration=${DUR}:sample_rate=48000`);
  }
  return args;
}

const CASES: Case[] = [
  {
    name: "H.264 + AAC stereo / MP4",
    file: "h264_aac_stereo.mp4",
    encode: [
      ...inputArgs(2),
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "24",
      "-c:a", "aac", "-ac", "2",
      "-shortest",
    ],
    expectRung: "direct",
    expectChannels: 2,
  },
  {
    name: "H.264 + AAC 5.1 / MKV",
    file: "h264_aac51.mkv",
    encode: [
      ...inputArgs(6),
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "24",
      "-c:a", "aac", "-ac", "6", "-strict", "-2",
      "-shortest",
    ],
    expectRung: "remux",
    expectChannels: 6,
  },
  {
    name: "HEVC + AC-3 5.1 / MKV",
    file: "hevc_ac3_51.mkv",
    encode: [
      ...inputArgs(6),
      "-c:v", "libx265", "-pix_fmt", "yuv420p", "-x265-params", "log-level=error:keyint=24",
      "-c:a", "ac3", "-ac", "6",
      "-shortest",
    ],
    expectRung: "remux",
    expectChannels: 6,
  },
  {
    name: "HEVC Main10 + E-AC-3 5.1 / MKV",
    file: "hevc10_eac3_51.mkv",
    encode: [
      ...inputArgs(6),
      "-c:v", "libx265", "-pix_fmt", "yuv420p10le", "-x265-params", "log-level=error:keyint=24",
      "-c:a", "eac3", "-ac", "6",
      "-shortest",
    ],
    expectRung: "remux",
    expectChannels: 6,
  },
  {
    name: "H.264 + DTS 5.1 / MKV",
    file: "h264_dts51.mkv",
    encode: [
      ...inputArgs(6),
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "24",
      "-c:a", "dca", "-ac", "6", "-strict", "-2",
      "-shortest",
    ],
    expectRung: "transcode-audio",
    expectChannels: 6,
    note: "bundled ffmpeg's DTS encoder is experimental (-strict -2)",
  },
  {
    name: "MPEG-2 + MP2 / MKV",
    file: "mpeg2_mp2.mkv",
    encode: [
      ...inputArgs(2),
      "-c:v", "mpeg2video", "-pix_fmt", "yuv420p", "-g", "24", "-b:v", "2M",
      "-c:a", "mp2", "-ac", "2",
      "-shortest",
    ],
    expectRung: "transcode-full",
    expectChannels: 2,
  },
  {
    name: "WMV2 + WMAv2 / AVI",
    file: "wmv2.avi",
    encode: [
      ...inputArgs(2),
      "-c:v", "wmv2", "-pix_fmt", "yuv420p", "-g", "24", "-b:v", "2M",
      "-c:a", "wmav2", "-ac", "2",
      "-shortest",
    ],
    expectRung: "transcode-full",
    expectChannels: 2,
  },
  {
    name: "H.264, no audio / MKV",
    file: "h264_noaudio.mkv",
    encode: [
      ...inputArgs(0),
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "24",
      "-an",
    ],
    expectRung: "remux",
    expectChannels: null,
  },
  {
    name: "Multi-audio eng AC-3 5.1 + jpn AAC 2.0 / MKV",
    file: "multi_audio.mkv",
    encode: [
      "-f", "lavfi", "-i", `testsrc2=size=640x360:rate=24:duration=${DUR}`,
      "-f", "lavfi", "-i", `sine=frequency=440:duration=${DUR}:sample_rate=48000`,
      "-f", "lavfi", "-i", `sine=frequency=880:duration=${DUR}:sample_rate=48000`,
      "-map", "0:v", "-map", "1:a", "-map", "2:a",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "24",
      "-c:a:0", "ac3", "-ac:a:0", "6", "-metadata:s:a:0", "language=eng", "-metadata:s:a:0", "title=English 5.1",
      "-c:a:1", "aac", "-ac:a:1", "2", "-metadata:s:a:1", "language=jpn", "-metadata:s:a:1", "title=Japanese",
      "-shortest",
    ],
    expectRung: "remux",
    expectChannels: 6,
  },
];

// ── ffmpeg / ffprobe helpers ──

function run(bin: string, args: string[], timeoutMs = 180_000) {
  const res = spawnSync(bin, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function probeFile(file: string): ProbeResult | null {
  const res = run(FFPROBE, [
    "-v", "quiet",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    file,
  ]);
  if (res.code !== 0) return null;
  const outcome = parseProbeOutput(res.stdout);
  return outcome.ok ? outcome.result : null;
}

/**
 * fMP4 segments are not standalone files — the moov lives in `init.mp4`. To
 * probe the output the way a player consumes it, concatenate the init segment
 * with the first media segment and probe the result.
 */
function probeHlsOutput(outputDir: string): ProbeResult | null {
  const init = path.join(outputDir, "init.mp4");
  const segs = fs.readdirSync(outputDir).filter((f) => f.endsWith(".m4s")).sort();
  if (!fs.existsSync(init) || segs.length === 0) return null;
  const joined = path.join(outputDir, "_joined.mp4");
  fs.writeFileSync(joined, Buffer.concat([fs.readFileSync(init), fs.readFileSync(path.join(outputDir, segs[0]))]));
  const result = probeFile(joined);
  fs.rmSync(joined, { force: true });
  return result;
}

// ── Local range-capable file server (stands in for /api/stream) ──

type Server = { origin: string; close: () => Promise<void> };

function startFileServer(root: string): Promise<Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const name = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
      const slow = url.searchParams.has("slow");
      const abs = path.join(root, name);
      // Traversal guard — the harness serves a fixed dir, keep it that way.
      if (!abs.startsWith(root) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        res.writeHead(404).end();
        return;
      }
      const size = fs.statSync(abs).size;
      const range = req.headers.range;
      const headers: Record<string, string> = {
        "Accept-Ranges": "bytes",
        "Content-Type": "video/x-matroska",
      };
      if (req.method === "HEAD") {
        res.writeHead(200, { ...headers, "Content-Length": String(size) }).end();
        return;
      }
      const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
      const start = m ? (m[1] ? Number(m[1]) : 0) : 0;
      const end = m ? (m[2] ? Math.min(Number(m[2]), size - 1) : size - 1) : size - 1;
      if (m && (start > end || start >= size)) {
        res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
        return;
      }
      if (m) {
        res.writeHead(206, {
          ...headers,
          "Content-Range": `bytes ${start}-${end}/${size}`,
          "Content-Length": String(end - start + 1),
        });
      } else {
        res.writeHead(200, { ...headers, "Content-Length": String(size) });
      }

      const stream = fs.createReadStream(abs, { start, end, highWaterMark: slow ? 8192 : 64 * 1024 });
      if (!slow) {
        stream.pipe(res);
        return;
      }
      // Trickle mode: keeps ffmpeg alive and reading long enough for the orphan
      // test to hard-kill its parent while the child is genuinely still working.
      stream.on("data", (chunk) => {
        stream.pause();
        res.write(chunk);
        setTimeout(() => stream.resume(), 150);
      });
      stream.on("end", () => res.end());
      res.on("close", () => stream.destroy());
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

// ── Results ──

type Row = {
  name: string;
  container: string;
  vCodec: string;
  vProfile: string;
  aCodec: string;
  inCh: string;
  rung: string;
  rungOk: boolean;
  outVideo: string;
  outAudio: string;
  outCh: string;
  chOk: boolean;
  ttfsMs: number | null;
  status: "PASS" | "FAIL" | "SKIP";
  detail: string;
};

const rows: Row[] = [];
let failures = 0;

function fail(row: Row, detail: string) {
  row.status = "FAIL";
  row.detail = row.detail ? `${row.detail}; ${detail}` : detail;
  failures += 1;
}

// ── Main ──

async function main() {
  console.log(`ffmpeg  : ${FFMPEG}`);
  console.log(`ffprobe : ${FFPROBE}`);
  console.log(`workdir : ${WORK}\n`);

  // 1. Generate the matrix.
  console.log("── Generating test media ──");
  const generated = new Map<string, string>();
  for (const c of CASES) {
    const out = path.join(WORK, c.file);
    const res = run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...c.encode, out]);
    if (res.code !== 0 || !fs.existsSync(out)) {
      console.log(`  SKIP ${c.name}: ffmpeg could not produce it\n${res.stderr.slice(-400)}`);
      continue;
    }
    generated.set(c.file, out);
    console.log(`  ok   ${c.file} (${(fs.statSync(out).size / 1024).toFixed(0)} KiB)`);
  }
  console.log("");

  const server = await startFileServer(WORK);
  console.log(`serving ${WORK} at ${server.origin}\n`);

  // 2. Drive the real pipeline.
  console.log("── Driving the pipeline ──");
  for (const c of CASES) {
    const abs = generated.get(c.file);
    const row: Row = {
      name: c.name,
      container: "-", vCodec: "-", vProfile: "-", aCodec: "-", inCh: "-",
      rung: "-", rungOk: false,
      outVideo: "-", outAudio: "-", outCh: "-", chOk: false,
      ttfsMs: null, status: "PASS", detail: c.note ?? "",
    };
    rows.push(row);

    if (!abs) {
      row.status = "SKIP";
      row.detail = "ffmpeg could not generate this source";
      continue;
    }

    const sourceUrl = `${server.origin}/${encodeURIComponent(c.file)}`;

    // 2a. Real probe over HTTP through the real probeUrl code path.
    const outcome = await probeUrl(sourceUrl, { timeoutMs: 30_000 });
    if (!outcome.ok) {
      fail(row, `probeUrl failed: ${outcome.error}`);
      continue;
    }
    const probe = outcome.result;
    const v = probe.streams.find((s) => s.codecType === "video") ?? null;
    const audios = probe.streams.filter((s) => s.codecType === "audio");
    const a = audios[0] ?? null;
    row.container = probe.container;
    row.vCodec = v?.codec ?? "none";
    row.vProfile = v?.profile ?? "-";
    row.aCodec = audios.length ? audios.map((s) => `${s.codec}/${s.channels ?? "?"}ch`).join(" + ") : "none";
    row.inCh = a?.channels != null ? String(a.channels) : "-";

    if (v && v.pixFmt == null) fail(row, "probe did not report pix_fmt (decide.ts needs it for Main10)");

    // 2b. Real decision.
    const plan = decidePlayback(probe, EDGE_CAPS);
    row.rung = plan.rung;
    row.rungOk = plan.rung === c.expectRung;
    if (!row.rungOk) fail(row, `expected rung ${c.expectRung}, got ${plan.rung}`);

    // Channel preservation is a property of the *plan* too — assert it before
    // ffmpeg ever runs, so a bad plan is attributed to decide.ts not ffmpeg.
    for (const track of plan.audio) {
      const src = audios.find((s) => s.index === track.streamIndex);
      if (src?.channels != null && track.channels < src.channels) {
        fail(row, `plan downmixes stream ${track.streamIndex}: ${src.channels} → ${track.channels}`);
      }
    }

    if (plan.rung === "direct") {
      row.outVideo = "n/a (byte-range)";
      row.outAudio = "n/a";
      row.outCh = row.inCh;
      row.chOk = true;
      continue;
    }

    // 2c. Real ffmpeg session.
    const created = getOrCreateSession(`e2e${c.file.replace(/\W/g, "")}`.slice(0, 40), c.file, plan, sourceUrl);
    if (!created.ok) {
      fail(row, `session: ${created.error}`);
      continue;
    }
    const session = created.session;
    const seg0 = path.join(session.outputDir, "seg00000.m4s");
    const gotSeg = await waitForSessionFile(session, seg0, 60_000);
    if (!gotSeg) {
      fail(row, `no first segment (state=${session.state}, err=${session.error ?? "none"})`);
      stopAllSessions();
      continue;
    }
    row.ttfsMs = session.timeToFirstSegmentMs;

    const manifestOk = await waitForSessionFile(session, session.manifestPath, 15_000);
    if (!manifestOk) fail(row, "no playlist.m3u8");
    else {
      const m3u8 = fs.readFileSync(session.manifestPath, "utf8");
      if (!m3u8.includes("#EXTM3U")) fail(row, "playlist is not a valid m3u8");
      const mapMatch = /#EXT-X-MAP:URI="([^"]+)"/.exec(m3u8);
      if (!mapMatch) fail(row, "playlist has no EXT-X-MAP (fMP4 init)");
      else if (!fs.existsSync(path.join(session.outputDir, mapMatch[1]))) {
        // This is the exact bug that made every fMP4 session unplayable: ffmpeg
        // resolves -hls_fmp4_init_filename relative to CWD, not the segment dir.
        fail(row, `EXT-X-MAP points at "${mapMatch[1]}" which is not in the session dir`);
      }
    }

    // 2d. Re-probe the OUTPUT. This is the only honest proof of preservation.
    const outProbe = probeHlsOutput(session.outputDir);
    if (!outProbe) {
      fail(row, "could not probe the produced segments");
    } else {
      const ov = outProbe.streams.find((s) => s.codecType === "video") ?? null;
      const oa = outProbe.streams.find((s) => s.codecType === "audio") ?? null;
      row.outVideo = ov ? `${ov.codec}${ov.profile ? ` (${ov.profile})` : ""}` : "none";
      row.outAudio = oa ? oa.codec : "none";
      row.outCh = oa?.channels != null ? String(oa.channels) : "-";

      if (c.expectChannels == null) {
        row.chOk = oa == null;
        if (oa != null) fail(row, "expected no audio stream in the output");
      } else if (oa?.channels == null) {
        fail(row, "output has no audio channel count");
      } else {
        row.chOk = oa.channels >= c.expectChannels;
        if (!row.chOk) fail(row, `channels reduced: ${c.expectChannels} → ${oa.channels}`);
      }

      if (ov == null && v != null) fail(row, "video stream missing from the output");
      // Remux must be bit-exact on codec; transcode-audio must not touch video.
      if ((plan.rung === "remux" || plan.rung === "transcode-audio") && ov && v && ov.codec !== v.codec) {
        fail(row, `video was re-encoded on a copy rung: ${v.codec} → ${ov.codec}`);
      }
      if (plan.rung === "transcode-full" && ov && ov.codec !== "h264") {
        fail(row, `transcode-full produced ${ov.codec}, expected h264`);
      }
    }

    stopAllSessions();
  }

  // 3. Seek verification — the gap that used to 404.
  console.log("\n── Seek (session restart at offset) ──");
  const seekCase = generated.get("hevc_ac3_51.mkv");
  let seekDetail = "SKIP (source not generated)";
  if (seekCase) {
    const url = `${server.origin}/hevc_ac3_51.mkv`;
    const outcome = await probeUrl(url, { timeoutMs: 30_000 });
    if (outcome.ok) {
      const plan = decidePlayback(outcome.result, EDGE_CAPS);
      const created = getOrCreateSession("e2eseek", "hevc_ac3_51.mkv", plan, url, { startSec: 2 });
      if (created.ok) {
        const ok = await waitForSessionFile(created.session, path.join(created.session.outputDir, "seg00000.m4s"), 60_000);
        seekDetail = ok
          ? `PASS — session at startSec=2 produced segments in ${created.session.timeToFirstSegmentMs}ms`
          : `FAIL — no segment at startSec=2 (state=${created.session.state})`;
        if (!ok) failures += 1;
      } else {
        seekDetail = `FAIL — ${created.error}`;
        failures += 1;
      }
      stopAllSessions();
    }
  }
  console.log(`  ${seekDetail}`);

  // 4. Orphan cleanup — a killed parent must not leave a CPU-burning ffmpeg.
  console.log("\n── Orphan cleanup ──");
  // Needs a source long enough that ffmpeg is still working when its parent
  // dies: with `-hls_time 4` the first segment only lands once four seconds of
  // media have been muxed, and a four-second clip is finished by then.
  const longSource = path.join(WORK, ORPHAN_SOURCE);
  const longRes = run(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=180",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=180:sample_rate=48000",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "48",
    "-c:a", "ac3", "-ac", "6",
    "-shortest", longSource,
  ]);
  const orphanDetail =
    longRes.code === 0 && fs.existsSync(longSource)
      ? await verifyOrphanCleanup(server.origin)
      : "SKIP (could not generate a long source)";
  console.log(`  ${orphanDetail}`);
  if (orphanDetail.startsWith("FAIL")) failures += 1;
  if (orphanDetail.startsWith("INCONCLUSIVE")) {
    console.log("  (the sweep itself is exercised, but nothing was alive to kill)");
  }

  const sweepDetail = await verifySweepKillsRecordedPid();
  console.log(`  ${sweepDetail}`);
  if (sweepDetail.startsWith("FAIL")) failures += 1;

  await server.close();
  stopAllSessions();

  printTable();

  console.log(`\nseek        : ${seekDetail}`);
  console.log(`orphan sweep: ${orphanDetail}`);
  console.log(`stale sweep : ${sweepDetail}`);

  fs.rmSync(WORK, { recursive: true, force: true });

  if (failures > 0) {
    console.error(`\nFAIL — ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS — every case matched its expected rung and preserved its channel count");
}

/**
 * Spawn a detached child that starts a session and then dies without cleaning
 * up — exactly the Windows "parent exits, ffmpeg keeps burning CPU" scenario —
 * then prove `cleanupStaleSessionDirs()` reaps it.
 */
async function verifyOrphanCleanup(origin: string): Promise<string> {
  const helper = path.join(WORK, "orphan-helper.mts");
  // Absolute Windows paths are not valid ESM specifiers ("D:" parses as a URL
  // scheme) — the helper lives outside the repo, so it must use file:// URLs.
  const mod = (rel: string) => JSON.stringify(pathToFileURL(path.join(repoRoot, rel)).href);
  fs.writeFileSync(
    helper,
    `import { probeUrl } from ${mod("src/lib/media/probe.ts")};
import { decidePlayback } from ${mod("src/lib/media/decide.ts")};
import { getOrCreateSession, waitForSessionFile } from ${mod("src/lib/media/session.ts")};
const caps = ${JSON.stringify(EDGE_CAPS)};
const url = ${JSON.stringify(`${origin}/${ORPHAN_SOURCE}?slow=1`)};
const outcome = await probeUrl(url, { timeoutMs: 30000 });
if (!outcome.ok) { console.log("PROBE_FAILED"); process.exit(1); }
const plan = decidePlayback(outcome.result, caps);
const created = getOrCreateSession("e2eorphan", ${JSON.stringify(ORPHAN_SOURCE)}, plan, url);
if (!created.ok) { console.log("SESSION_FAILED"); process.exit(1); }
await waitForSessionFile(created.session, created.session.outputDir + "/seg00000.m4s", 60000);
console.log("READY " + created.session.outputDir);
// Deliberately hang: the harness hard-kills us to simulate a crashed server.
await new Promise(() => {});
`,
  );

  // Spawn node directly (not the tsx.cmd shim): on Windows a .cmd needs a shell,
  // and killing the shell would leave the real node process behind — the point
  // of this check is to kill *only* the parent and see whether ffmpeg survives.
  const child = spawn(process.execPath, ["--import", "tsx", helper], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });

  const outDir = await new Promise<string | null>((resolve) => {
    let buf = "";
    let errBuf = "";
    const timer = setTimeout(() => resolve(null), 120_000);
    child.stderr.on("data", (d: Buffer) => {
      errBuf += d.toString();
    });
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      const m = /READY (.+)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve(m[1].trim());
      }
      if (buf.includes("_FAILED")) {
        clearTimeout(timer);
        console.log(`  helper reported: ${buf.trim()}`);
        resolve(null);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (errBuf.trim()) console.log(`  helper exited ${code}: ${errBuf.trim().slice(-600)}`);
      resolve(null);
    });
  });

  if (!outDir) {
    child.kill("SIGKILL");
    return "SKIP (helper could not start a session)";
  }

  const pidFile = path.join(outDir, "ffmpeg.pid");
  let ffmpegPid = NaN;
  if (fs.existsSync(pidFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(pidFile, "utf8")) as { pid?: number };
      if (typeof parsed.pid === "number") ffmpegPid = parsed.pid;
    } catch {
      /* unreadable pid file is itself a failure, reported below */
    }
  }
  if (!Number.isFinite(ffmpegPid)) {
    child.kill("SIGKILL");
    return "FAIL — no readable ffmpeg.pid was written for the session";
  }

  const aliveBeforeKill = processAlive(ffmpegPid);

  // Hard-kill the *parent only*. On Windows the ffmpeg grandchild survives —
  // that is precisely the orphan we need to reap.
  child.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 1500));

  const aliveBefore = Number.isFinite(ffmpegPid) && processAlive(ffmpegPid);
  if (!aliveBefore) {
    return aliveBeforeKill
      ? "INCONCLUSIVE — ffmpeg died with its parent, so nothing was left to reap"
      : "INCONCLUSIVE — ffmpeg had already finished before the parent was killed";
  }
  const swept = await cleanupStaleSessionDirs();
  await new Promise((r) => setTimeout(r, 1000));
  const aliveAfter = processAlive(ffmpegPid);

  if (aliveAfter) return `FAIL — ffmpeg pid ${ffmpegPid} survived the sweep`;
  if (fs.existsSync(outDir)) return `FAIL — stale session dir ${outDir} was not removed`;
  return `PASS — ffmpeg pid ${ffmpegPid} outlived its killed parent and was reaped by the sweep (${swept.dirs} dir(s), ${swept.killed} process(es))`;
}

/**
 * Directly exercise the sweep's kill path with a real, genuinely orphaned
 * ffmpeg.
 *
 * `verifyOrphanCleanup` measures whether ffmpeg *does* outlive a killed parent
 * — on a given host it may not, which leaves the kill path untested. This is
 * the deterministic complement: spawn a detached, long-running ffmpeg, record it
 * exactly the way a session does, and assert `cleanupStaleSessionDirs()` finds
 * and kills it.
 */
async function verifySweepKillsRecordedPid(): Promise<string> {
  const dir = path.join(sessionsDir(), `e2e-sweep-${Date.now().toString(36)}`);
  fs.mkdirSync(dir, { recursive: true });

  // Reads from a source that never ends, so it cannot exit on its own.
  const proc = spawn(
    FFMPEG,
    ["-hide_banner", "-loglevel", "quiet", "-re", "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=5",
      "-t", "600", "-f", "null", "-"],
    { detached: true, stdio: "ignore" },
  );
  proc.unref();
  const pid = proc.pid;
  if (!pid) {
    fs.rmSync(dir, { recursive: true, force: true });
    return "FAIL — could not spawn a detached ffmpeg";
  }

  fs.writeFileSync(path.join(dir, "ffmpeg.pid"), JSON.stringify({ pid, startedAt: Date.now() }), "utf8");
  await new Promise((r) => setTimeout(r, 800));
  if (!processAlive(pid)) {
    fs.rmSync(dir, { recursive: true, force: true });
    return "FAIL — the detached ffmpeg exited before the sweep ran";
  }

  const swept = await cleanupStaleSessionDirs();
  await new Promise((r) => setTimeout(r, 1000));

  const stillAlive = processAlive(pid);
  const dirGone = !fs.existsSync(dir);
  if (stillAlive) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* best effort */
    }
    return `FAIL — sweep did not kill recorded ffmpeg pid ${pid}`;
  }
  if (!dirGone) return `FAIL — sweep did not remove ${dir}`;
  return `PASS — sweep killed detached ffmpeg pid ${pid} and removed its dir (${swept.dirs} dir(s), ${swept.killed} process(es))`;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function printTable() {
  const headers = ["Case", "Container", "Video in", "Audio in", "Rung", "Video out", "Audio out", "Ch in→out", "TTFS", "Result"];
  const data = rows.map((r) => [
    r.name,
    r.container,
    r.vProfile !== "-" ? `${r.vCodec} (${r.vProfile})` : r.vCodec,
    r.aCodec,
    r.rungOk ? r.rung : `${r.rung} ✗`,
    r.outVideo,
    r.outAudio,
    `${r.inCh}→${r.outCh}`,
    r.ttfsMs == null ? "-" : `${r.ttfsMs}ms`,
    r.status,
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...data.map((d) => d[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ");

  console.log("\n── Results ──\n");
  console.log(line(headers));
  console.log(widths.map((w) => "─".repeat(w)).join("  "));
  for (const d of data) console.log(line(d));

  const withDetail = rows.filter((r) => r.detail);
  if (withDetail.length) {
    console.log("\nNotes:");
    for (const r of withDetail) console.log(`  ${r.name}: ${r.detail}`);
  }
}

main().catch((err) => {
  console.error(err);
  try {
    stopAllSessions();
    fs.rmSync(WORK, { recursive: true, force: true });
  } catch {
    // best effort — the process is already failing
  }
  process.exit(1);
});
