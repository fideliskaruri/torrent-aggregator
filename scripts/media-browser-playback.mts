/**
 * The strongest available proof: real media, the real pipeline, and a real
 * browser actually decoding the output.
 *
 * Everything else in this repo verifies the pipeline against ffprobe. That
 * proves the bytes are what we intended, but not that Edge will play them —
 * and "the file is technically correct but the browser shows a black screen"
 * is precisely the failure this whole effort exists to eliminate.
 *
 * So this harness closes the loop:
 *   1. Ask a real Edge instance what it can decode (no assumed capability list).
 *   2. Feed that answer to the real `decidePlayback`.
 *   3. Run the real ffmpeg session.
 *   4. Load the produced playlist in that same Edge instance through hls.js and
 *      assert the video element actually advances and paints frames.
 *
 * Run: npx tsx scripts/media-browser-playback.mts
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { chromium, type Browser, type Page } from "playwright";

import { probeUrl } from "../src/lib/media/probe";
import { decidePlayback, type PlaybackRung } from "../src/lib/media/decide";
import type { ClientCapabilities, CodecEntry } from "../src/lib/media/capabilities";
import { getOrCreateSession, waitForSessionFile, stopAllSessions } from "../src/lib/media/session";

const require = createRequire(import.meta.url);
const FFMPEG: string = require("ffmpeg-static");
const HLS_JS = require.resolve("hls.js/dist/hls.min.js");

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "tf-browser-"));

/** The exact MIME list the player probes — keep in sync with inline-player.tsx. */
const CODEC_PROBES = [
  'video/mp4; codecs="avc1.640028,mp4a.40.2"',
  'video/mp4; codecs="avc1.640028,ac-3"',
  'video/mp4; codecs="avc1.640028,ec-3"',
  'video/mp4; codecs="avc1.640028"',
  'video/mp4; codecs="hvc1.1.6.L93.B0"',
  'video/mp4; codecs="hev1.1.6.L93.B0"',
  'video/mp4; codecs="hvc1.2.4.L120.B0"',
  'video/mp4; codecs="hvc1.1.6.L93.B0,ac-3"',
  'video/mp4; codecs="av01.0.05M.08"',
  'video/mp4; codecs="vp09.00.10.08"',
  'video/webm; codecs="vp9,opus"',
  'audio/mp4; codecs="mp4a.40.2"',
  'audio/mp4; codecs="flac"',
  'audio/mp4; codecs="ac-3"',
  'audio/mp4; codecs="ec-3"',
  'audio/mp4; codecs="dtsc"',
  'audio/mp4; codecs="mlpa"',
  'video/x-matroska; codecs="avc1.640028,mp4a.40.2"',
];

type Case = {
  name: string;
  file: string;
  encode: string[];
  expectRung: PlaybackRung;
  expectChannels: number;
};

const DUR = "12";

const CASES: Case[] = [
  {
    name: "H.264 + AAC 5.1 / MKV",
    file: "h264_aac51.mkv",
    encode: [
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "24",
      "-c:a", "aac", "-ac", "6", "-strict", "-2",
    ],
    expectRung: "remux",
    expectChannels: 6,
  },
  {
    name: "HEVC + AC-3 5.1 / MKV",
    file: "hevc_ac3_51.mkv",
    encode: [
      "-c:v", "libx265", "-x265-params", "log-level=error:keyint=24", "-pix_fmt", "yuv420p",
      "-c:a", "ac3", "-ac", "6",
    ],
    expectRung: "remux",
    expectChannels: 6,
  },
  {
    name: "HEVC Main10 + E-AC-3 5.1 / MKV",
    file: "hevc10_eac3_51.mkv",
    encode: [
      "-c:v", "libx265", "-x265-params", "log-level=error:keyint=24", "-pix_fmt", "yuv420p10le",
      "-c:a", "eac3", "-ac", "6",
    ],
    expectRung: "remux",
    expectChannels: 6,
  },
  {
    name: "H.264 + DTS 5.1 / MKV",
    file: "h264_dts51.mkv",
    encode: [
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "24",
      "-c:a", "dca", "-ac", "6", "-strict", "-2",
    ],
    expectRung: "transcode-audio",
    expectChannels: 6,
  },
  {
    name: "MPEG-2 + MP2 / MKV",
    file: "mpeg2_mp2.mkv",
    encode: [
      "-c:v", "mpeg2video", "-pix_fmt", "yuv420p", "-g", "24", "-b:v", "2M",
      "-c:a", "mp2", "-ac", "2",
    ],
    expectRung: "transcode-full",
    expectChannels: 2,
  },
  {
    name: "WMV2 + WMAv2 / AVI",
    file: "wmv2.avi",
    encode: [
      "-c:v", "wmv2", "-pix_fmt", "yuv420p", "-g", "24", "-b:v", "2M",
      "-c:a", "wmav2", "-ac", "2",
    ],
    expectRung: "transcode-full",
    expectChannels: 2,
  },
];

