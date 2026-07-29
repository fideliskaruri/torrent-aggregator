/**
 * Drives the theatre player through the real states a viewer moves through —
 * opening, playing, controls-resting, a stalled seek, buffering, and ended —
 * and screenshots each one. The stream/plan/client APIs are stubbed and a real
 * MP4 is served with range support, so the player reaches genuine playback
 * without any torrent. Screenshots land in the session shots-states dir.
 *
 * Run: node node_modules/tsx/dist/cli.mjs scripts/probes/ui-state-capture.mts
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium, type Page, type Route } from "playwright";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const port = 3107;
const base = `http://127.0.0.1:${port}`;
const workDir = path.join(repoRoot, "scripts", "probes", "ui-state-artifacts");
const mediaDir = path.join(workDir, "media");
const outDir =
  process.env.TF_SHOTS_OUT ??
  path.join(workDir, "shots");
const hash = "6666666666666666666666666666666666666666";
const fileName = "Sample Movie 2019 1080p WEB-DL x264.mp4";
/** Fraction of the file that has "arrived". Seeking past this stalls for real. */
const WATERMARK = 0.22;

function ensureMedia() {
  fs.mkdirSync(mediaDir, { recursive: true });
  const out = path.join(mediaDir, fileName);
  if (fs.existsSync(out) && fs.statSync(out).size > 0) return;
  const ffmpegModule = require("ffmpeg-static") as string | { path?: string } | null;
  const ffmpeg = typeof ffmpegModule === "string" ? ffmpegModule : ffmpegModule?.path;
  if (!ffmpeg) throw new Error("ffmpeg-static did not resolve to a binary");
  execFileSync(
    ffmpeg,
    [
      "-y",
      "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=30",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=30",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
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
  child.stdout?.on("data", () => undefined);
  child.stderr?.on("data", () => undefined);
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

async function fulfillVideo(route: Route) {
  const body = fs.readFileSync(path.join(mediaDir, fileName));
  const range = route.request().headers()["range"];
  if (range) {
    const match = /bytes=(\d+)-(\d*)/.exec(range);
    const start = match ? Number(match[1]) : 0;
    const end = match && match[2] ? Number(match[2]) : body.length - 1;
    const safeEnd = Math.min(end, body.length - 1);
    return route.fulfill({
      status: 206,
      contentType: "video/mp4",
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${start}-${safeEnd}/${body.length}`,
        "Content-Length": String(safeEnd - start + 1),
      },
      body: body.subarray(start, safeEnd + 1),
    });
  }
  return route.fulfill({
    status: 200,
    contentType: "video/mp4",
    headers: { "Accept-Ranges": "bytes", "Content-Length": String(body.length) },
    body,
  });
}

async function installRoutes(page: Page) {
  const size = () => fs.statSync(path.join(mediaDir, fileName)).size;
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    if (pathname === "/api/client/torrents") {
      return json(route, {
        clientType: "builtin",
        hasExternal: false,
        torrents: [{
          hash,
          name: "Moving Video S01E01",
          progress: 1,
          sizeBytes: size(),
          dlspeed: 0,
          upspeed: 0,
          state: "seeding",
          eta: 0,
          peers: 6,
          category: "TV",
          savePath: "D:\\Media\\TV\\Moving Video\\Season 01",
        }],
      });
    }
    if (pathname === `/api/stream/${hash}`) {
      return json(route, {
        clientType: "builtin",
        files: [{
          path: fileName,
          length: size(),
          index: 0,
          downloadedRanges: [{ start: 0, end: size() - 1 }],
        }],
        swarm: { peers: 6, downloadSpeedBps: 8_000_000, progress: 1, observedAt: Date.now() },
      });
    }
    if (pathname === `/api/stream/${hash}/${encodeURIComponent(fileName)}`) return fulfillVideo(route);
    if (pathname === "/api/playback/plan") {
      return json(route, {
        plan: {
          rung: "direct",
          reason: "ui state capture",
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
        probe: { container: "mp4", duration: 30, videoCodec: "h264", audioCodec: "aac", audioChannels: 2, width: 1280, height: 720 },
      });
    }
    if (pathname.startsWith("/api/subtitles")) return json(route, { tracks: [], embeddedInspected: true });
    if (pathname === "/api/progress") return json(route, { ok: true });
    if (pathname === "/api/prewarm") return json(route, { ok: true, next: null });
    if (pathname.startsWith("/api/artwork")) return json(route, { posterUrl: null });
    return route.continue();
  });
}

async function shot(page: Page, name: string) {
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`SHOT ${name} -> ${file}`);
}

async function visibleSpinners(page: Page): Promise<number> {
  return page.locator(".animate-spin:visible").count();
}

async function play(page: Page) {
  await page.locator("[data-stream-video]").first().waitFor({ state: "visible", timeout: 20_000 });
  await page.locator("[data-stream-transport]").first().click();
  await page.waitForFunction(() => {
    const v = document.querySelector<HTMLVideoElement>("[data-stream-video]");
    return Boolean(v && v.currentSrc && v.readyState >= 2 && !v.paused && v.currentTime > 0.4);
  }, null, { timeout: 20_000 });
}

/** Force the "stalled" condition: stop progress so the advancing lease lapses. */
async function stall(page: Page) {
  await page.evaluate(() => {
    const v = document.querySelector<HTMLVideoElement>("[data-stream-video]");
    v?.pause();
  });
  await page.waitForTimeout(1_800); // advancing lease is ~1.5s
}

async function main() {
  ensureMedia();
  fs.rmSync(outDir, { recursive: true, force: true });
  const server = startServer();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  const report: string[] = [];
  try {
    await waitForServer();
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await installRoutes(page);

    // 1. Opening — click play on the client row, capture before the video settles.
    await page.goto(`${base}/client`, { waitUntil: "networkidle" });
    await page.locator("[data-client-play]").first().click();
    await page.waitForTimeout(120);
    await shot(page, "01-opening");

    // 2. Playing — video advancing, controls up.
    await play(page);
    await page.mouse.move(720, 450);
    await page.waitForTimeout(300);
    await shot(page, "02-playing-controls");
    report.push(`02-playing spinners=${await visibleSpinners(page)}`);

    // 3. Controls rested — let the theatre chrome auto-hide.
    await page.mouse.move(720, 880);
    await page.waitForTimeout(3_200);
    await shot(page, "03-controls-hidden");

    // 4. Stalled seek — the exact double-loader condition: seeking + waiting
    //    while the advancing lease has lapsed. Screenshot immediately.
    await stall(page);
    await page.evaluate(() => {
      const v = document.querySelector<HTMLVideoElement>("[data-stream-video]");
      if (!v) return;
      v.currentTime = Math.min((v.duration || 30) - 2, v.currentTime + 8);
      v.dispatchEvent(new Event("seeking", { bubbles: true }));
      v.dispatchEvent(new Event("waiting", { bubbles: true }));
    });
    await page.waitForTimeout(80);
    await shot(page, "04-seeking-stalled");
    const seekSpinners = await visibleSpinners(page);
    report.push(`04-seeking spinners=${seekSpinners} (expect 1, not 2)`);

    // 5. Buffering while paused (not seeking) — one overlay is correct here.
    await page.evaluate(() => {
      const v = document.querySelector<HTMLVideoElement>("[data-stream-video]");
      v?.dispatchEvent(new Event("seeked", { bubbles: true }));
      v?.dispatchEvent(new Event("waiting", { bubbles: true }));
    });
    await page.waitForTimeout(150);
    await shot(page, "05-buffering");
    report.push(`05-buffering spinners=${await visibleSpinners(page)}`);

    // 6. Ended — up-next / replay surface.
    await page.evaluate(() => {
      const v = document.querySelector<HTMLVideoElement>("[data-stream-video]");
      if (!v) return;
      v.currentTime = (v.duration || 30) - 0.2;
      void v.play().catch(() => undefined);
    });
    await page.waitForTimeout(1_500);
    await shot(page, "06-ended");

    console.log("REPORT:\n" + report.map((r) => "  " + r).join("\n"));
  } finally {
    await browser?.close().catch(() => undefined);
    server.kill();
    fs.rmSync(path.join(workDir, "media"), { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
