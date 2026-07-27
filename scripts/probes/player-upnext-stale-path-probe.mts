import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium, type Page, type Route } from "playwright";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const portArg = process.argv.find((arg) => arg.startsWith("--port="));
const port = portArg ? Number(portArg.slice("--port=".length)) : 3459;
const base = `http://127.0.0.1:${port}`;
const workDir = path.join(repoRoot, "scripts", "probes", "player-upnext-artifacts");
const mediaDir = path.join(workDir, "media");

const currentHash = "4444444444444444444444444444444444444444";
const nextHash = "5555555555555555555555555555555555555555";
const currentFile = "Probe Upnext S01E03 1080p WEB-DL.mp4";
const otherCurrentFile = "Probe Upnext S01E01 1080p WEB-DL.mp4";
const nextFile = "Probe Upnext S01E04 1080p WEB-DL-PREWARM.mp4";
const filesByHash = new Map([
  [currentHash, [otherCurrentFile, currentFile]],
  [nextHash, [nextFile]],
]);
const stream404s: string[] = [];
const fileRequests: string[] = [];
const invalidPlanRequests: string[] = [];
const requestTimes: Array<{ name: string; at: number }> = [];
let timingOrigin = 0;

function ensureMedia() {
  fs.mkdirSync(mediaDir, { recursive: true });
  const ffmpegModule = require("ffmpeg-static") as string | { path?: string } | null;
  const ffmpeg = typeof ffmpegModule === "string" ? ffmpegModule : ffmpegModule?.path;
  if (!ffmpeg) throw new Error("ffmpeg-static did not resolve to a binary");
  for (const file of [otherCurrentFile, currentFile, nextFile]) {
    const out = path.join(mediaDir, file);
    if (fs.existsSync(out) && fs.statSync(out).size > 0) continue;
    const color = file.includes("E04") ? "0x7c3aed" : file.includes("E03") ? "0x059669" : "0x1d4ed8";
    execFileSync(
      ffmpeg,
      [
        "-y",
        "-f", "lavfi", "-i", `color=c=${color}:s=1280x720:d=5:r=30`,
        "-f", "lavfi", "-i", "sine=frequency=500:duration=5",
        "-vf", `drawtext=text='${file.replace(/'/g, "\\'")}':fontcolor=white:fontsize=42:x=(w-text_w)/2:y=(h-text_h)/2`,
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-movflags", "+faststart",
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

async function installRoutes(page: Page) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    if (pathname === "/api/client/torrents") {
      requestTimes.push({ name: "client-list", at: Date.now() - timingOrigin });
      return json(route, {
        clientType: "builtin",
        hasExternal: false,
        torrents: [{
          hash: currentHash,
          name: "Probe Upnext S01E03 from pack",
          progress: 1,
          sizeBytes: 1,
          dlspeed: 0,
          upspeed: 0,
          state: "seeding",
          eta: 0,
          peers: 8,
          category: "TV",
          savePath: "D:\\Media\\TV\\Probe Upnext\\Season 01",
        }],
      });
    }
    if (pathname.startsWith("/api/stream/")) {
      requestTimes.push({ name: pathname.split("/").length > 4 ? "stream-file" : "manifest", at: Date.now() - timingOrigin });
      const [, , , hash, ...encoded] = pathname.split("/");
      const listed = filesByHash.get(hash) ?? [];
      if (encoded.length === 0) {
        return json(route, {
          clientType: "builtin",
          files: listed.map((file, index) => ({
            path: file,
            length: fs.statSync(path.join(mediaDir, file)).size,
            index,
            downloadedRanges: [{ start: 0, end: fs.statSync(path.join(mediaDir, file)).size - 1 }],
          })),
          swarm: { peers: 8, downloadSpeedBps: 8_000_000, progress: 1, observedAt: Date.now() },
        });
      }
      const file = decodeURIComponent(encoded.join("/"));
      const requestPath = pathname;
      fileRequests.push(requestPath);
      if (!listed.includes(file)) {
        stream404s.push(requestPath);
        return json(route, { error: "file not in active torrent manifest", file }, 404);
      }
      return fulfillVideo(route, file);
    }
    if (pathname === "/api/playback/plan") {
      requestTimes.push({ name: "playback-plan", at: Date.now() - timingOrigin });
      const req = JSON.parse(route.request().postData() || "{}") as { infoHash?: string; filePath?: string };
      const listed = filesByHash.get(req.infoHash ?? "") ?? [];
      if (req.filePath && !listed.includes(req.filePath)) {
        invalidPlanRequests.push(`${req.infoHash}/${req.filePath}`);
      }
      return json(route, {
        plan: {
          rung: "direct",
          reason: "up-next stale path probe",
          cost: 0,
          video: { codec: "h264", action: "copy" },
          audio: [{ streamIndex: 1, codec: "aac", action: "copy", channels: 2, language: "eng", title: "English" }],
          selectedAudioIndex: 1,
        },
        playUrl: `/api/stream/${req.infoHash}/${encodeURIComponent(req.filePath ?? "")}`,
        sessionId: null,
        startSec: 0,
        strategy: "whole-file",
        strategyReason: "probe",
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
    if (pathname === "/api/prewarm") {
      return json(route, {
        ok: true,
        next: {
          title: "Probe Upnext S01E04 1080p WEB-DL-PREWARM",
          label: "S01E04",
          season: 1,
          episode: 4,
          availability: "ready",
          infoHash: nextHash,
          progress: 1,
        },
      });
    }
    if (pathname.startsWith("/api/subtitles")) return json(route, { tracks: [], embeddedInspected: true });
    if (pathname === "/api/progress") return json(route, { ok: true });
    if (pathname.startsWith("/api/artwork")) return json(route, { posterUrl: null });
    return route.continue();
  });
}

async function decodedVideo(page: Page) {
  const handle = await page.waitForFunction(() => {
    const video = document.querySelector<HTMLVideoElement>("[data-stream-video]");
    return video && video.currentSrc && video.readyState >= 2 && video.videoWidth > 0
      ? { currentSrc: video.currentSrc, readyState: video.readyState }
      : null;
  }, null, { timeout: 30_000 });
  return handle.jsonValue() as Promise<{ currentSrc: string; readyState: number } | null>;
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
    timingOrigin = Date.now();
    await page.locator("[data-client-play]").first().click();
    const first = await decodedVideo(page);
    if (!first?.currentSrc.includes("S01E03")) throw new Error(`Initial playback did not decode S01E03: ${first?.currentSrc}`);
    const initialDecodedAt = Date.now() - timingOrigin;
    await page.evaluate(() => {
      document.querySelector<HTMLVideoElement>("[data-stream-video]")?.dispatchEvent(new Event("ended", { bubbles: true }));
    });
    await page.locator("[data-up-next-card]").first().waitFor({ state: "visible", timeout: 10_000 });
    await page.locator("[data-up-next-card] button", { hasText: "Play now" }).first().click();
    const next = await decodedVideo(page);
    if (!next?.currentSrc.includes("S01E04")) throw new Error(`Up-next decoded the wrong episode: ${next?.currentSrc}`);
    if (stream404s.length > 0) throw new Error(`Stale file-level stream requests returned 404: ${JSON.stringify(stream404s)}`);
    const stale = fileRequests.filter((request) => request.includes(nextHash) && request.includes("S01E03"));
    if (stale.length > 0) throw new Error(`Requested old S01E03 path from next torrent: ${JSON.stringify(stale)}`);
    if (invalidPlanRequests.length > 0) throw new Error(`Planned playback for files absent from their active manifest: ${JSON.stringify(invalidPlanRequests)}`);
    const interestingRequests = requestTimes.filter((item) => item.at >= 0 && item.at <= initialDecodedAt + 500);
    console.log(`INFO initial click-to-decoded ${initialDecodedAt}ms; requests=${interestingRequests.map((item) => `${item.name}@${item.at}ms`).join(", ")}`);
    console.log(`PASS up-next decoded ${next.currentSrc}`);
    console.log(`PASS no stream 404s across transition (${fileRequests.length} file requests)`);
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