type Row = {
  name: string;
  rung: string;
  played: boolean;
  currentTime: number;
  resolution: string;
  acceptedCodecs: string;
  detail: string;
  status: "PASS" | "FAIL";
};

const rows: Row[] = [];
let failures = 0;

/** Serves the generated sources with byte-range support (stands in for /api/stream). */
function startServer(roots: Record<string, string>) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const mount = segments.shift() ?? "";
    const root = roots[mount];
    if (!root) {
      res.writeHead(404).end();
      return;
    }
    const abs = path.resolve(root, ...segments);
    if (!abs.startsWith(path.resolve(root)) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      res.writeHead(404).end();
      return;
    }
    const size = fs.statSync(abs).size;
    const type = abs.endsWith(".m3u8")
      ? "application/vnd.apple.mpegurl"
      : abs.endsWith(".m4s")
        ? "video/iso.segment"
        : abs.endsWith(".mp4")
          ? "video/mp4"
          : abs.endsWith(".js")
            ? "text/javascript"
            : "application/octet-stream";
    const headers: Record<string, string> = {
      "Accept-Ranges": "bytes",
      "Content-Type": type,
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    };
    const m = /^bytes=(\d*)-(\d*)$/.exec((req.headers.range ?? "").trim());
    const start = m && m[1] ? Number(m[1]) : 0;
    const end = m && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (m && (start > end || start >= size)) {
      res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
      return;
    }
    if (m) {
      headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
      headers["Content-Length"] = String(end - start + 1);
      res.writeHead(206, headers);
    } else {
      headers["Content-Length"] = String(size);
      res.writeHead(200, headers);
    }
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    fs.createReadStream(abs, { start, end }).pipe(res);
  });
  return new Promise<{ origin: string; close: () => Promise<void> }>((resolve) => {
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

/** Ask the real browser what it can decode — no assumed capability table. */
async function measureCapabilities(page: Page): Promise<ClientCapabilities> {
  await page.setContent("<!doctype html><title>probe</title><video></video>");
  const codecs = await page.evaluate((mimes: string[]) => {
    const video = document.querySelector("video") as HTMLVideoElement;
    return mimes.map((mime) => ({
      mime,
      canPlay: video.canPlayType(mime) || "",
      mse:
        typeof MediaSource !== "undefined" && typeof MediaSource.isTypeSupported === "function"
          ? MediaSource.isTypeSupported(mime)
          : false,
    }));
  }, CODEC_PROBES);
  const ua = await page.evaluate(() => navigator.userAgent);
  return { ua, codecs: codecs as CodecEntry[], mseSupported: true };
}

type PlayResult = {
  ok: boolean;
  currentTime: number;
  width: number;
  height: number;
  acceptedCodecs: string | null;
  error: string | null;
};

/** Drive hls.js exactly the way the player does and see whether frames advance. */
async function playInBrowser(page: Page, origin: string, playlistUrl: string): Promise<PlayResult> {
  await page.setContent(
    `<!doctype html><title>playback</title>
     <video id="v" muted playsinline></video>
     <script src="${origin}/hls/hls.min.js"></script>`,
    { waitUntil: "load" },
  );

  return page.evaluate(async (url: string): Promise<PlayResult> => {
    type HlsCtor = new (config: Record<string, unknown>) => {
      loadSource(u: string): void;
      attachMedia(v: HTMLMediaElement): void;
      on(event: string, cb: (e: unknown, data: { fatal?: boolean; details?: string; type?: string }) => void): void;
      destroy(): void;
    };
    const w = window as unknown as { Hls?: HlsCtor & { isSupported(): boolean; Events: Record<string, string>; ErrorTypes: Record<string, string> } };
    const Hls = w.Hls;
    const video = document.getElementById("v") as HTMLVideoElement;
    if (!Hls || !Hls.isSupported()) {
      return { ok: false, currentTime: 0, width: 0, height: 0, acceptedCodecs: null, error: "hls.js unsupported" };
    }

    const hls = new Hls({ enableWorker: false, maxBufferLength: 10 });
    let fatal: string | null = null;
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (data.fatal) fatal = `${data.type}/${data.details}`;
    });
    // BUFFER_CODECS carries the codec strings hls.js derived from the real fMP4
    // init segment and handed to addSourceBuffer(). A media playlist has no
    // CODECS attribute, so MANIFEST_PARSED alone tells us nothing.
    const buffered: string[] = [];
    hls.on(Hls.Events.BUFFER_CODECS, (_e, data) => {
      for (const track of Object.values(data as unknown as Record<string, { container?: string; codec?: string }>)) {
        if (track?.codec) buffered.push(track.codec);
      }
    });
    hls.loadSource(url);
    hls.attachMedia(video);

    // Wait for playback to genuinely advance — `canplay` alone is not proof the
    // decoder produced frames, and a black screen fires it happily.
    const advanced = await new Promise<boolean>((resolve) => {
      const deadline = Date.now() + 30_000;
      const tick = setInterval(() => {
        if (fatal) {
          clearInterval(tick);
          resolve(false);
          return;
        }
        if (video.currentTime > 0.4 && video.readyState >= 2) {
          clearInterval(tick);
          resolve(true);
          return;
        }
        if (video.paused) void video.play().catch(() => {});
        if (Date.now() > deadline) {
          clearInterval(tick);
          resolve(false);
        }
      }, 200);
    });

    // Which codecs MSE actually accepted a SourceBuffer for. This is the honest
    // browser-side signal: the decoder channel count is not exposed by any web
    // API (`createMediaElementSource().channelCount` always reports 2 and says
    // nothing about the stream), so channel preservation is proven by
    // re-probing the output in media-ladder-e2e.mts instead.
    const result: PlayResult = {
      ok: advanced,
      currentTime: video.currentTime,
      width: video.videoWidth,
      height: video.videoHeight,
      acceptedCodecs: buffered.length > 0 ? buffered.join(",") : null,
      error: fatal,
    };
    hls.destroy();
    return result;
  }, playlistUrl);
}

