/**
 * Fullscreen vs inline control parity.
 *
 * The user's complaint, verbatim: "this is the full screen player, it's totally
 * different". Before the unification, entering fullscreen silently dropped five
 * controls (skip back, skip forward, speed, subtitles, audio settings) and the
 * timeline lost its buffered band.
 *
 * This probe enumerates every interactive control in both modes and diffs them.
 * It also measures how much of the fullscreen surface the video actually fills,
 * because the same screenshot showed black bars on all four sides.
 *
 * Reuses the fixture approach of player-visual-proof.mts: a real H.264 file
 * served through mocked API routes, so playback genuinely decodes.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium, type Page, type Route } from "playwright";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const portArg = process.argv.find((a) => a.startsWith("--port="));
const port = portArg ? Number(portArg.slice("--port=".length)) : 3121;
const base = `http://127.0.0.1:${port}`;
const outDir = path.join(repoRoot, "scripts", "probes", "player-screenshots", "fullscreen-parity");
const mediaDir = path.join(repoRoot, "scripts", "probes", "player-screenshots", "media");

const hash1 = "1111111111111111111111111111111111111111";
const file1 = "Demo Show S01E01 1080p WEB-DL H.264.mp4";

function ensureMedia() {
  fs.mkdirSync(mediaDir, { recursive: true });
  const out = path.join(mediaDir, file1);
  if (fs.existsSync(out) && fs.statSync(out).size > 0) return;
  const mod = require("ffmpeg-static") as string | { path?: string } | null;
  const ffmpeg = typeof mod === "string" ? mod : mod?.path;
  if (!ffmpeg) throw new Error("ffmpeg-static did not resolve to a binary");
  execFileSync(
    ffmpeg,
    ["-y", "-f", "lavfi", "-i", "color=c=0x1d4ed8:s=1280x720:d=6:r=30", "-f", "lavfi",
      "-i", "sine=frequency=440:duration=6", "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-movflags", "+faststart", out],
    { stdio: "ignore" },
  );
}

function startServer(): ChildProcess {
  const nextBin = path.join(repoRoot, "node_modules", "next", "dist", "bin", "next");
  return spawn(process.execPath, [nextBin, "dev", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: repoRoot,
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
  });
}

async function waitForServer() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(base);
      if (res.status < 500) return;
    } catch { /* keep polling */ }
    await new Promise((r) => setTimeout(r, 600));
  }
  throw new Error(`server not ready on ${base}`);
}

function json(route: Route, body: unknown) {
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

async function fulfillVideo(route: Route) {
  const body = fs.readFileSync(path.join(mediaDir, file1));
  const range = route.request().headers()["range"];
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const start = m ? Number(m[1]) : 0;
    const end = Math.min(m && m[2] ? Number(m[2]) : body.length - 1, body.length - 1);
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
  return route.fulfill({
    status: 200,
    contentType: "video/mp4",
    headers: { "Accept-Ranges": "bytes", "Content-Length": String(body.length) },
    body,
  });
}

async function installRoutes(page: Page) {
  const size = () => fs.statSync(path.join(mediaDir, file1)).size;
  await page.route("**/*", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === "/api/client/torrents") {
      return json(route, {
        clientType: "builtin",
        hasExternal: false,
        torrents: [{
          hash: hash1, name: "Demo Show S01E01 1080p WEB-DL H.264", progress: 1,
          sizeBytes: size(), dlspeed: 0, upspeed: 0, state: "seeding", eta: 0,
          peers: 12, category: "TV", savePath: "D:\\Media\\TV\\Demo Show\\Season 01",
        }],
      });
    }
    if (p.startsWith("/api/artwork")) return json(route, { posterUrl: null });
    if (p.startsWith("/api/stream/")) {
      const rest = p.split("/").slice(4);
      if (rest.length === 0) {
        return json(route, {
          clientType: "builtin",
          files: [{ path: file1, length: size(), index: 0, downloadedRanges: [{ start: 0, end: size() - 1 }] }],
          swarm: { peers: 12, downloadSpeedBps: 8_000_000, progress: 1, observedAt: Date.now() },
        });
      }
      return fulfillVideo(route);
    }
    if (p === "/api/playback/plan") {
      return json(route, {
        plan: {
          rung: "direct", reason: "probe fixture", cost: 0,
          video: { codec: "h264", action: "copy" },
          audio: [{ streamIndex: 1, codec: "aac", action: "copy", channels: 2, language: "eng", title: "English" }],
          selectedAudioIndex: 1,
        },
        playUrl: `/api/stream/${hash1}/${encodeURIComponent(file1)}`,
        sessionId: null, startSec: 0, strategy: "whole-file", strategyReason: "probe fixture",
        probe: { container: "mp4", duration: 6, videoCodec: "h264", videoProfile: "main", audioCodec: "aac", audioChannels: 2, width: 1280, height: 720 },
      });
    }
    if (p === "/api/prewarm") return json(route, { ok: true, next: null });
    if (p.startsWith("/api/subtitles")) return json(route, { tracks: [], embeddedInspected: true });
    if (p === "/api/progress") return json(route, { ok: true });
    return route.continue();
  });
}

