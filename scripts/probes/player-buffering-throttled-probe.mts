/**
 * player-buffering-throttled-probe
 *
 * Proves the spinner-over-playing-video fix against a *genuinely buffering*
 * source. Unlike the sibling `player-buffering-overlay-probe` (which dispatches
 * a synthetic `waiting` event on a fully-downloaded fixture), this probe paces
 * the byte delivery of the fixture just below its real-time bitrate. The media
 * element's buffer stays shallow and briefly under-runs, so the browser fires
 * *native* `waiting` events WHILE `currentTime` keeps advancing — the exact
 * condition that used to leave a spinner sitting over an actively playing video.
 *
 * Assertions:
 *   1. Native `waiting` fired at least once (source really buffered).
 *   2. `currentTime` advanced from X to Y (video demonstrably kept playing).
 *   3. The buffering overlay/spinner was NEVER visible while the video was
 *      demonstrably advancing (advanced within the last 1500ms motion lease).
 *
 * Runs against a PRODUCTION build (`next start`) on a non-3000 port.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium, type Page, type Route } from "playwright";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const port = 3101;
const base = `http://127.0.0.1:${port}`;
const workDir = path.join(repoRoot, "scripts", "probes", "player-buffering-throttled-artifacts");
const mediaDir = path.join(workDir, "media");
const hash = "5151515151515151515151515151515151515151";
const fileName = "Throttled Stream S01E01 1080p WEB-DL.mp4";

// Delivery pacing knobs (env-tunable so the edge condition can be tightened
// without a rebuild). WINDOW bytes are released every WINDOW/pace ms, where the
// pace is RATE x the fixture's real bitrate. RATE < 1 keeps the buffer draining
// so the element under-runs briefly (native `waiting`) yet keeps advancing.
const WINDOW = Number(process.env.TF_WINDOW ?? 32 * 1024);
const RATE = Number(process.env.TF_RATE ?? 0.6);
const WARMUP_WINDOWS = Number(process.env.TF_WARMUP ?? 4);
const RUN_MS = Number(process.env.TF_RUN_MS ?? 14_000);
const DURATION = 24;

function ensureMedia() {
  fs.mkdirSync(mediaDir, { recursive: true });
  const out = path.join(mediaDir, fileName);
  if (fs.existsSync(out) && fs.statSync(out).size > 0) return;
  const ffmpegModule = require("ffmpeg-static") as string | { path?: string } | null;
  const ffmpeg = typeof ffmpegModule === "string" ? ffmpegModule : ffmpegModule?.path;
  if (!ffmpeg) throw new Error("ffmpeg-static did not resolve to a binary");
  // testsrc2 has heavy motion; a capped bitrate makes the real-time byte rate
  // predictable so the pacer can sit just under it.
  execFileSync(
    ffmpeg,
    [
      "-y",
      "-f", "lavfi", "-i", `testsrc2=size=1280x720:rate=30:duration=${DURATION}`,
      "-f", "lavfi", "-i", `sine=frequency=440:duration=${DURATION}`,
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
      "-b:v", "3M", "-maxrate", "3M", "-bufsize", "3M",
      "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart",
      out,
    ],
    { stdio: "ignore" },
  );
}

function startServer(): ChildProcess {
  const nextBin = path.join(repoRoot, "node_modules", "next", "dist", "bin", "next");
  const child = spawn(process.execPath, [nextBin, "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
  });
  child.stdout?.on("data", (chunk) => process.stdout.write(String(chunk)));
  child.stderr?.on("data", (chunk) => process.stderr.write(String(chunk)));
  return child;
}

async function waitForServer() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(base);
      if (res.status < 500) return;
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Production server did not become ready on ${base}`);
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function makeVideoPacer() {
  const filePath = path.join(mediaDir, fileName);
  const body = fs.readFileSync(filePath);
  const fileBitrateBps = body.length / DURATION; // bytes/sec of the container
  const paceBps = fileBitrateBps * RATE;
  const perWindowMs = (WINDOW / paceBps) * 1000;
  let served = 0;
  let nextAt = 0;

  async function fulfillVideo(route: Route) {
    const range = route.request().headers()["range"];
    if (!range) {
      // Non-range fetch: hand back the whole file (probe/metadata path).
      return route.fulfill({
        status: 200,
        contentType: "video/mp4",
        headers: { "Accept-Ranges": "bytes", "Content-Length": String(body.length) },
        body,
      });
    }
    const match = /bytes=(\d+)-(\d*)/.exec(range);
    const start = match ? Number(match[1]) : 0;
    const requestedEnd = match && match[2] ? Number(match[2]) : body.length - 1;
    // Cap the response to a small window so the browser keeps re-requesting and
    // the buffer never runs far ahead.
    const end = Math.min(requestedEnd, start + WINDOW - 1, body.length - 1);

    served += 1;
    if (served > WARMUP_WINDOWS) {
      const now = Date.now();
      if (nextAt < now) nextAt = now;
      const wait = nextAt - now;
      nextAt += perWindowMs;
      if (wait > 0) await sleep(wait);
    }

    return route.fulfill({
      status: 206,
      contentType: "video/mp4",
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${start}-${end}/${body.length}`,
        "Content-Length": String(end - start + 1),
      },
      body: body.subarray(start, end + 1),
    });
  }

  return { fulfillVideo, fileBitrateBps, paceBps, perWindowMs, size: body.length };
}

async function installRoutes(page: Page, pacer: ReturnType<typeof makeVideoPacer>) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    if (pathname === "/api/client/torrents") {
      return json(route, {
        clientType: "builtin",
        hasExternal: false,
        torrents: [{
          hash,
          name: "Throttled Stream S01E01",
          progress: 1,
          sizeBytes: pacer.size,
          dlspeed: 0,
          upspeed: 0,
          state: "seeding",
          eta: 0,
          peers: 6,
          category: "TV",
          savePath: "D:\\Media\\TV\\Throttled Stream\\Season 01",
        }],
      });
    }
    if (pathname === `/api/stream/${hash}`) {
      return json(route, {
        clientType: "builtin",
        files: [{ path: fileName, length: pacer.size, index: 0, downloadedRanges: [{ start: 0, end: pacer.size - 1 }] }],
        swarm: { peers: 6, downloadSpeedBps: 12_000_000, progress: 1, observedAt: Date.now() },
      });
    }
    if (pathname === `/api/stream/${hash}/${encodeURIComponent(fileName)}`) return pacer.fulfillVideo(route);
    if (pathname === "/api/playback/plan") {
      return json(route, {
        plan: {
          rung: "direct",
          reason: "throttled buffering probe",
          cost: 0,
          video: { codec: "h264", action: "copy" },
          audio: [{ streamIndex: 1, codec: "aac", action: "copy", channels: 2, language: "eng", title: "English" }],
          selectedAudioIndex: 1,
        },
        playUrl: `/api/stream/${hash}/${encodeURIComponent(fileName)}`,
        sessionId: null,
        startSec: 0,
        strategy: "whole-file",
        strategyReason: "probe",
        probe: { container: "mp4", duration: DURATION, videoCodec: "h264", audioCodec: "aac", audioChannels: 2, width: 1280, height: 720 },
      });
    }
    if (pathname.startsWith("/api/subtitles")) return json(route, { tracks: [], embeddedInspected: true });
    if (pathname === "/api/progress") return json(route, { ok: true });
    if (pathname === "/api/prewarm") return json(route, { ok: true, next: null });
    if (pathname.startsWith("/api/artwork")) return json(route, { posterUrl: null });
    return route.continue();
  });
}

// Installed before any page script runs. Tracks native `waiting` events and, on
// every animation frame, records whether the buffering overlay/spinner is
// visible while the video is demonstrably advancing (advanced within the last
// 1500ms — the component's motion-lease window).
const INSTRUMENT = `
(() => {
  const tf = { waiting: 0, stalled: 0, playing: 0, canplay: 0, samples: 0, overlayWhileAdvancing: 0,
    firstCT: null, lastCT: null, maxCT: 0, lastAdvanceTs: 0, ctAtViolation: null };
  window.__tf = tf;
  const LEASE_MS = 1500;
  // Media events do not bubble but do have a capture phase on document, so
  // capturing here catches them regardless of element remounts.
  document.addEventListener('waiting', () => { tf.waiting += 1; }, true);
  document.addEventListener('stalled', () => { tf.stalled += 1; }, true);
  document.addEventListener('playing', () => { tf.playing += 1; }, true);
  document.addEventListener('canplay', () => { tf.canplay += 1; }, true);
  function overlayVisible() {
    const spinners = Array.from(document.querySelectorAll('.animate-spin'));
    for (const el of spinners) {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05) {
        return true;
      }
    }
    const text = document.body ? document.body.innerText : '';
    if (/Buffering — waiting for enough of the file\\.|Too slow to stream/.test(text)) return true;
    return false;
  }
  function tick() {
    const video = document.querySelector('[data-stream-video]');
    if (video) {
      const ct = video.currentTime;
      if (tf.firstCT == null && ct > 0) tf.firstCT = ct;
      if (tf.lastCT != null && ct > tf.lastCT + 0.01) tf.lastAdvanceTs = performance.now();
      tf.lastCT = ct;
      if (ct > tf.maxCT) tf.maxCT = ct;
      const advancing = !video.paused && (performance.now() - tf.lastAdvanceTs) < LEASE_MS;
      if (advancing) {
        tf.samples += 1;
        if (overlayVisible()) {
          tf.overlayWhileAdvancing += 1;
          if (tf.ctAtViolation == null) tf.ctAtViolation = ct;
        }
      }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();
`;

async function main() {
  ensureMedia();
  const pacer = makeVideoPacer();
  console.log(
    `pacer: fileBitrate=${Math.round(pacer.fileBitrateBps)}B/s pace=${Math.round(pacer.paceBps)}B/s ` +
      `window=${WINDOW}B perWindow=${pacer.perWindowMs.toFixed(1)}ms warmup=${WARMUP_WINDOWS} rate=${RATE}`,
  );
  const server = startServer();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    await waitForServer();
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.addInitScript(INSTRUMENT);
    await installRoutes(page, pacer);
    await page.goto(`${base}/client`, { waitUntil: "networkidle" });
    await page.locator("[data-client-play]").first().click();
    await page.locator("[data-stream-video]").first().waitFor({ state: "visible", timeout: 20_000 });
    await page.locator("[data-stream-transport]").first().click();

    // Confirm playback actually begins under throttling.
    await page.waitForFunction(() => {
      const video = document.querySelector<HTMLVideoElement>("[data-stream-video]");
      return Boolean(video && video.currentSrc && video.readyState >= 2 && !video.paused && video.currentTime > 0.3);
    }, null, { timeout: 30_000 });

    await page.waitForTimeout(RUN_MS);

    const result = await page.evaluate(`(() => {
      const v = document.querySelector('[data-stream-video]');
      const tf = window.__tf;
      return {
        waiting: tf.waiting,
        stalled: tf.stalled,
        playing: tf.playing,
        canplay: tf.canplay,
        samples: tf.samples,
        overlayWhileAdvancing: tf.overlayWhileAdvancing,
        ctAtViolation: tf.ctAtViolation,
        firstCT: tf.firstCT,
        maxCT: tf.maxCT,
        currentCT: v ? v.currentTime : null,
        paused: v ? v.paused : null,
        readyState: v ? v.readyState : null,
      };
    })()`) as {
      waiting: number; stalled: number; playing: number; canplay: number; samples: number;
      overlayWhileAdvancing: number; ctAtViolation: number | null;
      firstCT: number | null; maxCT: number; currentCT: number | null; paused: boolean | null; readyState: number | null;
    };

    const from = result.firstCT ?? 0;
    const to = result.maxCT ?? 0;
    console.log(
      `EVIDENCE waiting=${result.waiting} stalled=${result.stalled} playing=${result.playing} ` +
        `canplay=${result.canplay} advancingSamples=${result.samples} ` +
        `overlayWhileAdvancing=${result.overlayWhileAdvancing} paused=${result.paused} readyState=${result.readyState} ` +
        `currentTime=${from.toFixed(2)}->${to.toFixed(2)}`,
    );

    if (result.waiting < 1) {
      throw new Error(`FAIL: source never buffered (native waiting fired ${result.waiting} times) — probe did not exercise the symptom`);
    }
    if (!(to > from + 0.5)) {
      throw new Error(`FAIL: video did not advance under buffering (currentTime ${from.toFixed(2)} -> ${to.toFixed(2)})`);
    }
    if (result.overlayWhileAdvancing > 0) {
      throw new Error(
        `FAIL: buffering overlay was visible over an advancing video ${result.overlayWhileAdvancing} time(s) ` +
          `(first at currentTime=${result.ctAtViolation})`,
      );
    }
    console.log(
      `PASS buffering overlay stayed hidden over an advancing video: ` +
        `waiting fired ${result.waiting} times, overlay visible = false, ` +
        `currentTime advanced from ${from.toFixed(2)} to ${to.toFixed(2)}`,
    );
  } finally {
    await browser?.close().catch(() => undefined);
    server.kill();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
