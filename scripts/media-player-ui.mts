/**
 * Drives the REAL inline player in a REAL browser against a REAL torrent.
 *
 * Everything else proves the pipeline the player calls. Nothing proved the
 * player: clicking Play, dragging the scrubber past what ffmpeg has generated,
 * and switching to the English track are all React wiring that no test had ever
 * touched — and a perfect pipeline behind a broken control is *more* confusing
 * to a viewer, not less.
 *
 * So this runs the actual Next app (on its own port, against the repo's own
 * database), seeds a multi-audio fixture into the built-in engine from a
 * loopback swarm, and drives `/client` with Edge. The channel-count assertion
 * after an audio switch is read back off the session's own fMP4 output, because
 * no web API exposes what the decoder is really doing.
 *
 * Run: npm run test:media:ui
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type Browser, type Page } from "playwright";
import type { ProbeResult } from "../src/lib/media/probe";

import { prisma } from "../src/lib/prisma";
import { LOCAL_USER_ID } from "../src/lib/auth-constants";
import {
  multiAudioFixture,
  generateFixture,
  probeFile,
  probeHlsOutput,
  table,
  FFMPEG,
  run,
} from "./lib/media-e2e-support.mjs";
import { startLocalSwarm, ensureDir } from "./lib/local-swarm.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Long enough that seeking to 90s lands far beyond anything ffmpeg has written
 * — which is precisely the case that used to 404, and the reason seek-by-
 * restart exists.
 */
const CLIP_SECONDS = 150;
const SEEK_TARGET_SEC = 90;
const PORT = 3457;
const BASE = `http://127.0.0.1:${PORT}`;
const SESSIONS_DIR = path.join(repoRoot, ".sessions");
const SHOTS_DIR = path.join(repoRoot, "qa-screens", "player");

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "tf-player-ui-"));
const SEED_DIR = ensureDir(path.join(WORK, "seed"));
const LEECH_DIR = ensureDir(path.join(WORK, "leech"));

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];

function record(name: string, ok: boolean, detail = "-"): boolean {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — ${detail}`}`);
  return ok;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** ffmpeg session dirs are on disk, so the harness can read what the server produced. */
function sessionDir(sessionId: string): string {
  return path.join(SESSIONS_DIR, sessionId);
}

/**
 * Which session the player is streaming from is not a filesystem question — a
 * still-running earlier session keeps touching its directory, so "newest mtime"
 * lies. The honest answer is the sessionId in the HLS URLs the page requests.
 */
/** Geometry read out of the live page; see the 390px usability checks below. */
type UiBox = { w: number; h: number; x: number };
type UiMetrics = {
  viewport: number;
  seek: UiBox | null;
  audio: UiBox | null;
  subtitle: UiBox | null;
  chip: UiBox | null;
  toggle: UiBox | null;
  video: UiBox | null;
  docWidth: number;
};

/**
 * Everything needed to check the buffered band against the thing it claims to
 * describe: what the band says, what the media element actually has, and where
 * the band was painted.
 */
type BandState = {
  present: boolean;
  ranges: Array<[number, number]>;
  ahead: number;
  mediaBuffered: Array<[number, number]>;
  mediaTime: number;
  rects: Array<{ x: number; w: number }>;
  host: { x: number; w: number } | null;
  seekMax: number;
};

const READ_BAND = `(() => {
  const el = document.querySelector("[data-stream-buffered]");
  const v = document.querySelector("[data-stream-video]");
  const media = [];
  if (v) {
    for (let i = 0; i < v.buffered.length; i += 1) media.push([v.buffered.start(i), v.buffered.end(i)]);
  }
  const host = el ? el.getBoundingClientRect() : null;
  return {
    present: Boolean(el),
    ranges: el ? JSON.parse(el.getAttribute("data-ranges") || "[]") : [],
    ahead: el ? Number(el.getAttribute("data-ahead")) : 0,
    mediaBuffered: media,
    mediaTime: v ? v.currentTime : 0,
    rects: Array.from(document.querySelectorAll("[data-stream-buffered-range]")).map((r) => {
      const rr = r.getBoundingClientRect();
      return { x: rr.x, w: rr.width };
    }),
    host: host ? { x: host.x, w: host.width } : null,
    seekMax: Number(document.querySelector("[data-stream-seek]")?.getAttribute("max") || 0),
  };
})()`;

/** What the swarm chip is claiming right now. */
type ChipState = {
  present: boolean;
  health: string | null;
  peers: string | null;
  rate: string | null;
  text: string;
};

const READ_CHIP = `(() => {
  const el = document.querySelector("[data-swarm-chip]");
  if (!el) return { present: false, health: null, peers: null, rate: null, text: "" };
  return {
    present: true,
    health: el.getAttribute("data-swarm-health"),
    peers: el.getAttribute("data-swarm-peers"),
    rate: el.getAttribute("data-swarm-rate"),
    text: (el.textContent || "").replace(/\\s+/g, " ").trim(),
  };
})()`;

/** What the browser actually did with the selected subtitle track. */
type CueState = {
  trackCount: number;
  modes: string[];
  cueCounts: number[];
  firstCue: string | null;
  activeCue: string | null;
  trackSrc: string | null;
  mediaTime: number;
};

const READ_CUES = `(() => {
  const v = document.querySelector("[data-stream-video]");
  if (!v) return { trackCount: 0, modes: [], cueCounts: [], firstCue: null, activeCue: null, trackSrc: null, mediaTime: 0 };
  const tt = Array.from(v.textTracks || []);
  const first = tt[0];
  const cues = first && first.cues ? Array.from(first.cues) : [];
  const active = first && first.activeCues ? Array.from(first.activeCues) : [];
  const el = v.querySelector("track");
  return {
    trackCount: tt.length,
    modes: tt.map((t) => t.mode),
    cueCounts: tt.map((t) => (t.cues ? t.cues.length : 0)),
    firstCue: cues.length ? String(cues[0].text) : null,
    activeCue: active.length ? String(active[0].text) : null,
    trackSrc: el ? el.getAttribute("src") : null,
    mediaTime: v.currentTime,
  };
})()`;

async function seekSourceTo(page: Page, targetSec: number): Promise<void> {
  const seekBar = page.locator("[data-stream-seek]").first();
  if (!(await seekBar.count().then((c) => c > 0))) return;
  // Drive the real control the way a pointer does: React listens for `input`,
  // and the player commits the seek on `change`/`mouseup`.
  await seekBar.evaluate((el: HTMLInputElement, target: number) => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(el, String(target));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  }, targetSec);
}

/**
 * The band is a React render of a value sampled a few times a second, while
 * `video.buffered` grows continuously as segments land. So the two are never
 * bit-identical, and demanding that they are produces a flaky test rather than
 * a strict one.
 *
 * The invariant that actually matters is directional: the band may lag the real
 * buffer, but it must never claim buffer the element does not have — that is
 * the "confident lie" this feature exists to avoid. The start of every span is
 * held to the mapping under test, because that is what proves the band is drawn
 * in source time rather than media time.
 */
function bandMatchesMediaBuffer(band: BandState, offsetSec: number, lagTolSec = 8): boolean {
  if (band.ranges.length !== band.mediaBuffered.length) return false;
  return band.ranges.every(([s, e], i) => {
    const expectedStart = Math.min(band.seekMax, band.mediaBuffered[i][0] + offsetSec);
    const expectedEnd = Math.min(band.seekMax, band.mediaBuffered[i][1] + offsetSec);
    const startOk = Math.abs(s - expectedStart) <= 0.5;
    const endOk = e <= expectedEnd + 0.5 && e >= expectedEnd - lagTolSec;
    return startOk && endOk;
  });
}