/**
 * Where playback *starts* is a separate question from whether it plays.
 *
 * ffmpeg writes an EVENT playlist and only appends `#EXT-X-ENDLIST` when it
 * finishes, so for as long as a session is still muxing, hls.js classes it as
 * live and — left to itself — starts at the live edge. On a file that remuxes
 * faster than real time, that means pressing play drops the viewer a minute and
 * a half into the film. This replays a real session's playlist with the ENDLIST
 * stripped (exactly the mid-mux state) and checks the config the player ships.
 */
async function checkStartsAtBeginning(page: Page, caps: ClientCapabilities): Promise<number> {
  console.log("\n── Start position on a still-growing playlist ──");

  // Long enough that the live edge is unmistakably far from the start.
  const file = "startpos_long.mkv";
  const src = path.join(WORK, file);
  const seconds = 120;
  const gen = spawnSync(
    FFMPEG,
    [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", `testsrc2=size=320x180:rate=24:duration=${seconds}`,
      "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}:sample_rate=48000`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "24",
      "-c:a", "aac", "-ac", "2",
      "-shortest", src,
    ],
    { encoding: "utf8", timeout: 300_000 },
  );
  if (gen.status !== 0 || !fs.existsSync(src)) {
    console.log(`  FAIL  could not generate ${file}: ${gen.stderr?.slice(-300)}`);
    return 1;
  }

  const srcServer = await startServer({ src: WORK });
  let failed = 0;
  try {
    const outcome = await probeUrl(`${srcServer.origin}/src/${file}`, { timeoutMs: 30_000 });
    if (!outcome.ok) {
      console.log(`  FAIL  probe failed: ${outcome.error.message}`);
      return 1;
    }
    const plan = decidePlayback(outcome.result, caps);
    const created = getOrCreateSession("startpos", file, plan, `${srcServer.origin}/src/${file}`);
    if (!created.ok) {
      console.log(`  FAIL  session failed: ${created.error}`);
      return 1;
    }
    const session = created.session;
    // 10 segments at 4s each => a live edge ~36s in, far past any start tolerance.
    const ready = await waitForSessionFile(session, path.join(session.outputDir, "seg00010.m4s"), 120_000);
    if (!ready) {
      console.log(`  FAIL  session never produced enough segments (state=${session.state})`);
      return 1;
    }

    // Same bytes, no ENDLIST: exactly what the player sees while ffmpeg is still muxing.
    const growing = fs
      .readFileSync(session.manifestPath, "utf8")
      .replace(/#EXT-X-ENDLIST\s*/g, "");
    fs.writeFileSync(path.join(session.outputDir, "growing.m3u8"), growing);

    const outServer = await startServer({ hls: path.dirname(HLS_JS), out: session.outputDir });
    try {
      const url = `${outServer.origin}/out/growing.m3u8`;
      const auto = await measureStartPosition(page, outServer.origin, url, null);
      const pinned = await measureStartPosition(page, outServer.origin, url, 0);
      console.log(`  hls.js defaults landed at ${auto.toFixed(1)}s (live edge)`);
      const ok = pinned >= 0 && pinned < 5;
      console.log(
        `  ${ok ? "PASS" : "FAIL"}  the player's startPosition:0 begins at the start — ${pinned.toFixed(1)}s`,
      );
      if (!ok) failed += 1;
    } finally {
      await outServer.close();
    }
  } finally {
    stopAllSessions();
    await srcServer.close();
  }
  return failed;
}

/** Load a playlist with a given startPosition and report where playback landed. */
async function measureStartPosition(
  page: Page,
  origin: string,
  playlistUrl: string,
  startPosition: number | null,
): Promise<number> {
  await page.setContent(
    `<!doctype html><title>startpos</title>
     <video id="v" muted playsinline></video>
     <script src="${origin}/hls/hls.min.js"></script>`,
    { waitUntil: "load" },
  );
  return page.evaluate(
    async (args: { url: string; startPosition: number | null }): Promise<number> => {
      type HlsCtor = new (config: Record<string, unknown>) => {
        loadSource(u: string): void;
        attachMedia(v: HTMLMediaElement): void;
        destroy(): void;
      };
      const w = window as unknown as { Hls?: HlsCtor & { isSupported(): boolean } };
      const Hls = w.Hls;
      const video = document.getElementById("v") as HTMLVideoElement;
      if (!Hls || !Hls.isSupported()) return -1;
      const config: Record<string, unknown> = { enableWorker: false, maxBufferLength: 10 };
      if (args.startPosition !== null) config.startPosition = args.startPosition;
      const hls = new Hls(config);
      hls.loadSource(args.url);
      hls.attachMedia(video);
      const landed = await new Promise<number>((resolve) => {
        const deadline = Date.now() + 30_000;
        const tick = setInterval(() => {
          if (video.readyState >= 2 && video.currentTime > 0) {
            clearInterval(tick);
            resolve(video.currentTime);
            return;
          }
          if (video.paused) void video.play().catch(() => {});
          if (Date.now() > deadline) {
            clearInterval(tick);
            resolve(video.currentTime);
          }
        }, 200);
      });
      hls.destroy();
      return landed;
    },
    { url: playlistUrl, startPosition },
  );
}

async function main() {
  console.log("── Generating test media ──");
  for (const c of CASES) {
    const out = path.join(WORK, c.file);
    const res = spawnSync(
      FFMPEG,
      [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", `testsrc2=size=640x360:rate=24:duration=${DUR}`,
        "-f", "lavfi", "-i", `sine=frequency=440:duration=${DUR}:sample_rate=48000`,
        ...c.encode,
        "-shortest", out,
      ],
      { encoding: "utf8", timeout: 300_000 },
    );
    if (res.status !== 0 || !fs.existsSync(out)) {
      console.error(`  FAIL ${c.file}: ${res.stderr?.slice(-400)}`);
      process.exit(1);
    }
    console.log(`  ok   ${c.file} (${(fs.statSync(out).size / 1024).toFixed(0)} KiB)`);
  }

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ channel: "msedge", headless: true });
  } catch (err) {
    console.error(`\nSKIP — could not launch Edge: ${err instanceof Error ? err.message : String(err)}`);
    fs.rmSync(WORK, { recursive: true, force: true });
    process.exit(0);
  }

  const page = await browser.newPage();
  const caps = await measureCapabilities(page);
  console.log(`\nbrowser: ${caps.ua}`);
  const supported = caps.codecs.filter((c) => c.mse && c.canPlay !== "").map((c) => c.mime);
  console.log(`MSE-supported: ${supported.length}/${caps.codecs.length} probed MIME types`);
  console.log(
    `  MKV under MSE: ${caps.codecs.find((c) => c.mime.includes("matroska"))?.mse ? "SUPPORTED" : "NOT supported (this is why remux exists)"}\n`,
  );

  console.log("── Pipeline → browser ──");
  for (const c of CASES) {
    const row: Row = {
      name: c.name,
      rung: "-",
      played: false,
      currentTime: 0,
      resolution: "-",
      acceptedCodecs: "-",
      detail: "",
      status: "FAIL",
    };
    rows.push(row);

    // Serve the source, run the real pipeline against it.
    const srcServer = await startServer({ src: WORK });
    const outcome = await probeUrl(`${srcServer.origin}/src/${c.file}`, { timeoutMs: 30_000 });
    if (!outcome.ok) {
      row.detail = `probe failed: ${outcome.error.message}`;
      failures += 1;
      await srcServer.close();
      continue;
    }

    const plan = decidePlayback(outcome.result, caps);
    row.rung = plan.rung;
    if (plan.rung !== c.expectRung) {
      row.detail = `expected rung ${c.expectRung}`;
      failures += 1;
      await srcServer.close();
      continue;
    }

    const created = getOrCreateSession("browser", c.file, plan, `${srcServer.origin}/src/${c.file}`);
    if (!created.ok) {
      row.detail = created.error;
      failures += 1;
      await srcServer.close();
      continue;
    }
    const session = created.session;
    const ready =
      (await waitForSessionFile(session, path.join(session.outputDir, "seg00001.m4s"), 90_000)) &&
      (await waitForSessionFile(session, session.manifestPath, 15_000));
    if (!ready) {
      row.detail = `session produced nothing (state=${session.state}, ${session.error ?? "no error"})`;
      failures += 1;
      stopAllSessions();
      await srcServer.close();
      continue;
    }

    // Serve the session output and hls.js, then actually play it.
    const outServer = await startServer({
      hls: path.dirname(HLS_JS),
      out: session.outputDir,
    });
    const result = await playInBrowser(page, outServer.origin, `${outServer.origin}/out/playlist.m3u8`);

    row.played = result.ok;
    row.currentTime = Number(result.currentTime.toFixed(2));
    row.resolution = result.width > 0 ? `${result.width}x${result.height}` : "no frames";
    row.acceptedCodecs = result.acceptedCodecs ?? "?";
    if (!result.ok) {
      row.detail = result.error ?? "playback never advanced";
      failures += 1;
    } else if (result.width === 0) {
      row.detail = "advanced but produced no video frames";
      failures += 1;
    } else {
      row.status = "PASS";
    }

    console.log(
      `  ${row.status}  ${c.name}: rung=${row.rung}, t=${row.currentTime}s, ${row.resolution}` +
        (row.detail ? ` — ${row.detail}` : ""),
    );

    await outServer.close();
    stopAllSessions();
    await srcServer.close();
  }

  failures += await checkStartsAtBeginning(page, caps);

  await browser.close();
  stopAllSessions();
  fs.rmSync(WORK, { recursive: true, force: true });

  const headers = ["Case", "Rung", "Played", "t (s)", "Frames", "MSE codecs", "Result", "Detail"];
  const data = rows.map((r) => [
    r.name,
    r.rung,
    r.played ? "yes" : "no",
    String(r.currentTime),
    r.resolution,
    r.acceptedCodecs,
    r.status,
    r.detail || "-",
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...data.map((d) => d[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  console.log("\n── Browser playback results ──\n");
  console.log(line(headers));
  console.log(widths.map((w) => "─".repeat(w)).join("  "));
  for (const d of data) console.log(line(d));

  if (failures > 0) {
    console.error(`\nFAIL — ${failures} case(s) did not play in the browser`);
    process.exit(1);
  }
  console.log("\nPASS — every remux/transcode output decoded and played in Edge.");
}

main().catch((err) => {
  console.error(err);
  stopAllSessions();
  fs.rmSync(WORK, { recursive: true, force: true });
  process.exit(1);
});
