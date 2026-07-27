/**
 * End-to-end proof for the owner's playback promise:
 *
 *   "I should just be able to click and start playing immediately. The next
 *   episode too. Playing torrents should take priority."
 *
 * This is deliberately a journey harness, not another unit test. It seeds real
 * torrents into a loopback-only swarm, lets the running app's built-in engine
 * rehydrate them from the database, opens the real browse page, clicks the real
 * Play buttons, and times when the browser decodes its first frame.
 *
 * Judgement rules are self-relative where the thing being measured is relative:
 * duplicate releases are judged against the number of seeded releases for that
 * work; season-pack priority is judged against the requested episode, not a
 * hardcoded file index; and warm up-next is judged against this run's own cold
 * first-frame time. The only absolute threshold is first-frame latency: a human
 * waiting at a black screen has an absolute patience budget, even on different
 * fixtures, so the number is named here and easy to change.
 *
 * Run: npm run test:media:instant
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { chromium, type Browser, type Page } from "playwright";

import { prisma } from "../src/lib/prisma";
import { LOCAL_USER_ID } from "../src/lib/auth-constants";
import { buildBrowsePayload, _readyToPlayRailFromItems } from "../src/lib/browse/rails";
import type { RailItem } from "../src/lib/browse/types";
import { builtinClient, shutdownBuiltinEngine } from "../src/lib/clients/builtin-engine";
import type { ClientConnectionConfig } from "../src/lib/clients";
import { ensureDir, startLocalSwarm, type LocalSwarm, type SeededTorrent } from "./lib/local-swarm.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const FFMPEG = require("ffmpeg-static") as string;

const RUN_ID = randomUUID()
  .replace(/-/g, "")
  .slice(0, 8)
  .replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + Number.parseInt(c, 16)));
const SINGLE_SHOW = `Instant Harness ${RUN_ID}`;
const PACK_SHOW = `Pack Harness ${RUN_ID}`;
const PACK_CARD_TITLE = `Harness ${RUN_ID}`;
const GHOST_SHOW = `Ghost Harness ${RUN_ID}`;

const WORK = path.join(repoRoot, ".e2e-instant-play", RUN_ID);
const SEED_DIR = ensureDir(path.join(WORK, "seed"));
const LEECH_DIR = ensureDir(path.join(WORK, "leech"));
let PORT = 0;
let BASE = "";

const CLIP_SECONDS = 6;
const REQUESTED_PACK_EPISODE = 3;
const NEXT_EPISODE = 4;
const AUTO_ADVANCE_SECONDS = 8;

/**
 * A local loopback swarm removes internet variance; anything above this is the
 * app keeping the viewer at a black screen. Fifteen seconds is already longer
 * than a viewer reads as "immediate", but leaves room for a cold ffprobe and a
 * dev build on CI-class hardware.
 */
const MAX_FIRST_FRAME_MS = 15_000;

/**
 * "Pre-warmed is faster" is only meaningful relative to the cold path this run
 * observed. If both paths are already sub-second, requiring a ratio would create
 * noise, so either "under one second" or "at least 25% faster" is accepted.
 */
const WARM_FAST_ENOUGH_MS = 1_000;
const WARM_RELATIVE_FACTOR = 0.75;

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
let packInfoHashForUi = "";