const READ_CONTROLS = `(() => {
  function label(el) {
    return (el.getAttribute("aria-label")
      || el.getAttribute("data-action")
      || (el.textContent || "").trim()
      || el.getAttribute("type")
      || el.tagName).trim().slice(0, 40);
  }
  var root = document.querySelector("[data-stream-transport-row]") || document.body;
  var nodes = Array.from(root.querySelectorAll("button, input, select"));
  var video = document.querySelector("[data-stream-video]");
  var surface = document.querySelector("[data-player-fullscreen-surface]");
  var vb = video ? video.getBoundingClientRect() : null;
  var sb = surface ? surface.getBoundingClientRect() : null;
  return {
    controls: nodes.map(label),
    fullscreen: Boolean(document.fullscreenElement),
    fullscreenIsSurface: Boolean(document.fullscreenElement && surface && document.fullscreenElement === surface),
    videoBox: vb ? { w: Math.round(vb.width), h: Math.round(vb.height) } : null,
    surfaceBox: sb ? { w: Math.round(sb.width), h: Math.round(sb.height) } : null,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    videoTitleAttr: video ? video.getAttribute("title") : null,
    nativeControls: video ? video.hasAttribute("controls") : null,
    bufferedBands: document.querySelectorAll("[data-stream-buffered]").length,
  };
})()`;

async function main() {
  ensureMedia();
  fs.mkdirSync(outDir, { recursive: true });
  const server = startServer();
  try {
    await waitForServer();
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await installRoutes(page);

    await page.goto(`${base}/client`, { waitUntil: "networkidle" });
    await page.locator("[data-client-play]").first().click();
    await page.locator("[data-stream-video]").first().waitFor({ state: "visible", timeout: 30_000 });
    await page.locator("[data-stream-transport]").first().click();
    await page.waitForFunction(
      () => {
        const v = document.querySelector<HTMLVideoElement>("[data-stream-video]");
        return Boolean(v && v.readyState >= 2 && !v.paused);
      },
      null,
      { timeout: 30_000 },
    );
    await page.waitForTimeout(1200);

    const inline = await page.evaluate(READ_CONTROLS);
    await page.screenshot({ path: path.join(outDir, "inline.png") });

    await page.locator("button[aria-label='Full screen']").first().click();
    await page.waitForTimeout(2000);
    await page.mouse.move(700, 500);
    await page.waitForTimeout(600);

    const full = await page.evaluate(READ_CONTROLS);
    await page.screenshot({ path: path.join(outDir, "fullscreen.png") });

    const a = new Set(inline.controls as string[]);
    const b = new Set(full.controls as string[]);
    const onlyInline = [...a].filter((x) => !b.has(x));
    const onlyFull = [...b].filter((x) => !a.has(x));

    console.log(JSON.stringify({ inline, full, onlyInline, onlyFull }, null, 2));
    console.log(
      onlyInline.length === 0 && onlyFull.length === 0
        ? "\nPARITY: identical control sets in both modes"
        : "\nPARITY: DRIFT — the two modes still differ",
    );
    await browser.close();
  } finally {
    server.kill();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

