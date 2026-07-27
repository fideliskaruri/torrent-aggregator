import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium, type Page, type Route } from "playwright";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const phase = process.argv.includes("--phase=before") ? "before" : "after";
const portArg = process.argv.find((arg) => arg.startsWith("--port="));
const port = portArg ? Number(portArg.slice("--port=".length)) : 3457;
const base = `http://127.0.0.1:${port}`;
const shotRoot = path.join(repoRoot, "scripts", "probes", "player-screenshots");
const phaseDir = path.join(shotRoot, phase);
const mediaDir = path.join(shotRoot, "media");

const hash1 = "1111111111111111111111111111111111111111";
const hash2 = "2222222222222222222222222222222222222222";
const file1 = "Demo Show S01E01 1080p WEB-DL H.264.mp4";
const file2 = "Demo Show S01E02 1080p WEB-DL H.264.mp4";
const mediaByHash = new Map([
  [hash1, { file: file1, color: "0x1d4ed8", title: "Demo Show S01E01 1080p WEB-DL H.264" }],
  [hash2, { file: file2, color: "0x7c3aed", title: "Demo Show S01E02 1080p WEB-DL H.264" }],
]);

function ensureMedia() {
  fs.mkdirSync(mediaDir, { recursive: true });
  const ffmpegModule = require("ffmpeg-static") as string | { path?: string } | null;
  const ffmpeg = typeof ffmpegModule === "string" ? ffmpegModule : ffmpegModule?.path;
  if (!ffmpeg) throw new Error("ffmpeg-static did not resolve to a binary");
  for (const item of mediaByHash.values()) {
    const out = path.join(mediaDir, item.file);
    if (fs.existsSync(out) && fs.statSync(out).size > 0) continue;
    execFileSync(
      ffmpeg,
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        `color=c=${item.color}:s=1280x720:d=6:r=30`,
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=6",
        "-vf",
        `drawtext=text='${item.title.replace(/'/g, "\\'")}':fontcolor=white:fontsize=48:x=(w-text_w)/2:y=(h-text_h)/2`,
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        out,
      ],
      { stdio: "ignore" },
    );
  }
}

function startServer(): ChildProcess {
  const nextBin = path.join(repoRoot, "node_modules", "next", "dist", "bin", "next");
  const child = spawn(process.execPath, [nextBin, "dev", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
  });
  child.stdout?.on("data", (chunk) => process.stdout.write(String(chunk)));
  child.stderr?.on("data", (chunk) => process.stderr.write(String(chunk)));
  return child;
}

async function waitForServer() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(base);
      if (res.status < 500) return;
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  throw new Error(`Next dev server did not become ready on ${base}`);
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function fulfillVideo(route: Route, hash: string) {
  const meta = mediaByHash.get(hash) ?? mediaByHash.get(hash1)!;
  const filePath = path.join(mediaDir, meta.file);
  const body = fs.readFileSync(filePath);
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
        torrents: [
          {
            hash: hash1,
            name: "Demo Show S01E01 1080p WEB-DL H.264",
            progress: 1,
            sizeBytes: fs.statSync(path.join(mediaDir, file1)).size,
            dlspeed: 0,
            upspeed: 0,
            state: "seeding",
            eta: 0,
            peers: 12,
            category: "TV",
            savePath: "D:\\Media\\TV\\Demo Show\\Season 01",
          },
        ],
      });
    }

    if (pathname.startsWith("/api/artwork/release")) {
      return json(route, { posterUrl: null });
    }

    if (pathname.startsWith("/api/stream/")) {
      const [, , , hash, ...rest] = pathname.split("/");
      if (rest.length === 0) {
        const meta = mediaByHash.get(hash) ?? mediaByHash.get(hash1)!;
        return json(route, {
          clientType: "builtin",
          files: [
            {
              path: meta.file,
              length: fs.statSync(path.join(mediaDir, meta.file)).size,
              index: 0,
              downloadedRanges: [{ start: 0, end: fs.statSync(path.join(mediaDir, meta.file)).size - 1 }],
            },
          ],
          swarm: { peers: 12, downloadSpeedBps: 8_000_000, progress: 1, observedAt: Date.now() },
        });
      }
      return fulfillVideo(route, hash);
    }

    if (pathname === "/api/playback/plan") {
      const req = JSON.parse(route.request().postData() || "{}") as { infoHash?: string; filePath?: string };
      const meta = mediaByHash.get(req.infoHash ?? "") ?? mediaByHash.get(hash1)!;
      await new Promise((resolve) => setTimeout(resolve, 900));
      return json(route, {
        plan: {
          rung: "direct",
          reason: "probe fixture",
          cost: 0,
          video: { codec: "h264", action: "copy" },
          audio: [{ streamIndex: 1, codec: "aac", action: "copy", channels: 2, language: "eng", title: "English" }],
          selectedAudioIndex: 1,
        },
        playUrl: `/api/stream/${req.infoHash}/${encodeURIComponent(req.filePath ?? meta.file)}`,
        sessionId: null,
        startSec: 0,
        strategy: "whole-file",
        strategyReason: "probe fixture",
        probe: {
          container: "mp4",
          duration: 6,
          videoCodec: "h264",
          videoProfile: "main",
          audioCodec: "aac",
          audioChannels: 2,
          width: 1280,
          height: 720,
        },
      });
    }

    if (pathname === "/api/prewarm") {
      return json(route, {
        ok: true,
        next: {
          title: "Demo Show S01E02 1080p WEB-DL H.264",
          label: "S01E02",
          season: 1,
          episode: 2,
          availability: "ready",
          infoHash: hash2,
          progress: 1,
        },
      });
    }

    if (pathname.startsWith("/api/subtitles")) return json(route, { tracks: [], embeddedInspected: true });
    if (pathname === "/api/progress") return json(route, { ok: true });
    return route.continue();
  });
}