type SessionWatcher = {
  /** Session ids seen in HLS requests, with first- and last-seen timestamps. */
  seen: Array<{ id: string; firstAt: number; lastAt: number }>;
  attach: (page: Page) => void;
};

function createSessionWatcher(): SessionWatcher {
  const seen: Array<{ id: string; firstAt: number; lastAt: number }> = [];
  return {
    seen,
    attach(page: Page) {
      page.on("request", (req) => {
        const m = /\/api\/playback\/hls\/([^/]+)\//.exec(req.url());
        if (!m) return;
        const id = m[1];
        const at = Date.now();
        const existing = seen.find((s) => s.id === id);
        if (existing) existing.lastAt = at;
        else seen.push({ id, firstAt: at, lastAt: at });
      });
    },
  };
}

/**
 * Wait for a session the player only started pulling from after `after` — the
 * proof that an action (a seek, a track change) really restarted ffmpeg rather
 * than silently reusing what was already playing.
 */
async function awaitNewSessionOutput(watcher: SessionWatcher, after: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const c of watcher.seen.filter((s) => s.firstAt >= after)) {
      const probed = probeHlsOutput(sessionDir(c.id));
      if (probed) return { id: c.id, dir: sessionDir(c.id), probe: probed };
    }
    if (Date.now() >= deadline) return null;
    await sleep(400);
  }
}

/**
 * Wait until the session the player is *currently* pulling from satisfies the
 * expectation. Switching back to a track already played reuses its session, so
 * "a new session appeared" is the wrong question there — "what is the viewer
 * hearing right now" is the right one.
 */
async function awaitActiveSessionOutput(
  watcher: SessionWatcher,
  after: number,
  timeoutMs: number,
  matches: (probe: ProbeResult) => boolean,
) {
  const deadline = Date.now() + timeoutMs;
  let last: { id: string; dir: string; probe: ProbeResult } | null = null;
  for (;;) {
    const active = [...watcher.seen].filter((s) => s.lastAt >= after).sort((a, b) => b.lastAt - a.lastAt)[0];
    if (active) {
      const probed = probeHlsOutput(sessionDir(active.id));
      if (probed) {
        last = { id: active.id, dir: sessionDir(active.id), probe: probed };
        if (matches(probed)) return last;
      }
    }
    if (Date.now() >= deadline) return last;
    await sleep(400);
  }
}

type DevServer = { base: string; child: ChildProcess | null; reused: boolean };

/**
 * Next 16 refuses a second dev server in the same directory, and this repo
 * routinely has one running already. Rather than fight it (or kill somebody
 * else's server), start ours and — if Next objects — parse the port it points
 * us at and reuse that one. A dev server compiles from source, so a reused one
 * is serving exactly the same code.
 */
async function startDevServer(expectHash: string): Promise<DevServer> {
  // Reuse before spawning. Two dev servers in one directory fight over
  // `.next/dev`, and the loser serves 500s for every route with a missing
  // manifest — a failure that looks nothing like its cause. Each candidate has
  // to prove it is talking to *this* database, because a reachable server on
  // another database 404s the fixture and looks like a UI bug instead.
  const candidates = [process.env.MEDIA_UI_BASE?.trim(), BASE, "http://127.0.0.1:3000"];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (await probeDevServer(candidate, expectHash)) return { base: candidate, child: null, reused: true };
  }

  const child = spawn(
    process.execPath,
    [
      path.join(repoRoot, "node_modules", "next", "dist", "bin", "next"),
      "dev",
      // Must match `npm run dev`. With the default bind the dev HMR client
      // cannot complete its websocket handshake against 127.0.0.1, and a dev
      // build that cannot reach HMR never finishes hydrating — the page sits
      // on its server-rendered "Loading client…" skeleton forever.
      "-H",
      "127.0.0.1",
      "-p",
      String(PORT),
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, PORT: String(PORT), NEXT_TELEMETRY_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let reusePort: number | null = null;
  const noteOutput = (text: string) => {
    const other = /Another next dev server is already running/.test(text);
    const local = /Local:\s+https?:\/\/[^:]+:(\d+)/.exec(text);
    if (local) reusePort = Number(local[1]);
    if (other || /error/i.test(text)) process.stdout.write(`  [next] ${text}`);
  };
  child.stdout?.on("data", (b: Buffer) => noteOutput(b.toString()));
  child.stderr?.on("data", (b: Buffer) => noteOutput(b.toString()));

  const deadline = Date.now() + 420_000;
  for (;;) {
    if (reusePort && reusePort !== PORT) {
      const other = `http://127.0.0.1:${reusePort}`;
      if (await probeDevServer(other, expectHash)) {
        child.kill("SIGKILL");
        return { base: other, child: null, reused: true };
      }
    }
    if (await probeDevServer(`http://127.0.0.1:${PORT}`, expectHash)) {
      return { base: `http://127.0.0.1:${PORT}`, child, reused: false };
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(
        "no usable next dev server within 7 minutes — Next refuses a second dev server in this " +
          "directory, so if the one already running is wedged the only options are to wait for it " +
          "or to stop it",
      );
    }
    await sleep(1_000);
  }
}

async function probeDevServer(base: string, expectHash: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/api/client/torrents`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { torrents?: Array<{ hash?: string }> };
    const want = expectHash.toLowerCase();
    return (body.torrents ?? []).some((t) => (t.hash ?? "").toLowerCase() === want);
  } catch {
    return false;
  }
}

/**
 * The engine only rehydrates on a torrents poll, and metadata then has to
 * arrive from the swarm, so the file index is empty for the first few seconds.
 * Wait on the same endpoint the player calls, so a failure below is the UI's
 * fault and not the engine's.
 */
async function waitForEngineFile(base: string, infoHash: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  let last = "";
  for (;;) {
    try {
      const res = await fetch(`${base}/api/stream/${infoHash}`, { signal: AbortSignal.timeout(20_000) });
      const body = (await res.json()) as { files?: unknown[] };
      if (res.ok && (body.files?.length ?? 0) > 0) return;
      last = `status=${res.status} files=${body.files?.length ?? "none"}`;
    } catch (err) {
      last = (err as Error).message;
    }
    if (Date.now() > deadline) throw new Error(`engine never listed the seeded file (${last})`);
    await sleep(2_000);
  }
}

/**
 * The player is one control among many on /client; open it the way a user does.
 *
 * Targeted by info hash, not `.first()`: the database this runs against belongs
 * to a real dev environment and usually has other torrents in it, so the first
 * play button on the page is very often somebody else's.
 */
async function openPlayer(page: Page, base: string, infoHash: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  const selector = `[data-inline-player][data-infohash="${infoHash}"] [data-stream-play-toggle]`;
  for (;;) {
    await page.goto(`${base}/client`, { waitUntil: "domcontentloaded" });
    const toggle = page.locator(selector).first();
    const visible = await toggle
      .waitFor({ state: "visible", timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    if (visible) {
      await toggle.scrollIntoViewIfNeeded().catch(() => undefined);
      await toggle.click();
      return;
    }
    if (Date.now() > deadline) {
      fs.mkdirSync(SHOTS_DIR, { recursive: true });
      await page.screenshot({ path: path.join(SHOTS_DIR, "client-no-play-control.png"), fullPage: true });
      throw new Error(
        `no play control for ${infoHash} on /client — see qa-screens/player/client-no-play-control.png`,
      );
    }
  }
}

// ── Subtitle fixture ──
//
// The player has to find subtitles two ways, so the fixture ships both: a
// `subrip` stream muxed into the MKV, and a `.srt` file sitting beside it — the
// shape of essentially every scene release. That means seeding a *directory*,
// which also makes this the only harness that exercises a multi-file torrent.

/** Release folder name, deliberately in scene form. */
const RELEASE_NAME = "TorrentFlow.Test.2024.1080p.WEB-DL";
/** Every line is on screen from its start to the end of the clip. */
const EMBEDDED_CUE_TEXT = "EMBEDDED ENGLISH SUBTITLE";
/** Cue N of the fixture covers source seconds [(N-1)*step, N*step). */
const SUBTITLE_CUE_STEP_SEC = 5;
const SIDECAR_CUE_TEXT = "SIDECAR FRENCH SUBTITLE";

/**
 * Cues covering the whole clip at 5s intervals, so a screenshot taken at any
 * position has a line on screen and a cue assertion never races the clock.
 */
function srtBody(text: string, seconds: number): string {
  const lines: string[] = [];
  const clock = (t: number) => {
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = Math.floor(t % 60);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(h)}:${pad(m)}:${pad(s)},000`;
  };
  let n = 1;
  for (let t = 0; t < seconds; t += SUBTITLE_CUE_STEP_SEC) {
    const end = Math.min(t + SUBTITLE_CUE_STEP_SEC, seconds);
    lines.push(String(n), `${clock(t)} --> ${clock(end)}`, `${text} ${n}`, "");
    n += 1;
  }
  return lines.join("\n");
}