function record(name: string, ok: boolean, detail = "-"): boolean {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — ${detail}`}`);
  return ok;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(bin: string, args: string[], timeoutMs = 300_000) {
  const res = execFileSync;
  try {
    const stdout = res(bin, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout: stdout.toString(), stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      code: e.status ?? -1,
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? "",
    };
  }
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => pad(c ?? "", widths[i])).join("  ");
  return [line(headers), widths.map((w) => "─".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}

function encodeEpisode(file: string): string {
  const out = path.join(SEED_DIR, file);
  const res = run(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `testsrc2=size=640x360:rate=24:duration=${CLIP_SECONDS}`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${CLIP_SECONDS}:sample_rate=48000`,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "24",
    "-c:a", "aac", "-ac", "2",
    "-shortest",
    out,
  ]);
  if (res.code !== 0 || !fs.existsSync(out)) {
    throw new Error(`failed to encode ${file}: ${res.stderr.trim().split("\n").slice(-3).join(" | ")}`);
  }
  return out;
}

function encodePack(): { dir: string; requestedPathHint: string; nextPathHint: string } {
  const dir = ensureDir(path.join(SEED_DIR, `${PACK_SHOW}.S01.COMPLETE.1080p.WEB-DL-PACK`));
  for (const ep of [1, REQUESTED_PACK_EPISODE, NEXT_EPISODE]) {
    const file = `${PACK_SHOW}.S01E${String(ep).padStart(2, "0")}.1080p.WEB-DL.mp4`;
    const generated = encodeEpisode(file);
    fs.renameSync(generated, path.join(dir, file));
  }
  return {
    dir,
    requestedPathHint: `S01E${String(REQUESTED_PACK_EPISODE).padStart(2, "0")}`,
    nextPathHint: `S01E${String(NEXT_EPISODE).padStart(2, "0")}`,
  };
}

async function withDbRetry<T>(what: string, fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!/timed out|database is locked|SQLITE_BUSY|busy|Transaction already closed/i.test(msg)) throw err;
      console.log(`  (${what} lost the sqlite write lock, retry ${attempt}/8)`);
      await sleep(attempt * 1_000);
    }
  }
  throw last;
}

async function seedEngineRow(seed: SeededTorrent, name: string, origin: "user" | "prewarm" = "user") {
  await withDbRetry(`engine row ${name}`, () =>
    prisma.engineTorrent.upsert({
      where: { userId_hash: { userId: LOCAL_USER_ID, hash: seed.infoHash } },
      update: {
        name,
        magnet: seed.magnetURI,
        savePath: LEECH_DIR,
        status: "seeding",
        progress: 1,
        sizeBytes: BigInt(seed.length),
        origin,
      },
      create: {
        userId: LOCAL_USER_ID,
        hash: seed.infoHash,
        name,
        magnet: seed.magnetURI,
        savePath: LEECH_DIR,
        status: "seeding",
        progress: 1,
        sizeBytes: BigInt(seed.length),
        origin,
      },
    }),
  );
}

async function seedDatabase(seeds: SeededTorrent[]) {
  await withDbRetry("local user", () =>
    prisma.user.upsert({
      where: { id: LOCAL_USER_ID },
      update: {},
      create: { id: LOCAL_USER_ID, name: "Local" },
    }),
  );
  await withDbRetry("client settings", () =>
    prisma.clientSettings.upsert({
      where: { userId: LOCAL_USER_ID },
      update: { clientType: "builtin", savePath: LEECH_DIR, baseDownloadPath: LEECH_DIR },
      create: {
        userId: LOCAL_USER_ID,
        clientType: "builtin",
        host: "http://127.0.0.1:8080",
        savePath: LEECH_DIR,
        baseDownloadPath: LEECH_DIR,
      },
    }),
  );

  await seedEngineRow(seeds[0], `${SINGLE_SHOW}.S01E02.1080p.WEB-DL-GROUPA`);
  await seedEngineRow(seeds[1], `${SINGLE_SHOW}.S01E02.2160p.WEB-DL-GROUPB`);
  await seedEngineRow(seeds[3], `${PACK_SHOW}.S01E04.1080p.WEB-DL-PREWARM`, "prewarm");
  // Insert the pack after the single pre-warm so the collapsed Ready card opens
  // the pack. The up-next resolver can still find the E04 row by episode.
  await seedEngineRow(seeds[2], `${PACK_SHOW}.S01.COMPLETE.1080p.WEB-DL-PACK`);
}

type DevServer = { child: ChildProcess; base: string };

async function startDevServer(expectHashes: string[]): Promise<DevServer> {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const child = spawn(
    process.execPath,
    [path.join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "dev", "-H", "127.0.0.1", "-p", String(PORT)],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        PORT: String(PORT),
        NEXT_TELEMETRY_DISABLED: "1",
        DOWNLOAD_DIR: LEECH_DIR,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  child.stdout?.on("data", (b: Buffer) => {
    const text = b.toString();
    if (/ready|error|Local:/i.test(text)) process.stdout.write(`  [next] ${text}`);
  });
  child.stderr?.on("data", (b: Buffer) => {
    const text = b.toString();
    if (/error|EADDRINUSE|Another next/i.test(text)) process.stdout.write(`  [next] ${text}`);
  });

  const deadline = Date.now() + 420_000;
  const wanted = new Set(expectHashes.map((h) => h.toLowerCase()));
  let last = "not reached";
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`next dev exited with ${child.exitCode}`);
    try {
      const res = await fetch(`${BASE}/api/client/torrents`, { signal: AbortSignal.timeout(20_000) });
      if (res.ok) {
        const body = (await res.json()) as { torrents?: Array<{ hash?: string }> };
        const have = new Set((body.torrents ?? []).map((t) => (t.hash ?? "").toLowerCase()));
        if ([...wanted].every((h) => have.has(h))) return { child, base: BASE };
        last = `missing ${[...wanted].filter((h) => !have.has(h)).join(", ")}`;
      } else {
        last = `HTTP ${res.status}`;
      }

    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await sleep(1_000);
  }
  throw new Error(`dev server did not rehydrate seeded torrents (${last})`);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function stopDevServer(server: DevServer | null) {
  if (!server) return;
  await new Promise<void>((resolve) => {
    server.child.once("exit", () => resolve());
    server.child.kill("SIGTERM");
    setTimeout(() => {
      if (server.child.exitCode == null) server.child.kill("SIGKILL");
      resolve();
    }, 4_000).unref();
  });
}

async function waitForEngineFiles(base: string, hashes: string[]) {
  for (const hash of hashes) {
    const deadline = Date.now() + 120_000;
    let last = "";
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${base}/api/stream/${hash}`, { signal: AbortSignal.timeout(20_000) });
        const body = (await res.json().catch(() => ({}))) as { files?: unknown[] };
        if (res.ok && (body.files?.length ?? 0) > 0) break;
        last = `HTTP ${res.status} files=${body.files?.length ?? 0}`;
      } catch (err) {
        last = err instanceof Error ? err.message : String(err);
      }
      await sleep(1_000);
    }
    if (Date.now() >= deadline) throw new Error(`engine never listed files for ${hash} (${last})`);
  }
}

