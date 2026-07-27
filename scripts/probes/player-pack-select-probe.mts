import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium, type Page, type Route } from "playwright";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const portArg = process.argv.find((arg) => arg.startsWith("--port="));
const port = portArg ? Number(portArg.slice("--port=".length)) : 3458;
const manualSelect = process.argv.includes("--manual-select");
const base = `http://127.0.0.1:${port}`;
const outDir = path.join(repoRoot, "scripts", "probes", "player-pack-artifacts");
const mediaDir = path.join(outDir, "media");

const packHash = "3333333333333333333333333333333333333333";
const files = [1, 3, 4].map((episode) => ({
  episode,
  name: `Probe Pack S01E${String(episode).padStart(2, "0")} 1080p WEB-DL.mp4`,
  color: episode === 3 ? "0x059669" : episode === 4 ? "0x7c3aed" : "0x1d4ed8",
}));
const target = files.find((file) => file.episode === 3)!;

type PlaybackState = { currentSrc: string; readyState: number; videoWidth: number; videoHeight: number };

function ensureMedia() {
  fs.mkdirSync(mediaDir, { recursive: true });
  const ffmpegModule = require("ffmpeg-static") as string | { path?: string } | null;
  const ffmpeg = typeof ffmpegModule === "string" ? ffmpegModule : ffmpegModule?.path;
  if (!ffmpeg) throw new Error("ffmpeg-static did not resolve to a binary");
  for (const file of files) {
    const out = path.join(mediaDir, file.name);
    if (fs.existsSync(out) && fs.statSync(out).size > 0) continue;
    execFileSync(
      ffmpeg,
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        `color=c=${file.color}:s=1280x720:d=5:r=30`,
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=520:duration=5",
        "-vf",
        `drawtext=text='${file.name.replace(/'/g, "\\'")}':fontcolor=white:fontsize=42:x=(w-text_w)/2:y=(h-text_h)/2`,
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
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Next dev server did not become ready on ${base}`);
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function fulfillVideo(route: Route, fileName: string) {
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

async function installRoutes(page: Page, requests: string[]) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    if (pathname === "/api/settings/client") {
      return json(route, { settings: { clientType: "builtin", automationIntervalMinutes: 0 } });
    }
    if (pathname === "/api/client/torrents") {
      return json(route, {
        clientType: "builtin",
        hasExternal: false,
        torrents: [
          {
            hash: packHash,
            name: "Probe Pack S01E03 requested from COMPLETE 1080p WEB-DL PACK",
            progress: 0.72,
            sizeBytes: files.reduce((sum, file) => sum + fs.statSync(path.join(mediaDir, file.name)).size, 0),
            dlspeed: 7_000_000,
            upspeed: 0,
            state: "downloading",
            eta: 10,
            peers: 8,
            category: "TV",
            savePath: "D:\\Media\\TV\\Probe Pack\\Season 01",
          },
        ],
      });
    }
    if (pathname.startsWith("/api/stream/")) {
      requests.push(pathname);
      const [, , , hash, ...encoded] = pathname.split("/");
      if (hash !== packHash) return json(route, { error: "unknown hash" }, 404);
      if (encoded.length === 0) {
        return json(route, {
          clientType: "builtin",
          files: files.map((file, index) => ({
            path: file.name,
            length: fs.statSync(path.join(mediaDir, file.name)).size,
            index,
            downloadedRanges: [{ start: 0, end: fs.statSync(path.join(mediaDir, file.name)).size - 1 }],
          })),
          swarm: { peers: 8, downloadSpeedBps: 7_000_000, progress: 0.72, observedAt: Date.now() },
        });
      }
      return fulfillVideo(route, decodeURIComponent(encoded.join("/")));
    }
    if (pathname === "/api/playback/plan") {
      const req = JSON.parse(route.request().postData() || "{}") as { infoHash?: string; filePath?: string };
      if (!req.filePath) return json(route, { error: "missing filePath" }, 400);
      return json(route, {
        plan: {
          rung: "direct",
          reason: "pack probe",
          cost: 0,
          video: { codec: "h264", action: "copy" },
          audio: [{ streamIndex: 1, codec: "aac", action: "copy", channels: 2, language: "eng", title: "English" }],
          selectedAudioIndex: 1,
        },
        playUrl: `/api/stream/${req.infoHash}/${encodeURIComponent(req.filePath)}`,
        sessionId: null,
        startSec: 0,
        strategy: "whole-file",
        strategyReason: "pack probe",
        probe: {
          container: "mp4",
          duration: 5,
          videoCodec: "h264",
          videoProfile: "main",
          audioCodec: "aac",
          audioChannels: 2,
          width: 1280,
          height: 720,
        },
      });
    }
    if (pathname === "/api/prewarm") return json(route, { ok: true, next: null });
    if (pathname.startsWith("/api/subtitles")) return json(route, { tracks: [], embeddedInspected: true });
    if (pathname === "/api/progress") return json(route, { ok: true });
    if (pathname.startsWith("/api/artwork")) return json(route, { posterUrl: null });
    return route.continue();
  });
}

async function main() {
  ensureMedia();
  const requests: string[] = [];
  const server = startServer();
  try {
    await waitForServer();
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await installRoutes(page, requests);
    await page.goto(`${base}/client`, { waitUntil: "networkidle" });
    await page.locator("[data-client-play]").first().click();
    const select = page.locator("[data-stream-file-select]").first();
    await select.waitFor({ state: "visible", timeout: 20_000 });
    if (manualSelect) await select.selectOption(target.name);
    const selected = await select.inputValue();
    if (!selected.includes("S01E03")) {
      throw new Error(`Player did not auto-select the requested S01E03 episode: ${selected}`);
    }
    const handle = await page.waitForFunction(() => {
      const video = document.querySelector<HTMLVideoElement>("[data-stream-video]");
      return video && video.currentSrc && video.readyState >= 2 && video.videoWidth > 0
        ? {
            currentSrc: video.currentSrc,
            readyState: video.readyState,
            videoWidth: video.videoWidth,
            videoHeight: video.videoHeight,
          }
        : null;
    }, null, { timeout: 30_000 });
    const playback = await handle.jsonValue() as PlaybackState | null;
    if (!playback) throw new Error("Selected pack episode did not reach a decoded frame");
    const expectedPath = `/api/stream/${packHash}/${encodeURIComponent(target.name)}`;
    const requested = requests.some((request) => request === expectedPath);
    if (!requested) throw new Error(`No file stream request for ${expectedPath}; saw ${JSON.stringify(requests)}`);
    console.log(`PASS pack selected=${selected} mode=${manualSelect ? "manual" : "auto"}`);
    console.log(`PASS stream request=${expectedPath}`);
    console.log(`PASS playback readyState=${playback.readyState} currentSrc=${playback.currentSrc}`);
    await browser.close();
  } finally {
    server.kill();
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