type SubtitleFixture = {
  /** Directory to seed. */
  dir: string;
  /** Path of the video inside the torrent, as the engine will report it. */
  videoPath: string;
  /** Path of the sidecar inside the torrent. */
  sidecarPath: string;
};

/**
 * Wrap the multi-audio fixture in a release folder: same video, plus an
 * embedded English `subrip` track and a French `.srt` beside it.
 *
 * The audio streams are copied untouched (`-map 0 -c copy`), so every existing
 * audio assertion still sees exactly the file it saw before — the subtitle is
 * appended as a new stream, not a re-encode.
 */
function buildSubtitleFixture(sourceMkv: string, seconds: number): SubtitleFixture {
  const dir = ensureDir(path.join(SEED_DIR, RELEASE_NAME));
  const embeddedSrt = path.join(SEED_DIR, "embedded.srt");
  fs.writeFileSync(embeddedSrt, srtBody(EMBEDDED_CUE_TEXT, seconds), "utf8");

  const video = path.join(dir, `${RELEASE_NAME}.mkv`);
  const res = run(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", sourceMkv,
    "-i", embeddedSrt,
    "-map", "0", "-map", "1:0",
    "-c", "copy", "-c:s", "srt",
    "-metadata:s:s:0", "language=eng",
    "-metadata:s:s:0", "title=English",
    video,
  ]);
  if (res.code !== 0 || !fs.existsSync(video)) {
    throw new Error(
      `failed to mux the subtitle fixture: ${res.stderr.trim().split("\n").slice(-3).join(" | ")}`,
    );
  }

  // A different language from the embedded track, so the two are distinguishable
  // in the picker by name alone.
  const sidecar = path.join(dir, `${RELEASE_NAME}.fre.srt`);
  fs.writeFileSync(sidecar, srtBody(SIDECAR_CUE_TEXT, seconds), "utf8");

  return {
    dir,
    videoPath: `${RELEASE_NAME}/${RELEASE_NAME}.mkv`,
    sidecarPath: `${RELEASE_NAME}/${RELEASE_NAME}.fre.srt`,
  };
}

/**
 * SQLite takes a single writer. The dev server, the engine's own progress
 * writes and whatever else is running against this database all compete for it,
 * and a lost race here fails the run before a single assertion is reached.
 */
async function withDbRetry<T>(what: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = (err as Error).message ?? "";
      if (!/timed out|database is locked|busy/i.test(msg)) throw err;
      console.log(`  (${what} lost the sqlite write lock, retry ${attempt}/8)`);
      await sleep(2_000 * attempt);
    }
  }
  throw lastErr;
}

