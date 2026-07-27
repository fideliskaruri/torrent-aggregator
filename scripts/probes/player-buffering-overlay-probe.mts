import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium, type Page, type Route } from "playwright";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const port = 3106;
const base = `http://127.0.0.1:${port}`;
const workDir = path.join(repoRoot, "scripts", "probes", "player-buffering-artifacts");
const mediaDir = path.join(workDir, "media");
const hash = "6666666666666666666666666666666666666666";
const fileName = "Moving Video S01E01 1080p WEB-DL.mp4";

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
      "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=8",
      "-f", "lavfi", "-i", "sine=frequency=660:duration=8",
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
          sizeBytes: 1,
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
          length: fs.statSync(path.join(mediaDir, fileName)).size,
          index: 0,
          downloadedRanges: [{ start: 0, end: fs.statSync(path.join(mediaDir, fileName)).size - 1 }],
        }],
        swarm: { peers: 6, downloadSpeedBps: 8_000_000, progress: 1, observedAt: Date.now() },
      });
    }
    if (pathname === `/api/stream/${hash}/${encodeURIComponent(fileName)}`) return fulfillVideo(route);
    if (pathname === "/api/playback/plan") {
      return json(route, {
        plan: {
          rung: "direct",
          reason: "buffering overlay probe",
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
        probe: { container: "mp4", duration: 8, videoCodec: "h264", audioCodec: "aac", audioChannels: 2, width: 1280, height: 720 },
      });
    }
    if (pathname.startsWith("/api/subtitles")) return json(route, { tracks: [], embeddedInspected: true });
    if (pathname === "/api/progress") return json(route, { ok: true });
    if (pathname === "/api/prewarm") return json(route, { ok: true, next: null });
    if (pathname.startsWith("/api/artwork")) return json(route, { posterUrl: null });
    return route.continue();
  });
}

async function assertMovingWithoutOverlay(page: Page) {
  await page.locator("[data-stream-video]").first().waitFor({ state: "visible", timeout: 20_000 });
  await page.locator("[data-stream-transport]").first().click();
  await page.waitForFunction(() => {
    const video = document.querySelector<HTMLVideoElement>("[data-stream-video]");
    return Boolean(video && video.currentSrc && video.readyState >= 2 && !video.paused && video.currentTime > 0.5);
  }, null, { timeout: 20_000 });
  await page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>("[data-stream-video]");
    video?.dispatchEvent(new Event("waiting", { bubbles: true }));
  });
  await page.waitForTimeout(150);
  const overlayText = await page.locator("text=/Buffering|Too slow to stream|waiting for enough/i").count();
  if (overlayText > 0) throw new Error(`Buffering overlay/status visible over moving video (${overlayText} matches)`);
  const spinnerCount = await page.locator(".animate-spin:visible").count();
  if (spinnerCount > 0) throw new Error(`Visible spinner over moving video (${spinnerCount} matches)`);
  console.log(`PASS moving video stayed clear after waiting; visible spinners=${spinnerCount}`);
}

async function main() {
  ensureMedia();
  const server = startServer();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    await waitForServer();
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await installRoutes(page);
    await page.goto(`${base}/client`, { waitUntil: "networkidle" });
    await page.locator("[data-client-play]").first().click();
    await assertMovingWithoutOverlay(page);
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