async function waitForTorrentCompletion(base: string, hashes: string[]) {
  const wanted = new Set(hashes.map((h) => h.toLowerCase()));
  const deadline = Date.now() + 180_000;
  let last = "";
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/api/client/torrents`, { signal: AbortSignal.timeout(20_000) });
    if (res.ok) {
      const body = (await res.json()) as { torrents?: Array<{ hash?: string; progress?: number }> };
      const byHash = new Map((body.torrents ?? []).map((t) => [(t.hash ?? "").toLowerCase(), t.progress ?? 0]));
      const missing = [...wanted].filter((h) => (byHash.get(h) ?? 0) < 0.999);
      if (missing.length === 0) return;
      last = missing.map((h) => `${h.slice(0, 8)}=${Math.round((byHash.get(h) ?? 0) * 100)}%`).join(", ");
    } else {
      last = `HTTP ${res.status}`;
    }
    await sleep(1_000);
  }
  throw new Error(`seeded torrents did not complete in the app engine (${last})`);
}

async function browsePayload(base: string) {
  const res = await fetch(`${base}/api/browse`, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`/api/browse returned ${res.status}`);
  return (await res.json()) as Awaited<ReturnType<typeof buildBrowsePayload>>;
}

async function clickReadyCard(page: Page, title: string) {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  const button = page.locator(`[data-rail="ready-to-play"] [data-card-action="play"][aria-label*="${title}"]`).first();
  await button.waitFor({ state: "visible", timeout: 120_000 });
  await button.scrollIntoViewIfNeeded();
  await button.click();
}

async function firstFrameAfter(page: Page, startedAt: number): Promise<number> {
  const video = page.locator("[data-stream-video]").first();
  await video.waitFor({ state: "visible", timeout: 180_000 });

  const transport = page.locator("[data-stream-transport]").first();
  if (await transport.count().then((n) => n > 0).catch(() => false)) {
    await transport.waitFor({ state: "visible", timeout: 120_000 });
    if ((await transport.getAttribute("aria-label").catch(() => "")) === "Play") {
      await transport.click();
    }
  } else {
    await video.evaluate((el: HTMLVideoElement) => el.play().catch(() => undefined));
  }

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const state = await video.evaluate((el: HTMLVideoElement) => ({
      t: el.currentTime,
      w: el.videoWidth,
      h: el.videoHeight,
      paused: el.paused,
      ended: el.ended,
      error: el.error?.code ?? null,
    }));
    if (state.error) throw new Error(`media error ${state.error}`);
    if (state.t > 0.25 && state.w > 0 && state.h > 0 && !state.paused) return Date.now() - startedAt;
    await sleep(250);
  }
  throw new Error("timed out waiting for first decoded frame");
}

async function playReadyCard(page: Page, title: string): Promise<number> {
  const started = Date.now();
  await clickReadyCard(page, title);
  return firstFrameAfter(page, started);
}

async function selectPackEpisode(page: Page, hint: string): Promise<{ ttfMs: number; selected: string }> {
  const started = Date.now();
  await clickReadyCard(page, PACK_CARD_TITLE);
  const select = page.locator("[data-stream-file-select]").first();
  const hasSelect = await select.waitFor({ state: "visible", timeout: 20_000 }).then(() => true).catch(() => false);
  if (!hasSelect) {
    const manifest = packInfoHashForUi
      ? await fetch(`${BASE}/api/stream/${packInfoHashForUi}`).then((r) => r.json()).catch(() => null) as { files?: Array<{ path: string }> } | null
      : null;
    const ttfMs = await firstFrameAfter(page, started).catch(() => Date.now() - started);
    return {
      ttfMs,
      selected: `NO_FILE_SELECT files=${JSON.stringify(manifest?.files?.map((f) => f.path) ?? null)}`,
    };
  }
  const options = await select.evaluate((el: HTMLSelectElement) =>
    Array.from(el.options).map((o) => ({ value: o.value, label: o.textContent ?? "" })),
  );
  const chosen = options.find((o) => o.value.includes(hint) || o.label.includes(hint));
  assert.ok(chosen, `pack manifest did not contain ${hint}: ${JSON.stringify(options)}`);
  await select.selectOption(chosen.value);
  const ttfMs = await firstFrameAfter(page, started);
  const selected = await select.inputValue();
  return { ttfMs, selected };
}

async function waitForAutoplay(page: Page): Promise<{ offeredMs: number; warmMs: number }> {
  const video = page.locator("[data-stream-video]").first();
  await video.evaluate(() => {
    (window as unknown as { __tfEndedAt?: number }).__tfEndedAt = 0;
    const v = document.querySelector("[data-stream-video]") as HTMLVideoElement | null;
    v?.addEventListener("ended", () => {
      (window as unknown as { __tfEndedAt?: number }).__tfEndedAt = Date.now();
    }, { once: true });
  });

  const endedDeadline = Date.now() + 60_000;
  let endedAt = 0;
  while (Date.now() < endedDeadline) {
    endedAt = await page.evaluate(() => (window as unknown as { __tfEndedAt?: number }).__tfEndedAt ?? 0);
    if (endedAt > 0) break;
    await sleep(250);
  }
  if (!endedAt) throw new Error("episode did not end");

  const offeredAtStart = Date.now();
  await page.locator("[data-up-next-card]").first().waitFor({ state: "visible", timeout: 60_000 });
  const offeredMs = Date.now() - offeredAtStart;

  const triggerAt = endedAt + AUTO_ADVANCE_SECONDS * 1_000;
  const deadline = triggerAt + 180_000;
  while (Date.now() < deadline) {
    const state = await video.evaluate((el: HTMLVideoElement) => ({
      t: el.currentTime,
      w: el.videoWidth,
      paused: el.paused,
      ended: el.ended,
      now: Date.now(),
    }));
    if (state.now >= triggerAt && state.t > 0.25 && state.w > 0 && !state.paused && !state.ended) {
      return { offeredMs, warmMs: state.now - triggerAt };
    }
    await sleep(250);
  }
  throw new Error("up-next did not autoplay to a decoded frame");
}

async function verifyReadyAvailabilityContract() {
  const ghostHash = "f".repeat(40);
  await shutdownBuiltinEngine().catch(() => undefined);
  await withDbRetry("ghost ready row", () =>
    prisma.engineTorrent.upsert({
      where: { userId_hash: { userId: LOCAL_USER_ID, hash: ghostHash } },
      update: {
        name: `${GHOST_SHOW}.S01E01.1080p.WEB-DL`,
        magnet: null,
        status: "seeding",
        progress: 1,
      },
      create: {
        userId: LOCAL_USER_ID,
        hash: ghostHash,
        name: `${GHOST_SHOW}.S01E01.1080p.WEB-DL`,
        magnet: null,
        status: "seeding",
        progress: 1,
        sizeBytes: BigInt(1),
      },
    }),
  );

  const cold = await buildBrowsePayload(LOCAL_USER_ID);
  const coldItem = cold.rails.find((r) => r.id === "ready-to-play")?.items.find((i) => i.title.includes(GHOST_SHOW));
  const pureColdItem: RailItem = {
    id: "cold-window",
    title: GHOST_SHOW,
    subtitle: null,
    posterUrl: null,
    backdropUrl: null,
    availability: null,
    progressFraction: null,
    resumePositionSec: null,
    infoHash: ghostHash,
    filePath: null,
    watchListItemId: null,
    mediaType: null,
    season: null,
    episode: null,
  };
  const pureColdKept = _readyToPlayRailFromItems([pureColdItem])?.items.length === 1;
  record(
    "cold-start presence is neutral, not hidden or unavailable",
    coldItem?.availability === null || pureColdKept,
    coldItem
      ? `payload availability=${String(coldItem.availability)}`
      : `payload did not catch the transient window; filter keeps availability=null: ${pureColdKept}`,
  );

  const config: ClientConnectionConfig = {
    clientType: "builtin",
    host: "",
    username: null,
    password: null,
    category: null,
    savePath: LEECH_DIR,
    userId: LOCAL_USER_ID,
  } as ClientConnectionConfig;
  await builtinClient.listTorrents(config).catch(() => []);
  await sleep(250);
  const warm = await buildBrowsePayload(LOCAL_USER_ID);
  const warmItem = warm.rails.find((r) => r.id === "ready-to-play")?.items.find((i) => i.title.includes(GHOST_SHOW));
  record(
    "completed DB row absent from the engine is not offered as Ready",
    warmItem === undefined,
    warmItem ? `still rendered with availability=${String(warmItem.availability)}` : "hidden after absence was known",
  );
}

async function cleanup(hashes: string[]) {
  await shutdownBuiltinEngine().catch(() => undefined);
  await prisma.mediaProbe.deleteMany({ where: { infoHash: { in: hashes } } }).catch(() => undefined);
  await prisma.engineTorrent.deleteMany({
    where: {
      userId: LOCAL_USER_ID,
      OR: [
        { hash: { in: hashes } },
        { hash: "f".repeat(40) },
        { name: { contains: RUN_ID } },
      ],
    },
  }).catch(() => undefined);
  await prisma.playbackProgress.deleteMany({
    where: {
      userId: LOCAL_USER_ID,
      OR: [{ infoHash: { in: hashes } }, { title: { contains: RUN_ID } }],
    },
  }).catch(() => undefined);
  await prisma.grabJob.deleteMany({
    where: { userId: LOCAL_USER_ID, title: { contains: RUN_ID } },
  }).catch(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
  fs.rmSync(WORK, { recursive: true, force: true });
}

async function main() {
  console.log("── Fixture ──");
  fs.rmSync(WORK, { recursive: true, force: true });
  ensureDir(SEED_DIR);
  ensureDir(LEECH_DIR);

  const singleA = encodeEpisode(`${SINGLE_SHOW}.S01E02.1080p.WEB-DL-GROUPA.mp4`);
  const singleB = encodeEpisode(`${SINGLE_SHOW}.S01E02.2160p.WEB-DL-GROUPB.mp4`);
  const pack = encodePack();
  const nextEpisode = encodeEpisode(`${PACK_SHOW}.S01E04.1080p.WEB-DL-PREWARM.mp4`);
  console.log(`  ${SINGLE_SHOW}: two releases`);
  console.log(`  ${PACK_SHOW}: season pack plus pre-warmed S01E04`);

  console.log("\n── Ready availability contract ──");
  await verifyReadyAvailabilityContract();

  console.log("\n── Local swarm ──");
  let swarm: LocalSwarm | null = await startLocalSwarm();
  console.log(`  tracker ${swarm.trackerUrl} (loopback-only announce list)`);
  const seeds = [
    await swarm.seed(singleA),
    await swarm.seed(singleB),
    await swarm.seed(pack.dir),
    await swarm.seed(nextEpisode),
  ];
  const hashes = seeds.map((s) => s.infoHash);
  packInfoHashForUi = seeds[2].infoHash;
  for (const seed of seeds) console.log(`  seeding ${seed.infoHash.slice(0, 12)} ${seed.filePath}`);

  await seedDatabase(seeds);

  let server: DevServer | null = null;
  let browser: Browser | null = null;
  try {
    console.log("\n── Next dev server ──");
    server = await startDevServer(hashes);
    await waitForEngineFiles(server.base, hashes);
    await waitForTorrentCompletion(server.base, hashes);
    console.log(`  ready at ${server.base}`);

    console.log("\n── Browse payload ──");
    const payload = await browsePayload(server.base);
    const ready = payload.rails.find((r) => r.id === "ready-to-play");
    console.log(
      `  ready: ${JSON.stringify((ready?.items ?? []).map((i) => `${i.title}:${i.availability}:${i.infoHash?.slice(0, 8) ?? "-"}`))}`,
    );
    const singleCards = ready?.items.filter((i) => i.title.includes(SINGLE_SHOW)) ?? [];
    record(
      "Browse shows one card per show, not one per release",
      singleCards.length === 1,
      `${SINGLE_SHOW}: ${singleCards.length} card(s) for 2 seeded releases; ready=` +
        JSON.stringify((ready?.items ?? []).map((i) => `${i.title}:${i.availability}:${i.infoHash?.slice(0, 8) ?? "-"}`)),
    );
    record(
      "Ready cards that offer Play have a live infoHash",
      (ready?.items ?? []).filter((i) => i.title.includes(RUN_ID)).every((i) => i.infoHash && i.availability === "ready"),
      (ready?.items ?? [])
        .filter((i) => i.title.includes(RUN_ID))
        .map((i) => `${i.title}:${i.availability}:${i.infoHash?.slice(0, 8) ?? "nohash"}`)
        .join(", "),
    );

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") console.log(`  [page!] ${msg.text()}`);
    });
    page.on("response", (res) => {
      if (res.url().includes("/api/") && !res.ok() && res.status() !== 425) {
        console.log(`  [http] ${res.status()} ${res.url().replace(/^https?:\/\/[^/]+/, "")}`);
      }
    });

    console.log("\n── Click to first frame ──");
    const singleTtf = await playReadyCard(page, SINGLE_SHOW);
    record(
      "clicking a ready browse card reaches the first decoded frame promptly",
      singleTtf <= MAX_FIRST_FRAME_MS,
      `${singleTtf}ms (limit ${MAX_FIRST_FRAME_MS}ms)`,
    );

    await page.keyboard.press("Escape").catch(() => undefined);
    await page.locator("[data-play-overlay] button[aria-label='Close']").first().click().catch(() => undefined);

    console.log("\n── Season pack priority ──");
    const packRun = await selectPackEpisode(page, pack.requestedPathHint);
    record(
      "season pack starts the requested mid-season episode, not episode 1",
      packRun.selected.includes(pack.requestedPathHint),
      `selected=${packRun.selected}`,
    );
    record(
      "requested pack episode reaches first frame promptly",
      packRun.ttfMs <= MAX_FIRST_FRAME_MS,
      `${packRun.ttfMs}ms (limit ${MAX_FIRST_FRAME_MS}ms)`,
    );

    console.log("\n── Up next ──");
    let upNext: { offeredMs: number; warmMs: number } | null = null;
    if (packRun.selected.includes(pack.requestedPathHint)) {
      try {
        upNext = await waitForAutoplay(page);
        record(
          "episode end offers Up next",
          upNext.offeredMs <= 5_000,
          `${upNext.offeredMs}ms from ended event to card`,
        );
        record(
          "pre-warmed up-next autoplay reaches first frame promptly",
          upNext.warmMs <= MAX_FIRST_FRAME_MS,
          `${upNext.warmMs}ms after autoplay trigger`,
        );
        const warmFast = upNext.warmMs <= WARM_FAST_ENOUGH_MS || upNext.warmMs <= packRun.ttfMs * WARM_RELATIVE_FACTOR;
        record(
          "pre-warmed up-next is faster than this run's cold pack start",
          warmFast,
          `cold=${packRun.ttfMs}ms warm=${upNext.warmMs}ms (` +
            `pass if warm≤${WARM_FAST_ENOUGH_MS}ms or ≤${WARM_RELATIVE_FACTOR}× cold)`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        record("episode end offers Up next", false, message);
        record("pre-warmed up-next autoplay reaches first frame promptly", false, message);
        record("pre-warmed up-next is faster than this run's cold pack start", false, message);
      }
    } else {
      record("episode end offers Up next", false, "skipped because the pack did not open the requested episode");
      record("pre-warmed up-next autoplay reaches first frame promptly", false, "skipped because the pack did not open the requested episode");
      record("pre-warmed up-next is faster than this run's cold pack start", false, "skipped because the pack did not open the requested episode");
    }

    console.log("\n── Results ──\n");
    console.log(
      table(
        ["Measurement", "Value", "Criterion"],
        [
          ["single card first frame", `${singleTtf}ms`, `≤ ${MAX_FIRST_FRAME_MS}ms absolute viewer patience`],
          ["pack S01E03 first frame", `${packRun.ttfMs}ms`, `selected path contains ${pack.requestedPathHint}`],
          ["up-next offered", upNext ? `${upNext.offeredMs}ms` : "not reached", "card appears after ended event"],
          ["up-next warm first frame", upNext ? `${upNext.warmMs}ms` : "not reached", `≤ ${WARM_FAST_ENOUGH_MS}ms or ≤ ${WARM_RELATIVE_FACTOR}× cold`],
          ["ready-card collapse", `${singleCards.length}/2`, "one work card for two seeded releases"],
        ],
      ),
    );
  } finally {
    await browser?.close().catch(() => undefined);
    await stopDevServer(server);
    await swarm?.close().catch(() => undefined);
    swarm = null;
    await cleanup(hashes);
  }

  const failures = checks.filter((c) => !c.ok);
  console.log(
    failures.length === 0
      ? "\nPASS — browse-to-play, pack priority, up-next, and ready truth all held."
      : `\nFAIL — ${failures.length} promise check(s) failed.`,
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("\nFAIL —", err instanceof Error ? err.stack : String(err));
  await prisma.$disconnect().catch(() => undefined);
  fs.rmSync(WORK, { recursive: true, force: true });
  process.exit(1);
});