async function main() {
  console.log("── Fixture ──");
  const fixture = multiAudioFixture(CLIP_SECONDS);
  const seedFile = generateFixture(fixture, SEED_DIR);
  const srcProbe = probeFile(seedFile);
  const srcAudio = srcProbe?.streams.filter((s) => s.codecType === "audio") ?? [];
  console.log(
    `  ${fixture.file} — ${Math.round(fs.statSync(seedFile).size / 1024)} KiB, audio: ` +
      srcAudio.map((a) => `${a.codec}/${a.channels}ch/${a.language ?? "?"}`).join(" + "),
  );

  const subs = buildSubtitleFixture(seedFile, CLIP_SECONDS);
  const releaseProbe = probeFile(path.join(subs.dir, `${RELEASE_NAME}.mkv`));
  const srcSubs = releaseProbe?.streams.filter((s) => s.codecType === "subtitle") ?? [];
  console.log(
    `  ${RELEASE_NAME}/ — embedded subtitles: ` +
      (srcSubs.map((s) => `${s.codec}/${s.language ?? "?"}`).join(" + ") || "none") +
      `, sidecar: ${path.basename(subs.sidecarPath)}`,
  );

  console.log("\n── Local swarm ──");
  const swarm = await startLocalSwarm();
  // A directory, not a file: the sidecar has to be *inside* the torrent for the
  // player to be able to offer it.
  const seeded = await swarm.seed(subs.dir);
  console.log(`  seeding ${seeded.infoHash.slice(0, 12)} via ${swarm.trackerUrl}`);

  // The engine rehydrates live torrents from this row on the first /client poll.
  await withDbRetry("user upsert", () =>
    prisma.user.upsert({
      where: { id: LOCAL_USER_ID },
      update: {},
      create: { id: LOCAL_USER_ID, name: "Local" },
    }),
  );
  await withDbRetry("engineTorrent upsert", () =>
    prisma.engineTorrent.upsert({
      where: { userId_hash: { userId: LOCAL_USER_ID, hash: seeded.infoHash } },
      update: { magnet: seeded.magnetURI, savePath: LEECH_DIR, status: "downloading" },
      create: {
        userId: LOCAL_USER_ID,
        hash: seeded.infoHash,
        name: RELEASE_NAME,
        magnet: seeded.magnetURI,
        savePath: LEECH_DIR,
        status: "downloading",
        progress: 0,
        sizeBytes: seeded.length,
      },
    }),
  );

  let server: DevServer | null = null;
  let browser: Browser | null = null;
  const baselineFfmpeg = countFfmpeg();
  startFfmpegSampler();

  try {
    console.log("\n── Next dev server ──");
    server = await startDevServer(seeded.infoHash);
    console.log(`  ${server.reused ? "reusing the dev server already running at" : "started at"} ${server.base}`);
    const base = server.base;
    // First poll is what triggers the rehydrate → the engine joins the swarm.
    await fetch(`${base}/api/client/torrents`).catch(() => undefined);
    await waitForEngineFile(base, seeded.infoHash);
    console.log("  engine has metadata for the seeded torrent");

    browser = await chromium.launch({ channel: "msedge", headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const watcher = createSessionWatcher();
    watcher.attach(page);
    page.on("console", (msg) => {
      if (msg.type() === "error") console.log(`  [page!] ${msg.text()}`);
    });
    // A bare "404" in the console says nothing about which contract broke. Every
    // failing API call is named, because that is always the first question.
    page.on("response", (res) => {
      const url = res.url();
      if (!url.includes("/api/") || res.ok()) return;
      if (res.status() === 425) return; // metadata still resolving; expected
      console.log(`  [http] ${res.status()} ${url.replace(/^https?:\/\/[^/]+/, "")}`);
    });
    // The plan response is the contract the whole UI is built on; when a control
    // is missing it is almost always because a field of this came back null.
    let lastPlan: Record<string, unknown> | null = null;
    // The offset the current HLS timeline starts at, straight from the server.
    // The buffered band is checked against this, not against the player's own
    // idea of it — otherwise the band would be validated by the very number it
    // is supposed to be using.
    let planStartSec = 0;
    page.on("response", (res) => {
      if (!res.url().includes("/api/playback/plan")) return;
      void res
        .json()
        .then((body: Record<string, unknown>) => {
          lastPlan = body;
          if (typeof body.startSec === "number") planStartSec = body.startSec;
        })
        .catch(() => undefined);
    });

    // A synthetic image-based track, injected into the *list* response only.
    // ffmpeg cannot create a PGS or VobSub stream from text ("Subtitle encoding
    // currently only possible from text to text or bitmap to bitmap"), so no
    // real sample can be generated here. Classification of real ffprobe codec
    // names is covered by src/lib/media/subtitles.test.ts; this covers the other
    // half — that the UI refuses to let a viewer choose such a track.
    await page.route("**/api/subtitles/**", async (route) => {
      const url = route.request().url();
      if (url.includes("track=")) {
        await route.continue();
        return;
      }
      const res = await route.fetch();
      if (!res.ok()) {
        await route.fulfill({ response: res });
        return;
      }
      const body = (await res.json()) as { tracks?: unknown[] };
      body.tracks = [
        ...(body.tracks ?? []),
        {
          id: "embedded:99",
          kind: "embedded",
          label: "English · PGS — unsupported",
          language: "eng",
          codec: "hdmv_pgs_subtitle",
          supported: false,
          unsupportedReason:
            "image-based subtitles cannot be converted to WebVTT — play this release in VLC/MPV for it",
          streamIndex: 99,
          filePath: null,
          needsExtraction: true,
          forced: false,
          hearingImpaired: false,
          src: null,
        },
      ];
      await route.fulfill({ response: res, json: body });
    });

    console.log("\n── Play ──");
    await openPlayer(page, base, seeded.infoHash);

    const video = page.locator("[data-stream-video]").first();
    const appeared = await video
      .waitFor({ state: "visible", timeout: 180_000 })
      .then(() => true)
      .catch(() => false);
    if (!record("the player resolves the file and mounts a <video>", appeared, appeared ? "mounted" : "no <video> appeared")) {
      fs.mkdirSync(SHOTS_DIR, { recursive: true });
      await page.screenshot({ path: path.join(SHOTS_DIR, "player-no-video.png"), fullPage: true });
      console.log(`  last plan: ${JSON.stringify(lastPlan)}`);
      throw new Error("player never mounted a video element — see qa-screens/player/player-no-video.png");
    }

    // The control is what a user presses; assert on it, not on a JS play() call.
    // In HLS mode the native control bar is suppressed (its scrubber measures the
    // generated segment window, not the film), so there is a real button to click.
    const transport = page.locator("[data-stream-transport]").first();
    await transport.waitFor({ state: "visible", timeout: 60_000 });
    record(
      "the transport bar exposes a real play control",
      await transport.isEnabled(),
      `aria-label=${await transport.getAttribute("aria-label")}`,
    );
    await transport.click();
    let advanced = false;
    for (let i = 0; i < 60 && !advanced; i += 1) {
      await sleep(500);
      advanced = await video.evaluate((el: HTMLVideoElement) => el.currentTime > 0.3 && !el.paused);
    }
    const afterPlay = await video.evaluate((el: HTMLVideoElement) => ({
      t: el.currentTime,
      w: el.videoWidth,
      h: el.videoHeight,
    }));
    record(
      "play advances currentTime and decodes frames",
      advanced && afterPlay.w > 0,
      `t=${afterPlay.t.toFixed(2)} ${afterPlay.w}x${afterPlay.h}`,
    );
    // A session that remuxes faster than real time has no #EXT-X-ENDLIST yet, so
    // hls.js would treat it as live and start at the edge — i.e. drop the viewer
    // into the middle of the film. Playback must begin where the session begins.
    record(
      "playback starts at the beginning, not at the live edge",
      afterPlay.t < 15,
      `first observed position ${afterPlay.t.toFixed(2)}s`,
    );

    // ── Pause / resume ── driven through the button, like a viewer would.
    await transport.click();
    await sleep(600);
    const pausedAt = await video.evaluate((el: HTMLVideoElement) => ({ t: el.currentTime, paused: el.paused }));
    await sleep(800);
    const stillThere = await video.evaluate((el: HTMLVideoElement) => el.currentTime);
    record(
      "pause actually stops the clock",
      pausedAt.paused && Math.abs(stillThere - pausedAt.t) < 0.2,
      `paused=${pausedAt.paused} drift=${(stillThere - pausedAt.t).toFixed(3)}s`,
    );
    // The icon must follow the media, not the click — otherwise a refused play
    // leaves a pause icon over a stopped video.
    record(
      "the play control reflects the paused state",
      (await transport.getAttribute("aria-label")) === "Play",
      `aria-label=${await transport.getAttribute("aria-label")}`,
    );
    await transport.click();
    await sleep(1_500);
    const resumed = await video.evaluate((el: HTMLVideoElement) => el.currentTime);
    record("resume restarts it from where it stopped", resumed > pausedAt.t, `t=${resumed.toFixed(2)}`);

    // ── Buffered-ahead band ──
    console.log("\n── Buffered band ──");
    let band = (await page.evaluate(READ_BAND)) as BandState;
    for (let i = 0; i < 30 && band.ranges.length === 0; i += 1) {
      await sleep(500);
      band = (await page.evaluate(READ_BAND)) as BandState;
    }
    record(
      "the seek bar renders a buffered band",
      band.present && band.ranges.length > 0,
      `present=${band.present} ranges=${JSON.stringify(band.ranges)}`,
    );
    // The whole correctness question. `video.buffered` in HLS mode measures the
    // *generated segment window*, which restarts at 0 for every ffmpeg session.
    // The band must be drawn in the timeline the viewer is looking at, so every
    // span has to equal the media's own span plus the session's start offset —
    // checked against the server's `startSec`, not the player's copy of it.
    const bandMatchesMedia = bandMatchesMediaBuffer(band, planStartSec);
    record(
      "the band is drawn in source time, not media time",
      bandMatchesMedia,
      `band=${JSON.stringify(band.ranges)} media=${JSON.stringify(
        band.mediaBuffered.map(([s, e]) => [Math.round(s * 100) / 100, Math.round(e * 100) / 100]),
      )} startSec=${planStartSec}`,
    );
    // The numbers can be right while the pixels are somewhere else entirely.
    const bandGeometryOk =
      band.host !== null &&
      band.rects.length === band.ranges.length &&
      band.rects.every((rect, i) => {
        const host = band.host!;
        const expectedX = host.x + (band.ranges[i][0] / band.seekMax) * host.w;
        const expectedW = ((band.ranges[i][1] - band.ranges[i][0]) / band.seekMax) * host.w;
        return Math.abs(rect.x - expectedX) <= 2 && Math.abs(rect.w - expectedW) <= 2;
      });
    record(
      "the painted band matches the range it reports",
      bandGeometryOk,
      `rects=${JSON.stringify(band.rects.map((r) => ({ x: Math.round(r.x), w: Math.round(r.w) })))} host=${JSON.stringify(
        band.host && { x: Math.round(band.host.x), w: Math.round(band.host.w) },
      )} max=${band.seekMax}`,
    );
    record(
      "the band reports real buffer ahead of the playhead",
      band.ahead > 0,
      `${band.ahead}s ahead of ${(band.mediaTime + planStartSec).toFixed(1)}s`,
    );
    // Taken here rather than only at the end: this is the moment the band is
    // widest and most legible, and the whole point of this project's screenshot
    // discipline is that a human has to be able to see it.
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    await page
      .locator("[data-stream-transport-row]")
      .first()
      .screenshot({ path: path.join(SHOTS_DIR, "transport-band-early.png") })
      .catch(() => undefined);

    // ── Seek beyond what has been generated ──
    console.log("\n── Seek ──");
    const seekBar = page.locator("[data-stream-seek]").first();
    const hasSeek = await seekBar.count().then((c) => c > 0);
    if (!record("the HLS source timeline exposes a seek control", hasSeek, hasSeek ? "present" : "no [data-stream-seek]")) {
      console.log(`  plan was: ${JSON.stringify(lastPlan)?.slice(0, 600)}`);
      throw new Error("no seek control to drive");
    }
    const seekMark = Date.now();
    await seekSourceTo(page, SEEK_TARGET_SEC);

    let seekOk = false;
    let seekDetail = "never resumed";
    for (let i = 0; i < 90 && !seekOk; i += 1) {
      await sleep(500);
      const state = await video.evaluate((el: HTMLVideoElement) => ({
        t: el.currentTime,
        paused: el.paused,
        err: el.error?.code ?? null,
      }));
      const label = await page.locator("[data-stream-seek]").first().inputValue().catch(() => "?");
      // The HLS timeline restarts at 0 and the player owns the offset, so the
      // proof of a working seek is the *source* position, not video.currentTime.
      const sourcePos = Number(label);
      if (state.err) {
        seekDetail = `media error code ${state.err}`;
        break;
      }
      if (sourcePos >= SEEK_TARGET_SEC - 2 && !state.paused && state.t > 0.2) {
        seekOk = true;
        seekDetail = `source ${sourcePos.toFixed(0)}s, media t=${state.t.toFixed(2)}s`;
      }
    }
    record("seeking past the generated segments resumes playback there", seekOk, seekDetail);

    // A seek is served one of two legitimate ways: ffmpeg is restarted at the
    // offset (`-ss`, a brand-new session), or the running session has already
    // muxed past the target and the player just moves within its timeline.
    // Which one happens is a race with ffmpeg, so assert the disjunction and
    // name the branch — the restart path itself is proven deterministically by
    // media-ladder-e2e.mts.
    const seekSession = await awaitNewSessionOutput(watcher, seekMark, 20_000);
    const servedFromExisting = seekOk && seekSession === null;
    record(
      "the seek is served by a restart at the offset or by the running session",
      seekSession !== null || servedFromExisting,
      seekSession
        ? `restarted ffmpeg — session ${seekSession.id.slice(0, 12)}`
        : "served from the session already covering the target",
    );

    // ── The band after a seek: the assertion that catches a media-time band ──
    //
    // The session restarted at ~90s and its media timeline went back to 0. A
    // band built from raw `video.buffered` now paints at the far LEFT of the
    // bar while the viewer watches at 1:30 — confidently telling them the start
    // of the film is safe to watch. Only a source-space mapping puts it here.
    let bandAfterSeek = (await page.evaluate(READ_BAND)) as BandState;
    for (let i = 0; i < 30 && bandAfterSeek.ranges.length === 0; i += 1) {
      await sleep(500);
      bandAfterSeek = (await page.evaluate(READ_BAND)) as BandState;
    }
    const lastRangeEnd = bandAfterSeek.ranges.length
      ? bandAfterSeek.ranges[bandAfterSeek.ranges.length - 1][1]
      : -1;
    record(
      "after seeking to 1:30 the band sits at 1:30, not back at 0:00",
      bandAfterSeek.ranges.length > 0 && lastRangeEnd >= SEEK_TARGET_SEC - 10,
      `ranges=${JSON.stringify(bandAfterSeek.ranges)} (media buffered ${JSON.stringify(
        bandAfterSeek.mediaBuffered.map(([s, e]) => [Math.round(s), Math.round(e)]),
      )}, startSec=${planStartSec})`,
    );
    const afterSeekMatches = bandMatchesMediaBuffer(bandAfterSeek, planStartSec);
    record(
      "the band still equals media buffer + the new session offset",
      afterSeekMatches,
      `band=${JSON.stringify(bandAfterSeek.ranges)} media=${JSON.stringify(
        bandAfterSeek.mediaBuffered.map(([s, e]) => [
          Math.round(s * 100) / 100,
          Math.round(e * 100) / 100,
        ]),
      )} startSec=${planStartSec}`,
    );

    // ── Audio track switch ──
    console.log("\n── Audio track ──");
    const audioSelect = page.locator("[data-stream-audio-select]").first();
    const hasPicker = await audioSelect.count().then((c) => c > 0);
    record("a multi-audio release offers a track picker", hasPicker, hasPicker ? "present" : "no [data-stream-audio-select]");

    if (hasPicker) {
      const options = await audioSelect.evaluate((el: HTMLSelectElement) =>
        Array.from(el.options).map((o) => ({ value: o.value, label: o.textContent ?? "" })),
      );
      const current = await audioSelect.inputValue();
      const other = options.find((o) => o.value !== current);
      record(
        "both source tracks are listed with usable labels",
        options.length === 2 && options.every((o) => o.label.trim().length > 0),
        options.map((o) => o.label).join(" | "),
      );

      if (other) {
        const switchMark = Date.now();
        const wantedIndex = Number(other.value);
        const sourceTrack = srcAudio.find((s) => s.index === wantedIndex);
        await audioSelect.selectOption(other.value);
        const switched = await awaitActiveSessionOutput(
          watcher,
          switchMark,
          90_000,
          (p) => p.streams.find((s) => s.codecType === "audio")?.channels === sourceTrack?.channels,
        );
        if (switched) {
          const outAudio = switched.probe.streams.find((s) => s.codecType === "audio");
          record(
            `switching to "${other.label.trim()}" re-muxes that track`,
            outAudio != null,
            outAudio ? `${outAudio.codec}/${outAudio.channels}ch` : "no audio in the new output",
          );
          // The owner's hard requirement: a language switch must never be the
          // thing that quietly turns 5.1 into stereo.
          const expected = sourceTrack?.channels ?? 0;
          record(
            "the switched track keeps its source channel count (no silent downmix)",
            outAudio?.channels === expected,
            `expected ${expected}ch, got ${outAudio?.channels ?? "none"}ch`,
          );
        } else {
          record("switching to the other track re-muxes that track", false, "no session output");
          record("the switched track keeps its source channel count (no silent downmix)", false, "not reached");
        }

        // Switch back to the 5.1 track and prove *that* is 6 channels, which is
        // the case the viewer actually cares about.
        const backMark = Date.now();
        await audioSelect.selectOption(current);
        const back = await awaitActiveSessionOutput(
          watcher,
          backMark,
          90_000,
          (p) => p.streams.find((s) => s.codecType === "audio")?.channels === 6,
        );
        const backAudio = back?.probe.streams.find((s) => s.codecType === "audio");
        record(
          "switching back to the 5.1 track restores 6 channels",
          backAudio?.channels === 6,
          `${backAudio?.codec ?? "none"}/${backAudio?.channels ?? "-"}ch`,
        );
      }
    }

    // ── The band once the session really is rebased ──
    //
    // Everything above ran against sessions that happened to start at 0, where a
    // media-time band and a source-time band are indistinguishable. Switching
    // audio re-plans at the current position, so ffmpeg restarts with `-ss` and
    // the media element's timeline goes back to 0 while the viewer is still at
    // ~1:50. That is the only state in which this feature can actually be wrong,
    // so it is the state the assertions have to be made in.
    console.log("\n── Buffered band after a real session offset ──");
    let rebased = (await page.evaluate(READ_BAND)) as BandState;
    for (let i = 0; i < 40 && rebased.ranges.length === 0; i += 1) {
      await sleep(500);
      rebased = (await page.evaluate(READ_BAND)) as BandState;
    }
    record(
      "the audio switch restarted the session at a non-zero offset",
      planStartSec >= 30,
      `startSec=${planStartSec}`,
    );
    const mediaStart = rebased.mediaBuffered.length ? rebased.mediaBuffered[0][0] : -1;
    const bandStart = rebased.ranges.length ? rebased.ranges[0][0] : -1;
    record(
      "the media element's own buffer really has gone back to ~0 (the trap this guards)",
      mediaStart >= 0 && mediaStart < 5,
      `video.buffered starts at ${mediaStart.toFixed(2)}s`,
    );
    record(
      "the band is drawn where the viewer is, not where the segments are",
      bandStart >= planStartSec - 5,
      `band starts at ${bandStart}s, media buffer at ${mediaStart.toFixed(2)}s, session offset ${planStartSec}s`,
    );
    const rebasedMatches = bandMatchesMediaBuffer(rebased, planStartSec);
    record(
      "every rebased span equals its media span plus the session offset",
      rebasedMatches,
      `band=${JSON.stringify(rebased.ranges)} media=${JSON.stringify(
        rebased.mediaBuffered.map(([s, e]) => [Math.round(s * 100) / 100, Math.round(e * 100) / 100]),
      )} startSec=${planStartSec}`,
    );

    // ── Swarm health chip ──
    //
    // The point of the chip is to answer "is this going to keep playing?", so
    // the assertions are about honesty: a real number when it knows, the word
    // "unknown" when it does not, and never the word "seeders" — the engine
    // reports connected peers and cannot distinguish seeds from leeches.
    console.log("\n── Swarm chip ──");
    let chip = (await page.evaluate(READ_CHIP)) as ChipState;
    for (let i = 0; i < 20 && (!chip.present || chip.health === "unknown"); i += 1) {
      await sleep(1_000);
      chip = (await page.evaluate(READ_CHIP)) as ChipState;
    }
    record("the player shows a permanent swarm chip", chip.present, chip.text || "absent");
    const chipPeers = Number(chip.peers);
    record(
      "the chip reports a real connected-peer count from the engine",
      chip.peers !== null && chip.peers !== "unknown" && Number.isFinite(chipPeers) && chipPeers >= 1,
      `peers=${chip.peers} health=${chip.health} rate=${chip.rate} text="${chip.text}"`,
    );
    record(
      "the chip says peers, never seeders (the engine cannot count seeds)",
      !/seed/i.test(chip.text),
      `text="${chip.text}"`,
    );
    const chipTitle = await page.locator("[data-swarm-chip]").first().getAttribute("title");
    record(
      "the chip carries a readable summary of what the numbers mean",
      Boolean(chipTitle && /peer/i.test(chipTitle)),
      chipTitle ?? "no title",
    );

    // Cut the status feed and the chip must admit it does not know. The bug
    // class this project keeps hitting is a UI that keeps rendering the last
    // healthy number — or a confident 0 — after it stopped being able to check.
    await page.route("**/api/stream/**", async (route) => {
      if (route.request().url().includes("poll=1")) {
        await route.abort();
        return;
      }
      await route.continue();
    });
    let blindChip = (await page.evaluate(READ_CHIP)) as ChipState;
    for (let i = 0; i < 20 && blindChip.health !== "unknown"; i += 1) {
      await sleep(1_000);
      blindChip = (await page.evaluate(READ_CHIP)) as ChipState;
    }
    record(
      "when the status feed dies the chip says unknown, not 0 and not stale-healthy",
      blindChip.health === "unknown" && /unknown/i.test(blindChip.text) && !/\b0 peers\b/.test(blindChip.text),
      `health=${blindChip.health} text="${blindChip.text}"`,
    );
    await page
      .locator("[data-swarm-chip]")
      .first()
      .screenshot({ path: path.join(SHOTS_DIR, "swarm-chip-unknown.png") })
      .catch(() => undefined);
    await page.unroute("**/api/stream/**");
    let recovered = (await page.evaluate(READ_CHIP)) as ChipState;
    for (let i = 0; i < 20 && recovered.health === "unknown"; i += 1) {
      await sleep(1_000);
      recovered = (await page.evaluate(READ_CHIP)) as ChipState;
    }
    record(
      "the chip recovers once the status feed comes back",
      recovered.health !== "unknown" && Number(recovered.peers) >= 1,
      `health=${recovered.health} peers=${recovered.peers}`,
    );

    // ── Subtitles ──
    console.log("\n── Subtitles ──");
    const subSelect = page.locator("[data-stream-subtitle-select]").first();
    const hasSubPicker = await subSelect.count().then((c) => c > 0);
    record("the player offers a subtitle picker", hasSubPicker, hasSubPicker ? "present" : "no [data-stream-subtitle-select]");

    if (hasSubPicker) {
      const subOptions = await subSelect.evaluate((el: HTMLSelectElement) =>
        Array.from(el.options).map((o) => ({
          value: o.value,
          label: (o.textContent ?? "").trim(),
          disabled: o.disabled,
        })),
      );
      console.log(`  tracks: ${subOptions.map((o) => `${o.label}${o.disabled ? " [disabled]" : ""}`).join(" | ")}`);
      record(
        "the picker always offers Off",
        subOptions.some((o) => o.value === "" && /off/i.test(o.label)),
        subOptions.map((o) => o.label).join(" | "),
      );
      const sidecarOption = subOptions.find((o) => o.value.startsWith("sidecar:") && !o.disabled);
      const embeddedOption = subOptions.find((o) => o.value.startsWith("embedded:") && !o.disabled);
      record(
        "the sidecar .srt inside the torrent is listed",
        Boolean(sidecarOption),
        sidecarOption?.label ?? "no sidecar: option",
      );
      record(
        "the embedded subtitle stream is listed",
        Boolean(embeddedOption),
        embeddedOption?.label ?? "no embedded: option",
      );
      // Image-based codecs cannot become WebVTT. Offering one would be a track
      // that silently never renders — exactly the "claimed something it had not
      // checked" defect class. NOTE: this track is injected by page.route above
      // because ffmpeg cannot synthesise a real PGS stream from text.
      const pgsOption = subOptions.find((o) => /pgs/i.test(o.label));
      record(
        "an image-based (PGS) track is shown but not selectable, and labelled unsupported",
        Boolean(pgsOption?.disabled) && /unsupported/i.test(pgsOption?.label ?? ""),
        pgsOption ? `${pgsOption.label} disabled=${pgsOption.disabled}` : "no PGS option (stub failed)",
      );

      const readCuesUntil = async (predicate: (c: CueState) => boolean, tries = 40): Promise<CueState> => {
        let state = (await page.evaluate(READ_CUES)) as CueState;
        for (let i = 0; i < tries && !predicate(state); i += 1) {
          await sleep(500);
          state = (await page.evaluate(READ_CUES)) as CueState;
        }
        return state;
      };

      if (sidecarOption) {
        await subSelect.selectOption(sidecarOption.value);
        const cues = await readCuesUntil((c) => (c.cueCounts[0] ?? 0) > 0);
        record(
          "selecting the sidecar track makes the browser load and show its cues",
          cues.modes[0] === "showing" && (cues.cueCounts[0] ?? 0) > 0,
          `mode=${cues.modes[0]} cues=${cues.cueCounts[0]} first="${cues.firstCue}"`,
        );
        record(
          "the cues are the ones from the sidecar file, not some other track",
          Boolean(cues.firstCue && cues.firstCue.includes(SIDECAR_CUE_TEXT)),
          `first cue "${cues.firstCue}"`,
        );
        await page
          .locator("[data-stream-video]")
          .first()
          .screenshot({ path: path.join(SHOTS_DIR, "subtitle-sidecar-on-video.png") })
          .catch(() => undefined);
      }

      if (embeddedOption) {
        await subSelect.selectOption(embeddedOption.value);
        const cues = await readCuesUntil(
          (c) => Boolean(c.firstCue && c.firstCue.includes(EMBEDDED_CUE_TEXT)),
          60,
        );
        record(
          "selecting the embedded track extracts it with ffmpeg and shows its cues",
          cues.modes[0] === "showing" && (cues.cueCounts[0] ?? 0) > 0,
          `mode=${cues.modes[0]} cues=${cues.cueCounts[0]} src=${cues.trackSrc}`,
        );
        record(
          "the extracted cues are the ones muxed into the container",
          Boolean(cues.firstCue && cues.firstCue.includes(EMBEDDED_CUE_TEXT)),
          `first cue "${cues.firstCue}"`,
        );
        // A spinner still reading "Extracting subtitles from the file…" while
        // the subtitles are on screen is the same defect class as a fabricated
        // swarm number: the UI describing a state it has not re-checked.
        let status: string | null = "extracting";
        for (let i = 0; i < 20 && status !== null; i += 1) {
          await sleep(400);
          status = await page
            .locator("[data-stream-subtitle-status]")
            .first()
            .getAttribute("data-stream-subtitle-status")
            .catch(() => null);
          if (status !== "extracting" && status !== "loading") break;
        }
        record(
          "the status line stops claiming extraction once the cues are on screen",
          status !== "extracting" && status !== "loading",
          `status=${status ?? "gone"}`,
        );
        // The cue timings are in *source* time but the HLS element restarted at
        // 0 for this session; without rebasing, every cue here is 90s late and
        // the viewer sees an empty track that looks like a broken release.
        //
        // This only proves anything when the session really is rebased: if the
        // seek happened to be served by a session that started at 0, the
        // mapping is the identity and a broken implementation would still pass.
        // So put the playhead at a known point well inside the film — far
        // enough in that the offset is real, far enough from the end that cues
        // still exist there — and let the restart give us a non-zero offset.
        await seekSourceTo(page, SEEK_TARGET_SEC);
        await awaitActiveSessionOutput(watcher, Date.now(), 90_000, () => true).catch(
          () => null,
        );
        await sleep(2_500);
        // A cue can only be "active" once the element is actually running: at
        // currentTime 0 with the session still starting there is nothing to be
        // active yet, and asserting then measures the restart, not the mapping.
        let moving = (await page.evaluate(READ_CUES)) as CueState;
        for (let i = 0; i < 40 && moving.mediaTime <= 0.5; i += 1) {
          if (i === 10) {
            await page
              .locator("[data-stream-play-toggle]")
              .first()
              .click()
              .catch(() => undefined);
          }
          await sleep(500);
          moving = (await page.evaluate(READ_CUES)) as CueState;
        }
        record(
          "the subtitle rebasing check is running at a real non-zero session offset",
          planStartSec > 5 && moving.mediaTime > 0.5,
          `startSec=${planStartSec} mediaTime=${moving.mediaTime.toFixed(2)}s`,
        );
        // Not "a cue is showing" — an unrebased track also shows a cue here,
        // just the wrong one (line 1 instead of line 19). The fixture numbers
        // every cue by its own source position, so the only honest check is
        // that the line on screen is the line that belongs at this point of the
        // film.
        const active = await readCuesUntil(
          (c) => c.mediaTime > 0.5 && c.activeCue !== null,
          60,
        );
        const sourceSec = planStartSec + active.mediaTime;
        const wantCue = Math.floor(sourceSec / SUBTITLE_CUE_STEP_SEC) + 1;
        const shownCue = Number(/(\d+)\s*$/.exec(active.activeCue ?? "")?.[1] ?? NaN);
        record(
          `the cue on screen is the one that belongs at ${Math.round(sourceSec)}s, not at ${Math.round(active.mediaTime)}s`,
          Number.isFinite(shownCue) && Math.abs(shownCue - wantCue) <= 1,
          active.activeCue
            ? `showing "${active.activeCue.replace(/\n/g, " ")}" at source ${sourceSec.toFixed(1)}s (expected cue ${wantCue})`
            : `no active cue at all; ${active.cueCounts[0]} cues loaded from ${active.trackSrc} (mediaTime ${active.mediaTime.toFixed(2)}s)`,
        );
        record(
          `a cue is on screen at ${SEEK_TARGET_SEC}s (cues rebased onto the session timeline)`,
          active.activeCue !== null,
          active.activeCue
            ? `showing "${active.activeCue.replace(/\n/g, " ")}"`
            : `no active cue; ${active.cueCounts[0]} cues loaded from ${active.trackSrc}`,
        );
      }

      await subSelect.selectOption("");
      const offState = (await page.evaluate(READ_CUES)) as CueState;
      record(
        "choosing Off removes the track from the video",
        offState.trackSrc === null || offState.modes.every((m) => m !== "showing"),
        `modes=${JSON.stringify(offState.modes)} src=${offState.trackSrc}`,
      );
      // Leave a track on so the screenshots below show a real subtitle.
      if (embeddedOption) {
        await subSelect.selectOption(embeddedOption.value);
        await readCuesUntil((c) => c.activeCue !== null, 40);
      }
    }

    // ── Screenshots ──
    console.log("\n── Screenshots ──");
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    const panel = page.locator(`[data-inline-player][data-infohash="${seeded.infoHash}"]`).first();
    await panel.screenshot({ path: path.join(SHOTS_DIR, "player-1440.png") }).catch(() => undefined);
    await page.screenshot({ path: path.join(SHOTS_DIR, "client-1440.png"), fullPage: false });

    // Tight crops, because the three new features are small and the whole point
    // of this project's screenshot discipline is that someone has to be able to
    // *see* whether the band is in the right place.
    await page
      .locator("[data-stream-transport-row]")
      .first()
      .screenshot({ path: path.join(SHOTS_DIR, "transport-band-1440.png") })
      .catch((e: unknown) => console.log(`  (no transport crop: ${String(e).split("\n")[0]})`));
    await page
      .locator("[data-swarm-chip]")
      .first()
      .screenshot({ path: path.join(SHOTS_DIR, "swarm-chip-1440.png") })
      .catch((e: unknown) => console.log(`  (no chip crop: ${String(e).split("\n")[0]})`));
    await page
      .locator("[data-stream-video]")
      .first()
      .screenshot({ path: path.join(SHOTS_DIR, "subtitle-on-video-1440.png") })
      .catch((e: unknown) => console.log(`  (no subtitle crop: ${String(e).split("\n")[0]})`));

    await page.setViewportSize({ width: 390, height: 844 });
    await sleep(800);
    await panel.screenshot({ path: path.join(SHOTS_DIR, "player-390.png") }).catch(() => undefined);
    await page.screenshot({ path: path.join(SHOTS_DIR, "client-390.png"), fullPage: false });

    // Measured, not eyeballed: a control smaller than ~24px is not draggable
    // with a thumb, and one that overflows its container cannot be reached.
    // Passed as a source string, not a function: tsx compiles inner helpers with
    // esbuild's `__name` wrapper, which does not exist inside the page.
    const metrics = (await page.evaluate(`(() => {
      const box = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x) };
      };
      return {
        viewport: window.innerWidth,
        seek: box("[data-stream-seek]"),
        audio: box("[data-stream-audio-select]"),
        subtitle: box("[data-stream-subtitle-select]"),
        chip: box("[data-swarm-chip]"),
        toggle: box("[data-stream-play-toggle]"),
        video: box("[data-stream-video]"),
        docWidth: document.documentElement.scrollWidth,
      };
    })()`)) as UiMetrics;
    console.log(`  390px metrics: ${JSON.stringify(metrics)}`);
    record(
      "at 390px nothing in the player overflows the viewport",
      metrics.docWidth <= 390 + 1,
      `document scrollWidth ${metrics.docWidth}`,
    );
    record(
      "at 390px the seek bar is wide enough to drag",
      (metrics.seek?.w ?? 0) >= 120,
      `seek width ${metrics.seek?.w ?? 0}px`,
    );
    record(
      "at 390px the audio picker is still on screen and legible",
      (metrics.audio?.w ?? 0) >= 90 && (metrics.audio?.x ?? -1) >= 0,
      `audio ${JSON.stringify(metrics.audio)}`,
    );
    record(
      "at 390px the subtitle picker is still on screen and legible",
      (metrics.subtitle?.w ?? 0) >= 90 && (metrics.subtitle?.x ?? -1) >= 0,
      `subtitle ${JSON.stringify(metrics.subtitle)}`,
    );
    record(
      "at 390px the swarm chip is still visible and does not push the layout out",
      (metrics.chip?.w ?? 0) > 0 &&
        (metrics.chip?.x ?? -1) >= 0 &&
        (metrics.chip?.x ?? 0) + (metrics.chip?.w ?? 0) <= 391,
      `chip ${JSON.stringify(metrics.chip)}`,
    );

    // ── Teardown: unmounting must not leave ffmpeg running ──
    console.log("\n── Teardown ──");
    await page.locator("[data-stream-play-toggle]").first().click(); // collapse
    await page.goto(`${base}/client`, { waitUntil: "domcontentloaded" });
    await sleep(2_000);
    await page.close();
    await context.close();
    stopFfmpegSampler();
    // Sessions are ref-counted with an idle timeout, so the honest assertion is
    // that nothing survives the player going away — measured against the peak,
    // which proves ffmpeg was actually running in the first place.
    let after = countFfmpeg();
    for (let i = 0; i < 20 && after > baselineFfmpeg; i += 1) {
      await sleep(1_000);
      after = countFfmpeg();
    }
    record(
      "closing the player leaves no ffmpeg behind",
      after <= baselineFfmpeg && peakFfmpeg > 0,
      `baseline=${baselineFfmpeg} peak=${peakFfmpeg} after=${after}`,
    );
  } finally {
    stopFfmpegSampler();
    if (browser) await browser.close().catch(() => undefined);
    if (server?.child) {
      server.child.kill("SIGKILL");
      await sleep(1_500);
    }
    // Ask the engine to drop the torrent before removing the row, so a reused
    // dev server does not keep a dead magnet alive for the next agent.
    await fetch(`${server?.base ?? BASE}/api/client/torrents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "delete", hash: seeded.infoHash, deleteFiles: true }),
    }).catch(() => undefined);
    await prisma.engineTorrent
      .deleteMany({ where: { userId: LOCAL_USER_ID, hash: seeded.infoHash } })
      .catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    await swarm.close();
    fs.rmSync(WORK, { recursive: true, force: true });
    // Only our own server's sessions are ours to delete — a reused dev server
    // may belong to another agent with live playback of its own.
    if (server && !server.reused) fs.rmSync(SESSIONS_DIR, { recursive: true, force: true });
  }

  console.log("\n── Player UI results ──\n");
  console.log(
    table(
      ["Check", "Result", "Detail"],
      checks.map((c) => [c.name, c.ok ? "PASS" : "FAIL", c.detail]),
    ),
  );
  console.log(`\nScreenshots: ${path.relative(repoRoot, SHOTS_DIR)}`);

  const failed = checks.filter((c) => !c.ok).length;
  console.log(
    failed === 0
      ? "\nPASS — the real player, in a real browser, against a real torrent."
      : `\nFAIL — ${failed} check(s) failed.`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

function countFfmpeg(): number {
  try {
    const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq ffmpeg.exe", "/NH"], {
      encoding: "utf8",
    });
    return (out.match(/ffmpeg\.exe/gi) ?? []).length;
  } catch {
    return 0;
  }
}

/**
 * "0 before, 0 after" would be a vacuous leak check on a short clip, because a
 * remux of a 150s file is over in seconds. Sampling the peak while the player
 * is working proves ffmpeg really ran, so the final count means something.
 */
let peakFfmpeg = 0;
let sampler: NodeJS.Timeout | null = null;
function startFfmpegSampler(): void {
  sampler = setInterval(() => {
    peakFfmpeg = Math.max(peakFfmpeg, countFfmpeg());
  }, 700);
  sampler.unref();
}
function stopFfmpegSampler(): void {
  if (sampler) clearInterval(sampler);
  sampler = null;
}

// A borrowed dev server can restart under us mid-run, and every wait in here is
// bounded except the browser's own. Fail loudly rather than hang a CI shell.
const OVERALL_TIMEOUT_MS = 15 * 60_000;
const overall = setTimeout(() => {
  console.error(`\nFAIL — the harness exceeded ${OVERALL_TIMEOUT_MS / 60_000} minutes; giving up.`);
  process.exit(1);
}, OVERALL_TIMEOUT_MS);

main()
  .then(() => clearTimeout(overall))
  .catch((err) => {
    console.error("\nFAIL —", err instanceof Error ? err.stack : String(err));
    process.exit(1);
  });