async function openPlayer(page: Page, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  await page.goto(`${base}/client`, { waitUntil: "networkidle" });
  await page.locator("[data-client-play]").first().click();
  await page.locator("[data-stream-stage]").first().waitFor({ state: "visible", timeout: 20_000 });
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(phaseDir, name), fullPage: false });
}

async function main() {
  ensureMedia();
  fs.mkdirSync(phaseDir, { recursive: true });
  const server = startServer();
  try {
    await waitForServer();
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await installRoutes(page);

    for (const viewport of [
      { width: 1440, height: 900, label: "1440x900" },
      { width: 1280, height: 720, label: "1280x720" },
    ]) {
      await openPlayer(page, viewport);
      await page.locator("[data-stream-stage]").first().waitFor({ state: "visible" });
      await shot(page, `player-${viewport.label}-preload.png`);

      await page.locator("[data-stream-video]").first().waitFor({ state: "visible", timeout: 20_000 });
      await page.locator("[data-stream-transport]").first().click();
      await page.waitForFunction(() => {
        const video = document.querySelector<HTMLVideoElement>("[data-stream-video]");
        return Boolean(video && video.readyState >= 2 && !video.paused);
      }, null, { timeout: 20_000 });
      await shot(page, `player-${viewport.label}-playing.png`);

      await page.evaluate(() => {
        const video = document.querySelector<HTMLVideoElement>("[data-stream-video]");
        video?.dispatchEvent(new Event("ended", { bubbles: true }));
      });
      await page.locator("[data-up-next-card]").first().waitFor({ state: "visible", timeout: 20_000 });
      await shot(page, `player-${viewport.label}-up-next.png`);

      const stageBox = await page.locator("[data-stream-stage]").first().boundingBox();
      const controls = await page.locator("[data-stream-transport]").first().boundingBox();
      const hasControls = Boolean(controls && controls.width >= 32 && controls.height >= 32);
      const cardText = (await page.locator("[data-up-next-card]").first().innerText()).replace(/\s+/g, " ");
      const videoCount = await page.locator("[data-stream-video]").count();
      console.log(
        `${phase} ${viewport.label}: stage=${Math.round(stageBox?.width ?? 0)}x${Math.round(stageBox?.height ?? 0)} controls=${hasControls} videos=${videoCount} upNext="${cardText}"`,
      );

      await page.locator("[data-up-next-card] button", { hasText: "Play now" }).first().click();
      await page.locator(`[data-inline-player][data-infohash="${hash2}"]`).first().waitFor({ state: "visible", timeout: 10_000 });
      const preparingShown = await page
        .locator("[data-stream-preparing]")
        .first()
        .waitFor({ state: "visible", timeout: 1_500 })
        .then(() => true)
        .catch(() => false);
      const preparingText = (await page.locator("[data-stream-stage]").first().innerText()).replace(/\s+/g, " ");
      if (!preparingShown) throw new Error("Up-next transition did not show the preparing state");
      const realPlayback = await page.waitForFunction(() => {
        const video = document.querySelector<HTMLVideoElement>("[data-stream-video]");
        return video && video.currentSrc && video.readyState >= 2
          ? { currentSrc: video.currentSrc, readyState: video.readyState }
          : null;
      }, null, { timeout: 20_000 });
      const nextVideoHash = await page.locator("[data-inline-player]").first().getAttribute("data-infohash");
      const playbackState = await realPlayback.jsonValue();
      if (!playbackState) throw new Error("Up-next real video did not reach a decoded frame");
      console.log(
        `${phase} ${viewport.label}: up-next transition preparing=${preparingShown} nextHash=${nextVideoHash} readyState=${playbackState.readyState} currentSrc=${playbackState.currentSrc} preparing="${preparingText}"`,
      );

      await page.keyboard.press("Escape").catch(() => undefined);
      await page.locator("[aria-label='Close']").first().click().catch(() => undefined);
    }

    await browser.close();
  } finally {
    server.kill();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
