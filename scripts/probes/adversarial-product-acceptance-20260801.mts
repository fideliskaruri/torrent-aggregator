import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Page, type Route } from "playwright";
import { prisma } from "@/lib/prisma";
import { LOCAL_USER_ID } from "@/lib/auth";
import { selectSeriesCandidateWithPackPreference } from "@/lib/torrents/pack-preference";
import { episodesFromFilenames, planSeason } from "@/lib/torrents/season-plan";
import type { MediaMetadata, TorrentResult } from "@/lib/torrents/types";
import {
  resetSwarmWatch,
  swarmDeliveryTick,
  type SwarmWatchDeps,
} from "@/lib/playback/swarm-delivery-watchdog";
import type { AutomaticFailureCause } from "@/lib/playback/narration";
import { resolveAcquisitionTransfer } from "@/app/api/title/[workKey]/acquisition-target";
import {
  selectReusableLocalEpisode,
  selectWorkCandidate,
} from "@/app/api/title/[workKey]/grab";
import { workSearchHitFromMetadata } from "@/lib/search/work-search";
import { canonicalWatchlistPlayerTitle } from "@/app/watchlist/player-identity";

const ROOT = process.cwd();
const OUT = path.resolve(
  process.env.OUT ?? "qa-screens/adversarial-acceptance-20260801",
);
const DIST = process.env.NEXT_DIST_DIR ?? ".next-proof";
const CONTROLLED_PORT = Number(process.env.CONTROLLED_PORT ?? 32481);
const LIVE_PORT = Number(process.env.LIVE_PORT ?? 32482);
const BOUNDARY_PORT = Number(process.env.BOUNDARY_PORT ?? 32483);
const CONTROLLED_BASE = `http://127.0.0.1:${CONTROLLED_PORT}`;
const LIVE_BASE = `http://127.0.0.1:${LIVE_PORT}`;
const BOUNDARY_BASE = `http://127.0.0.1:${BOUNDARY_PORT}`;
const TITLE = "That Time I Got Reincarnated as a Slime";
const WORK_KEY = "that-time-i-got-reincarnated-as-a-slime";
const EXACT_HASH = "1".repeat(40);
const PACK_HASH = "2".repeat(40);
const FALLBACK_720_HASH = "7".repeat(40);
const BUILD_ID = readFileSync(path.join(ROOT, DIST, "BUILD_ID"), "utf8").trim();

mkdirSync(OUT, { recursive: true });

type Check = {
  id: string;
  classification:
    | "live"
    | "scratch-real-server"
    | "controlled-external-boundary"
    | "pure-deterministic";
  pass: boolean;
  actual: unknown;
  expected: unknown;
};

const checks: Check[] = [];
const consoleLog: string[] = [];
const networkLog: string[] = [];
const serverLog: string[] = [];
const boundaryRequests: Array<Record<string, unknown>> = [];
const directSendRequests: string[] = [];

function check(
  id: string,
  classification: Check["classification"],
  pass: boolean,
  actual: unknown,
  expected: unknown,
) {
  checks.push({ id, classification, pass, actual, expected });
}

function hash(n: number): string {
  return n.toString(16).padStart(40, "0");
}

function torrent(
  id: string,
  title: string,
  seeders: number,
  sizeBytes = 900_000_000,
): TorrentResult {
  return {
    id,
    title,
    magnet: `magnet:?xt=urn:btih:${id}`,
    infoHash: id,
    sizeBytes,
    seeders,
    leechers: 1,
    source: "nyaa",
    sourceUrl: `https://example.invalid/${id}`,
    tags: [],
  };
}

const exactRelease = torrent(
  EXACT_HASH,
  `${TITLE} S01E02 1080p WEB-DL`,
  11,
  780_000_000,
);
const packRelease = torrent(
  PACK_HASH,
  `${TITLE} S01 COMPLETE 1080p WEB-DL`,
  900,
  13_626_947_420,
);

function rssItem(release: TorrentResult): string {
  const size =
    release.infoHash === PACK_HASH ? "12.69 GiB" : "743.87 MiB";
  return `<item>
<title><![CDATA[${release.title}]]></title>
<link>${BOUNDARY_BASE}/download/${release.infoHash}.torrent</link>
<guid>${BOUNDARY_BASE}/download/${release.infoHash}.torrent</guid>
<nyaa:seeders>${release.seeders}</nyaa:seeders>
<nyaa:leechers>${release.leechers}</nyaa:leechers>
<nyaa:size>${size}</nyaa:size>
<nyaa:infoHash>${release.infoHash}</nyaa:infoHash>
</item>`;
}

function startBoundary(): Promise<{ server: Server; transmissionAdds: unknown[] }> {
  const transmissionAdds: unknown[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", BOUNDARY_BASE);
    boundaryRequests.push({
      method: req.method,
      path: url.pathname,
      query: url.search,
      body: bodyText || null,
    });
    res.setHeader("cache-control", "no-store");

    if (url.pathname === "/transmission/rpc") {
      const body = bodyText ? JSON.parse(bodyText) : {};
      if (body.method === "torrent-add") transmissionAdds.push(body.arguments);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ result: "success", arguments: {} }));
      return;
    }
    if (url.searchParams.get("page") === "rss") {
      res.writeHead(200, { "content-type": "application/rss+xml" });
      res.end(
        `<?xml version="1.0"?><rss xmlns:nyaa="https://nyaa.si/xmlns/nyaa"><channel>${rssItem(
          packRelease,
        )}${rssItem(exactRelease)}</channel></rss>`,
      );
      return;
    }
    if (url.pathname.endsWith("/q.php")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([{ id: "0", name: "No results returned" }]));
      return;
    }
    if (url.pathname.includes("torrentscsv")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ torrents: [] }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: { movies: [] }, torrents: [] }));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(BOUNDARY_PORT, "127.0.0.1", () =>
      resolve({ server, transmissionAdds }),
    );
  });
}

function appEnvironment(controlled: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    NEXT_DIST_DIR: DIST,
    DATABASE_URL: process.env.DATABASE_URL,
  };
  delete env.PORT;
  if (controlled) {
    env.NYAA_BASE_URL = BOUNDARY_BASE;
    env.APIBAY_BASE_URL = BOUNDARY_BASE;
    env.TORRENTS_CSV_BASE_URL = `${BOUNDARY_BASE}/torrentscsv`;
    env.YTS_BASE_URL = BOUNDARY_BASE;
    env.EZTV_BASE_URL = BOUNDARY_BASE;
    env.TMDB_API_KEY = "";
  } else {
    for (const key of [
      "NYAA_BASE_URL",
      "APIBAY_BASE_URL",
      "TORRENTS_CSV_BASE_URL",
      "YTS_BASE_URL",
      "EZTV_BASE_URL",
      "ENABLE_1337X",
    ]) {
      delete env[key];
    }
  }
  return env;
}

async function startApp(port: number, controlled: boolean): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [path.join(ROOT, "node_modules/next/dist/bin/next"), "start", "-p", String(port)],
    {
      cwd: ROOT,
      env: appEnvironment(controlled),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", (chunk) =>
    serverLog.push(`[${port}:stdout] ${String(chunk).trimEnd()}`),
  );
  child.stderr?.on("data", (chunk) =>
    serverLog.push(`[${port}:stderr] ${String(chunk).trimEnd()}`),
  );
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode != null) {
      throw new Error(`production server ${port} exited ${child.exitCode}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/about`);
      if (response.ok) return child;
    } catch {
      // Startup race.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  child.kill();
  throw new Error(`production server ${port} did not become ready`);
}

async function stopApp(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode != null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) =>
      setTimeout(() => {
        if (child.exitCode == null) child.kill("SIGKILL");
        resolve();
      }, 5_000),
    ),
  ]);
}

async function seedScratch(): Promise<void> {
  await prisma.user.upsert({
    where: { id: LOCAL_USER_ID },
    update: {},
    create: { id: LOCAL_USER_ID, name: "Local User" },
  });
  await prisma.clientSettings.upsert({
    where: { userId: LOCAL_USER_ID },
    update: {
      clientType: "transmission",
      host: BOUNDARY_BASE,
      baseDownloadPath: OUT,
      savePath: OUT,
      maxStorageBytes: BigInt(100_000_000_000),
      storageCapConfigured: true,
      preferredResolution: 1080,
    },
    create: {
      userId: LOCAL_USER_ID,
      clientType: "transmission",
      host: BOUNDARY_BASE,
      baseDownloadPath: OUT,
      savePath: OUT,
      maxStorageBytes: BigInt(100_000_000_000),
      storageCapConfigured: true,
      preferredResolution: 1080,
    },
  });
  await prisma.catalogEntry.create({
    data: {
      workKey: WORK_KEY,
      title: TITLE,
      year: 2018,
      mediaType: "anime",
      overview: "Rimuru builds a nation in another world.",
      source: "acceptance",
      rank: 0,
    },
  });
  await prisma.watchListItem.create({
    data: {
      userId: LOCAL_USER_ID,
      mediaType: "anime",
      externalId: "101280",
      title: TITLE,
      monitored: true,
      status: "watching",
      fromSeason: 1,
      fromEpisode: 1,
      cursorSeason: 1,
      cursorEpisode: 2,
    },
  });
}

function canonicalSearchResponse() {
  return {
    query: TITLE,
    category: "anime",
    results: [
      {
        workKey: WORK_KEY,
        title: TITLE,
        year: 2018,
        category: "anime",
        provider: "anilist",
        mediaType: "anime",
        isSeries: true,
        format: "TV",
        posterUrl: null,
        overview: "Rimuru builds a nation in another world.",
        releaseDate: "2018-10-02",
        href: `/title/${WORK_KEY}?t=${encodeURIComponent(TITLE)}&type=anime&y=2018`,
      },
    ],
  };
}

const extrasResponse = {
  workKey: WORK_KEY,
  season: 1,
  seasonCount: 1,
  seasons: [1],
  episodes: [
    {
      episode: 1,
      name: "The Storm Dragon, Veldora",
      overview: null,
      airDate: "2018-10-02",
      runtimeMin: 24,
      stillUrl: null,
    },
    {
      episode: 2,
      name: "Meeting the Goblins",
      overview: null,
      airDate: "2018-10-09",
      runtimeMin: 24,
      stillUrl: null,
    },
  ],
  moreLikeThis: [],
  overview: "Rimuru builds a nation in another world.",
  rating: 8.1,
  releaseDate: "2018-10-02",
  inTheatricalWindow: false,
  nextHomeReleaseAt: null,
  resolved: true,
  generatedAt: new Date().toISOString(),
};

function observe(page: Page, label: string): void {
  page.on("console", (message) =>
    consoleLog.push(`[${label}] ${message.type()}: ${message.text()}`),
  );
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) {
      networkLog.push(
        `[${label}] -> ${request.method()} ${url.pathname}${url.search} ${request.postData() ?? ""}`,
      );
      if (url.pathname === "/api/torrent/send") {
        directSendRequests.push(request.postData() ?? "");
      }
    }
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith("/api/")) {
      networkLog.push(
        `[${label}] <- ${response.status()} ${url.pathname}${url.search}`,
      );
    }
  });
}

async function routeExtras(page: Page): Promise<void> {
  await page.route(`**/api/title/${WORK_KEY}/extras**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(extrasResponse),
    }),
  );
}

async function searchJourney(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  run: number,
  width: 390 | 1280,
): Promise<Record<string, unknown>> {
  const page = await browser.newPage({
    viewport: { width, height: width === 390 ? 844 : 900 },
    deviceScaleFactor: 1,
  });
  observe(page, `search-${run}-${width}`);
  await page.route("**/api/search/titles**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(canonicalSearchResponse()),
    }),
  );
  await page.goto(
    `${CONTROLLED_BASE}/search?category=anime&q=${encodeURIComponent(TITLE)}`,
    { waitUntil: "domcontentloaded" },
  );
  const overlay = page.locator("[data-search-overlay]");
  await overlay.locator("[data-title-card]").waitFor();
  const dom = await overlay.evaluate((node, canonicalTitle) => {
    const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
    const tabs = [...node.querySelectorAll('[role="tab"]')].map((tab) =>
      tab.textContent?.trim(),
    );
    const cards = [...node.querySelectorAll<HTMLAnchorElement>("[data-title-card]")];
    return {
      tabs,
      cardCount: cards.length,
      allCardsAreTitleLinks: cards.every((card) =>
        card.getAttribute("href")?.startsWith("/title/"),
      ),
      rawRows: node.querySelectorAll("[data-artifact-row]").length,
      playDownloadControls: node.querySelectorAll(
        '[data-action="play"], [data-action="download"]',
      ).length,
      rawFacts: /\b(?:torrent|provider|seeders?|leechers?|file|infohash)\b/i.test(
        text,
      ),
      canonical: text.includes(canonicalTitle),
      text,
    };
  }, TITLE);
  await page.screenshot({
    path: path.join(OUT, `run-${run}-search-${width}.png`),
    fullPage: false,
  });
  await overlay.locator("[data-title-card]").click();
  await page.waitForURL(new RegExp(`/title/${WORK_KEY}`));
  await page.locator("#title-heading").waitFor();
  const selected = {
    url: page.url(),
    heading: (await page.locator("#title-heading").textContent())?.trim(),
  };
  check(
    `search-${run}-${width}`,
    "controlled-external-boundary",
    JSON.stringify(dom.tabs) === JSON.stringify(["Movies", "Series", "Anime"]) &&
      dom.cardCount > 0 &&
      dom.allCardsAreTitleLinks &&
      dom.rawRows === 0 &&
      dom.playDownloadControls === 0 &&
      !dom.rawFacts &&
      dom.canonical &&
      selected.heading === TITLE,
    { dom, selected },
    "Only Movies/Series/Anime; canonical title links only; no raw rows/actions; correct title navigation",
  );
  await page.close();
  return { width, dom, selected };
}

async function searchStates(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  run: number,
): Promise<Record<string, unknown>> {
  const width = run === 1 ? 390 : 1280;
  const page = await browser.newPage({
    viewport: { width, height: width === 390 ? 844 : 900 },
  });
  observe(page, `search-states-${run}`);
  let retryCount = 0;
  await page.route("**/api/search/titles**", async (route: Route) => {
    const q = new URL(route.request().url()).searchParams.get("q");
    if (q === "loading") {
      await new Promise((resolve) => setTimeout(resolve, 900));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ results: [], query: q, category: "anime" }),
      });
      return;
    }
    if (q === "error") {
      retryCount += 1;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Title search failed", results: [] }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ results: [], query: q, category: "anime" }),
    });
  });
  await page.goto(`${CONTROLLED_BASE}/search?category=anime`, {
    waitUntil: "domcontentloaded",
  });
  const input = page.locator("[data-search-overlay-input]");
  const screenshots: string[] = [];
  await input.fill("loading");
  await page.locator("[data-title-card-skeleton]").first().waitFor();
  screenshots.push(path.join(OUT, `run-${run}-search-loading-${width}.png`));
  await page.screenshot({ path: screenshots.at(-1), fullPage: false });
  await input.fill("empty");
  await page.locator("[data-results-empty]").waitFor();
  screenshots.push(path.join(OUT, `run-${run}-search-empty-${width}.png`));
  await page.screenshot({ path: screenshots.at(-1), fullPage: false });
  await input.fill("error");
  const error = page.locator("[data-search-error]");
  await error.waitFor();
  screenshots.push(path.join(OUT, `run-${run}-search-error-${width}.png`));
  await page.screenshot({ path: screenshots.at(-1), fullPage: false });
  await error.getByRole("button", { name: "Try search again" }).click();
  await page.waitForTimeout(150);
  check(
    `search-states-${run}`,
    "controlled-external-boundary",
    retryCount === 2,
    { loading: true, empty: true, error: true, retryCount, screenshots },
    "Loading, empty, error and retry observable; retry issues a second request",
  );
  await page.close();
  return { width, retryCount, screenshots };
}

function streamManifest(infoHash: string) {
  return {
    infoHash,
    files: [
      {
        path: `${TITLE}.S01E02.1080p.WEB-DL.mkv`,
        length: 780_000_000,
        index: 0,
      },
    ],
    primaryVideoIndex: 0,
    targetVideoIndex: 0,
    clientType: "builtin",
    swarm: {
      peers: 4,
      downloadSpeedBps: 4_000_000,
      progress: 1,
      observedAt: Date.now(),
    },
  };
}

async function installSuccessfulPlayerBoundary(
  page: Page,
  selectPosts: unknown[],
): Promise<void> {
  await page.route("**/api/subtitles/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ tracks: [] }),
    }),
  );
  await page.route("**/api/progress**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    }),
  );
  await page.route("**/api/playback/plan", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        plan: {
          rung: "direct",
          reason: "Controlled direct-play boundary",
          cost: 0,
          video: { codec: "h264", action: "direct" },
          audio: [],
          selectedAudioIndex: null,
        },
        playUrl: `/api/stream/${EXACT_HASH}/${encodeURIComponent(
          `${TITLE}.S01E02.1080p.WEB-DL.mkv`,
        )}`,
        sessionId: null,
        startSec: 0,
        strategy: "whole-file",
        strategyReason: "Controlled boundary",
        probe: {
          container: "matroska",
          duration: 1440,
          videoCodec: "h264",
          videoProfile: "High",
          audioCodec: "aac",
          audioChannels: 2,
          width: 1920,
          height: 1080,
        },
      }),
    }),
  );
  await page.route("**/api/stream/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/select")) {
      selectPosts.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          infoHash: FALLBACK_720_HASH,
          positionSec: 321,
          selectedResolution: 720,
        }),
      });
      return;
    }
    if (/^\/api\/stream\/[a-f0-9]{40}$/.test(url.pathname)) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(streamManifest(url.pathname.split("/").at(-1)!)),
      });
      return;
    }
    await route.fulfill({
      status: 206,
      contentType: "video/mp4",
      headers: {
        "accept-ranges": "bytes",
        "content-range": "bytes 0-0/1",
        "content-length": "1",
      },
      body: Buffer.from([0]),
    });
  });
}

async function resetAcquisitionRows(): Promise<void> {
  await prisma.downloadHistory.deleteMany({ where: { userId: LOCAL_USER_ID } });
  await prisma.grabJob.deleteMany({ where: { userId: LOCAL_USER_ID } });
  await prisma.acquisitionTarget.deleteMany({
    where: { userId: LOCAL_USER_ID, workKey: WORK_KEY },
  });
  await prisma.engineTorrent.deleteMany({
    where: { userId: LOCAL_USER_ID, hash: EXACT_HASH },
  });
}

async function titleTransferJourney(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  run: number,
  transmissionAdds: unknown[],
): Promise<Record<string, unknown>> {
  await resetAcquisitionRows();
  const width = run === 1 ? 390 : 1280;
  const page = await browser.newPage({
    viewport: { width, height: width === 390 ? 844 : 900 },
  });
  observe(page, `title-${run}`);
  await routeExtras(page);
  const selectPosts: unknown[] = [];
  await installSuccessfulPlayerBoundary(page, selectPosts);
  const titlePosts: unknown[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === `/api/title/${WORK_KEY}`
    ) {
      titlePosts.push(request.postDataJSON());
    }
  });
  const addStart = transmissionAdds.length;
  const url = `${CONTROLLED_BASE}/title/${WORK_KEY}?t=${encodeURIComponent(
    TITLE,
  )}&type=anime&y=2018&s=1`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const row = page.locator('[data-episode-row][data-episode="2"]');
  await row.waitFor();
  const titleActionText = (await page.locator("main").innerText())
    .replace(/\s+/g, " ")
    .trim();
  await row.locator('[data-action="download"]').click();
  await page.getByRole("alertdialog").waitFor();
  await page.getByRole("radio", { name: /^1080p/ }).check();
  const titleResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === `/api/title/${WORK_KEY}`,
  );
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Download" })
    .click();
  await titleResponse;

  let target = await prisma.acquisitionTarget.findFirstOrThrow({
    where: { userId: LOCAL_USER_ID, workKey: WORK_KEY },
  });
  const persistedAfterApi = {
    targetKey: target.targetKey,
    scope: target.scope,
    season: target.season,
    episode: target.episode,
    preferredResolution: target.preferredResolution,
    status: target.status,
    progress: target.progress,
    infoHash: target.infoHash,
  };

  const states: Record<string, string> = {};
  await prisma.acquisitionTarget.update({
    where: { id: target.id },
    data: { status: "queued", progress: 0, infoHash: null, filePath: null },
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page
    .locator('[data-episode-row][data-episode="2"] [data-episode-transfer="queued"]')
    .waitFor();
  states.queued = (await row.textContent())?.replace(/\s+/g, " ").trim() ?? "";
  await page.screenshot({
    path: path.join(OUT, `run-${run}-title-queued-${width}.png`),
    fullPage: false,
  });

  await prisma.acquisitionTarget.update({
    where: { id: target.id },
    data: {
      status: "downloading",
      progress: 0.061,
      infoHash: EXACT_HASH,
      filePath: null,
    },
  });
  await prisma.engineTorrent.upsert({
    where: { userId_hash: { userId: LOCAL_USER_ID, hash: EXACT_HASH } },
    update: { status: "downloading", progress: 0.061 },
    create: {
      userId: LOCAL_USER_ID,
      hash: EXACT_HASH,
      name: `${TITLE} S01E02 1080p WEB-DL`,
      magnet: `magnet:?xt=urn:btih:${EXACT_HASH}`,
      savePath: null,
      status: "downloading",
      progress: 0.061,
      sizeBytes: 780_000_000,
    },
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page
    .locator(
      '[data-episode-row][data-episode="2"] [data-episode-transfer="downloading"]',
    )
    .waitFor();
  states.downloading =
    (await row.textContent())?.replace(/\s+/g, " ").trim() ?? "";
  states.sibling =
    (
      await page.locator('[data-episode-row][data-episode="1"]').textContent()
    )?.replace(/\s+/g, " ").trim() ?? "";
  await page.screenshot({
    path: path.join(OUT, `run-${run}-title-downloading-${width}.png`),
    fullPage: false,
  });

  await prisma.acquisitionTarget.update({
    where: { id: target.id },
    data: {
      status: "downloaded",
      progress: 1,
      infoHash: EXACT_HASH,
      filePath: `${TITLE}.S01E02.1080p.WEB-DL.mkv`,
    },
  });
  await prisma.engineTorrent.update({
    where: { userId_hash: { userId: LOCAL_USER_ID, hash: EXACT_HASH } },
    data: { status: "seeding", progress: 1 },
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page
    .locator(
      '[data-episode-row][data-episode="2"] [data-episode-transfer="downloaded"]',
    )
    .waitFor();
  states.downloaded =
    (await row.textContent())?.replace(/\s+/g, " ").trim() ?? "";
  await page.reload({ waitUntil: "domcontentloaded" });
  states.afterRefresh =
    (await row.textContent())?.replace(/\s+/g, " ").trim() ?? "";
  await page.screenshot({
    path: path.join(OUT, `run-${run}-title-downloaded-${width}.png`),
    fullPage: false,
  });

  await row.locator('[data-action="stream"]').click();
  const player = page.locator("[data-inline-player]").last();
  await player.locator("[data-player-identity]").waitFor();
  await player.getByRole("button", { name: "Quality" }).click();
  const quality = player.locator("[data-player-quality-choices]");
  await quality.waitFor();
  const qualityLabels = await quality
    .locator("[data-quality-resolution]")
    .allTextContents();
  const playerText = (await player.innerText()).replace(/\s+/g, " ").trim();
  await page.screenshot({
    path: path.join(OUT, `run-${run}-player-quality-${width}.png`),
    fullPage: false,
  });
  await quality.getByRole("button", { name: "1080p" }).click();
  await page.waitForTimeout(200);
  await page.screenshot({
    path: path.join(OUT, `run-${run}-player-fallback-${width}.png`),
    fullPage: false,
  });

  target = await prisma.acquisitionTarget.findFirstOrThrow({
    where: { userId: LOCAL_USER_ID, workKey: WORK_KEY },
  });
  const allTargets = await prisma.acquisitionTarget.findMany({
    where: { userId: LOCAL_USER_ID, workKey: WORK_KEY },
    select: {
      targetKey: true,
      scope: true,
      season: true,
      episode: true,
      status: true,
      infoHash: true,
    },
  });
  const sends = transmissionAdds.slice(addStart);
  const requestBody = titlePosts[0] as Record<string, unknown>;
  const selectBody = selectPosts[0] as Record<string, unknown>;
  await prisma.engineTorrent.delete({
    where: { userId_hash: { userId: LOCAL_USER_ID, hash: EXACT_HASH } },
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await row.waitFor();
  states.missing = (await row.textContent())?.replace(/\s+/g, " ").trim() ?? "";
  const missingPlayControls = await row.locator('[data-action="stream"]').count();
  const missingTarget = await prisma.acquisitionTarget.findFirstOrThrow({
    where: { userId: LOCAL_USER_ID, workKey: WORK_KEY },
    select: {
      status: true,
      progress: true,
      infoHash: true,
      filePath: true,
      error: true,
    },
  });
  await page.screenshot({
    path: path.join(OUT, `run-${run}-title-missing-${width}.png`),
    fullPage: false,
  });
  const forbiddenPlayerText =
    /Try another version|torrent|provider|infohash|[a-f0-9]{40}|Video \d/i.test(
      playerText,
    );
  const result = {
    width,
    requestBody,
    persistedAfterApi,
    transmissionAdds: sends,
    allTargets,
    states,
    playerText,
    qualityLabels,
    selectBody,
    missingPlayControls,
    missingTarget,
    titleActionText,
    fallbackResponse: {
      requested: 1080,
      selected: 720,
      infoHash: FALLBACK_720_HASH,
      positionSec: 321,
    },
  };
  const selectedFilename = JSON.stringify(sends);
  check(
    `episode-keep-and-transfer-${run}`,
    "scratch-real-server",
    requestBody?.scope === "episode" &&
      requestBody?.season === 1 &&
      requestBody?.episode === 2 &&
      requestBody?.preferredResolution === 1080 &&
      directSendRequests.length === 0 &&
      selectedFilename.includes(EXACT_HASH) &&
      !selectedFilename.includes(PACK_HASH) &&
      allTargets.length === 1 &&
      allTargets[0]?.scope === "episode" &&
      allTargets[0]?.episode === 2 &&
      /Queued/.test(states.queued) &&
      /Downloading 6\.1%/.test(states.downloading) &&
      /Downloaded\/Available/.test(states.downloaded) &&
      /Downloaded\/Available/.test(states.afterRefresh) &&
      !/Queued|Downloading|Downloaded\/Available/.test(states.sibling) &&
      !/Downloaded\/Available/.test(states.missing) &&
      missingPlayControls === 0 &&
      missingTarget.status === "failed" &&
      missingTarget.infoHash === null &&
      !/Review season|Review download/i.test(titleActionText),
    result,
    "Explicit E02/1080 payload through title API; exact episode sent; only E02 persisted; queued→6.1%→downloaded survives refresh; sibling clean; deleted torrent removes Downloaded/Play; no Review wording",
  );
  check(
    `player-contract-${run}`,
    "controlled-external-boundary",
    playerText.includes(TITLE) &&
      playerText.includes("Meeting the Goblins") &&
      (playerText.match(/S01E02/g) ?? []).length === 1 &&
      !forbiddenPlayerText &&
      JSON.stringify(qualityLabels) ===
        JSON.stringify(["480p", "720p", "1080p", "2160p"]) &&
      selectBody?.preferredResolution === 1080 &&
      !("infoHash" in (selectBody ?? {})) &&
      !("currentInfoHash" in (selectBody ?? {})),
    {
      playerText,
      qualityLabels,
      selectBody,
      fallback: result.fallbackResponse,
    },
    "Consumer identity; one S01E02; fixed four quality choices; no hashes/raw selectors; 1080 request can fall back to 720 at position 321",
  );
  await page.close();
  return result;
}

function deterministicSelection(run: number): Record<string, unknown> {
  const selected = selectSeriesCandidateWithPackPreference(
    [packRelease, exactRelease],
    { season: 1, episode: 2 },
  );
  const wanted = Array.from({ length: 24 }, (_, index) => index + 1);
  const packCoverage = [0, 6, 8, 23, 24].map((coverage) => {
    const pack = torrent(
      hash(100 + coverage),
      `${TITLE} S01 COMPLETE ${coverage}`,
      100,
    );
    const plan = planSeason({
      season: 1,
      wanted,
      releases: [pack],
      verdictOf: () => "good",
      packContents: () => wanted.slice(0, coverage),
    });
    return {
      coverage,
      eligible: plan.pack != null,
      claimed: plan.covered.length,
      confirmed: plan.coverageConfirmed,
    };
  });
  const singles = wanted.map((episode) =>
    torrent(
      hash(200 + episode),
      `${TITLE} S01E${String(episode).padStart(2, "0")} 720p`,
      5,
    ),
  );
  const singlesPlan = planSeason({
    season: 1,
    wanted,
    releases: [packRelease, ...singles],
    verdictOf: () => "good",
    packContents: () => wanted.slice(0, 23),
  });
  const ranged = torrent(
    hash(350),
    `${TITLE} S01E01-E08 1080p WEB-DL`,
    500,
  );
  const rangeAsExact = selectSeriesCandidateWithPackPreference([ranged], {
    season: 1,
    episode: 1,
  });
  const reusableRange = selectReusableLocalEpisode(
    [
      {
        hash: ranged.infoHash!,
        name: ranged.title,
        status: "downloading",
        origin: "stream",
      },
    ],
    { season: 1, episode: 1 },
  );
  const subtitleCoverage = episodesFromFilenames(
    wanted.flatMap((episode) => [
      `Show.S01E${String(episode).padStart(2, "0")}.srt`,
      `Show.S01E${String(episode).padStart(2, "0")}.ass`,
      `metadata/Show.S01E${String(episode).padStart(2, "0")}.nfo`,
    ]),
    1,
  );
  const subtitlePlan = planSeason({
    season: 1,
    wanted,
    releases: [torrent(hash(351), "Show S01 COMPLETE", 800)],
    verdictOf: () => "good",
    packContents: () => subtitleCoverage,
  });
  const movieReleases = [2160, 1080, 720].map((resolution, index) =>
    torrent(
      hash(360 + index),
      `Dune 2021 ${resolution}p WEB-DL`,
      30 + index,
    ),
  );
  const movieSelections = Object.fromEntries(
    [2160, 1080, 720].map((resolution) => [
      resolution,
      selectWorkCandidate(
        movieReleases,
        "dune-2021",
        false,
        resolution,
        "Dune",
        "movies",
      )?.title ?? null,
    ]),
  );
  const missingTransfer = resolveAcquisitionTransfer(
    {
      status: "downloaded",
      progress: 1,
      infoHash: hash(370),
      filePath: "Show.S01E02.mkv",
      error: null,
    },
    null,
    "unknown",
  );
  const animeMovie = workSearchHitFromMetadata(
    {
      source: "anilist",
      mediaType: "anime",
      externalId: "1999",
      title: "Spirited Away",
      aliases: [],
      year: 2001,
      posterUrl: null,
      synopsis: null,
      releaseDate: "2001-07-20",
      genres: [],
    } satisfies MediaMetadata,
    "anime",
    "MOVIE",
  );
  const watchlistItem = {
    title: TITLE,
    latestReleaseTitle: `${TITLE}.S01E02.1080p.WEB-DL-GROUP`,
  };
  const canonicalWatchlistTitle = canonicalWatchlistPlayerTitle(watchlistItem);
  const result = {
    selected: selected?.infoHash ?? null,
    exactSizeBytes: exactRelease.sizeBytes,
    packSizeBytes: packRelease.sizeBytes,
    packSeeders: packRelease.seeders,
    packCoverage,
    singles: {
      pack: singlesPlan.pack?.release.infoHash ?? null,
      count: singlesPlan.singles.length,
      covered: singlesPlan.covered.length,
      missing: singlesPlan.missing,
      coverageLabel: singlesPlan.coverageLabel,
      confirmed: singlesPlan.coverageConfirmed,
    },
    reviewerCases: {
      rangeAsExact: rangeAsExact?.infoHash ?? null,
      reusableRange: reusableRange?.hash ?? null,
      subtitleCoverage,
      subtitlePackEligible: subtitlePlan.pack != null,
      movieSelections,
      missingTransfer,
      animeMovie: animeMovie
        ? {
            mediaType: animeMovie.mediaType,
            titleMediaType: animeMovie.titleMediaType,
            isSeries: animeMovie.isSeries,
            format: animeMovie.format,
            href: animeMovie.href,
          }
        : null,
      canonicalWatchlistTitle,
    },
  };
  check(
    `deterministic-selection-${run}`,
    "pure-deterministic",
    selected?.infoHash === EXACT_HASH &&
      packCoverage.every((item) =>
        item.coverage === 24
          ? item.eligible && item.claimed === 24
          : !item.eligible && item.claimed === 0,
      ) &&
      singlesPlan.pack == null &&
      singlesPlan.singles.length === 24 &&
      singlesPlan.covered.length === 24 &&
      singlesPlan.missing.length === 0 &&
      singlesPlan.coverageConfirmed &&
      rangeAsExact == null &&
      reusableRange == null &&
      subtitleCoverage.length === 0 &&
      subtitlePlan.pack == null &&
      Object.entries(movieSelections).every(([resolution, title]) =>
        title?.includes(`${resolution}p`),
      ) &&
      missingTransfer.status === "failed" &&
      missingTransfer.infoHash === null &&
      animeMovie?.mediaType === "anime" &&
      animeMovie.titleMediaType === "movie" &&
      animeMovie.isSeries === false &&
      canonicalWatchlistTitle === TITLE,
    result,
    "Exact episode beats pack; coverage is manifest-verified; range/subtitle false positives rejected; movie quality preference, missing transfer, anime movie shape, and canonical watchlist title hold",
  );
  return result;
}

async function deterministicFailover(run: number): Promise<Record<string, unknown>> {
  resetSwarmWatch();
  const target = {
    title: TITLE,
    mediaType: "anime",
    season: 1,
    episode: 2,
    preferredResolution: 1080,
  };
  const representativeCauses: AutomaticFailureCause[] = [
    "metadata-timeout",
    "no-peers",
    "stall",
    "decode",
    "unsupported",
  ];
  async function scenario(count: 6 | 12) {
    const candidates = Array.from({ length: count }, (_, index) =>
      torrent(
        hash(index + 1),
        `${TITLE} S01E02 1080p release ${index + 1}`,
        count - index,
      ),
    );
    const started: string[] = [];
    const abandoned: string[] = [];
    const causes = Array.from(
      { length: count - 1 },
      (_, index) => representativeCauses[index] ?? "stall",
    );
    const deps: SwarmWatchDeps = {
      sample: async () => ({
        atMs: Date.now(),
        downloadedBytes: 0,
        progress: 0,
        state: "downloading",
      }),
      rankedResults: async () => candidates,
      startRelease: async (candidate) => {
        started.push(candidate.infoHash);
        return true;
      },
      abandon: async (infoHash) => {
        abandoned.push(infoHash);
      },
      carryPosition: async () => 321,
    };
    let current = candidates[0].infoHash!;
    const sequence = [current];
    for (const failure of causes) {
      const step = await swarmDeliveryTick(
        `acceptance-${count}-${run}`,
        current,
        target,
        deps,
        { force: true, failure },
      );
      current = step.currentHash;
      sequence.push(current);
    }
    return { causes, sequence, started, abandoned, final: current };
  }
  const six = await scenario(6);
  const twelve = await scenario(12);
  const result = { six, twelve };
  check(
    `service-six-and-twelve-candidate-failover-${run}`,
    "pure-deterministic",
    six.sequence.length === 6 &&
      new Set(six.sequence).size === 6 &&
      six.final === hash(6) &&
      six.started.length === 5 &&
      six.abandoned.length === 5 &&
      twelve.sequence.length === 12 &&
      new Set(twelve.sequence).size === 12 &&
      twelve.sequence.includes(hash(6)) &&
      twelve.final === hash(12) &&
      twelve.started.length === 11 &&
      twelve.abandoned.length === 11,
    result,
    "Actual failover state machine reaches candidates six and twelve with no fixed attempt cap",
  );
  return result;
}

async function uiFailoverProbe(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  run: number,
): Promise<Record<string, unknown>> {
  await resetAcquisitionRows();
  const page = await browser.newPage({
    viewport: { width: run === 1 ? 390 : 1280, height: run === 1 ? 844 : 900 },
  });
  observe(page, `ui-failover-${run}`);
  await routeExtras(page);
  const candidateHashes = Array.from({ length: 12 }, (_, index) => hash(index + 1));
  const switchAttempts: string[] = [];
  await page.route("**/api/subtitles/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ tracks: [] }),
    }),
  );
  await page.route("**/api/playback/candidates", async (route) => {
    const current = route.request().postDataJSON()?.currentInfoHash;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        candidates: candidateHashes.map((infoHash, index) => ({
          infoHash,
          title: `${TITLE} S01E02 release ${index + 1}`,
          resolution: index >= 5 ? 720 : 1080,
          sourceLabel: "WEB-DL",
          sizeBytes: 780_000_000,
          sizeLabel: "744 MB",
          codec: "H.264",
          audio: "AAC",
          playability: "direct",
          seeders: 30 - index,
          isCurrent: infoHash === current,
          verdict: "good",
        })),
      }),
    });
  });
  await page.route("**/api/playback/switch", async (route) => {
    const chosen = route.request().postDataJSON()?.chosenInfoHash;
    switchAttempts.push(chosen);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, infoHash: chosen, positionSec: 321 }),
    });
  });
  await page.route("**/api/playback/plan", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: "Probe timed out",
        probeError: "timeout",
        code: "STALLED",
        failureClass: "delivery",
        retryable: true,
      }),
    }),
  );
  await page.route("**/api/stream/**", async (route) => {
    const url = new URL(route.request().url());
    if (/^\/api\/stream\/[a-f0-9]{40}$/.test(url.pathname)) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(streamManifest(url.pathname.split("/").at(-1)!)),
      });
      return;
    }
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        code: "STALLED",
        failureClass: "delivery",
        retryable: true,
      }),
    });
  });
  await page.goto(
    `${CONTROLLED_BASE}/title/${WORK_KEY}?t=${encodeURIComponent(
      TITLE,
    )}&type=anime&y=2018&s=1`,
    { waitUntil: "domcontentloaded" },
  );
  const row = page.locator('[data-episode-row][data-episode="2"]');
  await row.waitFor();
  await row.locator('[data-action="stream"]').click();
  await page.waitForFunction(
    () =>
      performance.getEntriesByType("resource").filter((entry) =>
        entry.name.includes("/api/playback/switch"),
      ).length >= 12,
    undefined,
    { timeout: 20_000 },
  ).catch(() => undefined);
  await page.waitForTimeout(500);
  const player = page.locator("[data-inline-player]").last();
  const text = (await player.innerText()).replace(/\s+/g, " ").trim();
  const screenshot = path.join(
    OUT,
    `run-${run}-player-failover-exhausted-${run === 1 ? 390 : 1280}.png`,
  );
  await page.screenshot({ path: screenshot, fullPage: false });
  const result = {
    switchAttempts,
    uniqueSourcesIncludingInitial: new Set([EXACT_HASH, ...switchAttempts]).size,
    text,
    screenshot,
  };
  check(
    `ui-automatic-switching-${run}`,
    "controlled-external-boundary",
    switchAttempts.length >= 12 &&
      switchAttempts.includes(hash(6)) &&
      switchAttempts.at(-1) === hash(12) &&
      !/Try another version|candidate|provider|torrent|infohash/i.test(text),
    result,
    "UI automatically reaches candidates six and twelve without premature exhaustion or raw source language",
  );
  await page.close();
  return result;
}

async function resolutionRaceProbe(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  run: number,
): Promise<Record<string, unknown>> {
  await resetAcquisitionRows();
  const page = await browser.newPage({
    viewport: { width: run === 1 ? 390 : 1280, height: run === 1 ? 844 : 900 },
  });
  observe(page, `resolution-race-${run}`);
  await routeExtras(page);
  const fallbackHash = "a".repeat(40);
  const staleResolutionHash = "b".repeat(40);
  const candidateBodies: Array<Record<string, unknown>> = [];
  const selectBodies: Array<Record<string, unknown>> = [];
  const switchAttempts: string[] = [];
  const planHashes: string[] = [];
  const manifestHashes: string[] = [];
  let releaseMediaFailure!: () => void;
  const mediaFailure = new Promise<void>((resolve) => {
    releaseMediaFailure = resolve;
  });

  await page.route("**/api/subtitles/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ tracks: [] }),
    }),
  );
  await page.route("**/api/progress**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    }),
  );
  await page.route("**/api/playback/candidates", async (route) => {
    candidateBodies.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        candidates: [
          {
            infoHash: fallbackHash,
            title: `${TITLE} S01E02 720p fallback`,
            resolution: 720,
            sourceLabel: "WEB-DL",
            sizeBytes: 700_000_000,
            sizeLabel: "668 MB",
            codec: "H.264",
            audio: "AAC",
            playability: "direct",
            seeders: 20,
            isCurrent: false,
            verdict: "good",
          },
        ],
      }),
    });
  });
  await page.route("**/api/playback/switch", async (route) => {
    const chosen = route.request().postDataJSON()?.chosenInfoHash;
    switchAttempts.push(chosen);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, infoHash: chosen, positionSec: 321 }),
    });
  });
  await page.route("**/api/playback/plan", async (route) => {
    const infoHash = route.request().postDataJSON()?.infoHash ?? EXACT_HASH;
    planHashes.push(infoHash);
    const filePath = `${TITLE}.S01E02.1080p.WEB-DL.mkv`;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        plan: {
          rung: "direct",
          reason: "Controlled transition-race boundary",
          cost: 0,
          video: { codec: "h264", action: "direct" },
          audio: [],
          selectedAudioIndex: null,
        },
        playUrl: `/api/stream/${infoHash}/${encodeURIComponent(filePath)}`,
        sessionId: null,
        startSec: 0,
        strategy: "whole-file",
        strategyReason: "Controlled boundary",
        probe: {
          container: "matroska",
          duration: 1440,
          videoCodec: "h264",
          videoProfile: "High",
          audioCodec: "aac",
          audioChannels: 2,
          width: 1920,
          height: 1080,
        },
      }),
    });
  });
  await page.route("**/api/stream/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/select")) {
      selectBodies.push(route.request().postDataJSON());
      await new Promise((resolve) => setTimeout(resolve, 900));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          infoHash: staleResolutionHash,
          positionSec: 321,
          selectedResolution: 720,
        }),
      });
      return;
    }
    if (/^\/api\/stream\/[a-f0-9]{40}$/.test(url.pathname)) {
      const infoHash = url.pathname.split("/").at(-1)!;
      manifestHashes.push(infoHash);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(streamManifest(infoHash)),
      });
      return;
    }
    await mediaFailure;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        code: "STALLED",
        failureClass: "delivery",
        retryable: true,
      }),
    });
  });

  await page.goto(
    `${CONTROLLED_BASE}/title/${WORK_KEY}?t=${encodeURIComponent(
      TITLE,
    )}&type=anime&y=2018&s=1`,
    { waitUntil: "domcontentloaded" },
  );
  const row = page.locator('[data-episode-row][data-episode="2"]');
  await row.waitFor();
  await row.locator('[data-action="stream"]').click();
  const player = page.locator("[data-inline-player]").last();
  await player.getByRole("button", { name: "Quality" }).click();
  const quality = player.locator("[data-player-quality-choices]");
  await quality.waitFor();
  const preferredOption = quality.locator('[data-quality-resolution="1080"]');
  if (
    (await preferredOption.count()) !== 1 ||
    (await preferredOption.textContent())?.trim() !== "1080p"
  ) {
    throw new Error("Player did not render one visible 1080p quality option");
  }
  await preferredOption.click();
  for (let attempt = 0; attempt < 20 && selectBodies.length === 0; attempt += 1) {
    await page.waitForTimeout(50);
  }
  releaseMediaFailure();
  for (let attempt = 0; attempt < 40 && switchAttempts.length === 0; attempt += 1) {
    await page.waitForTimeout(100);
  }
  await page.waitForTimeout(1_100);
  const result = {
    selectBodies,
    candidateBodies,
    switchAttempts,
    planHashes,
    manifestHashes,
    fallbackHash,
    staleResolutionHash,
  };
  check(
    `resolution-session-race-${run}`,
    "controlled-external-boundary",
    selectBodies[0]?.preferredResolution === 1080 &&
      !("infoHash" in (selectBodies[0] ?? {})) &&
      candidateBodies.some((body) => body.preferredResolution === 1080) &&
      switchAttempts.includes(fallbackHash) &&
      planHashes.includes(fallbackHash) &&
      !planHashes.includes(staleResolutionHash) &&
      !manifestHashes.includes(staleResolutionHash),
    result,
    "Resolution intent remains 1080 through automatic recovery and a late select response cannot overwrite the newer fallback target",
  );
  await page.close();
  return result;
}

async function mutationBoundaryProbe(run: number): Promise<Record<string, unknown>> {
  const endpoints = [
    `/api/title/${WORK_KEY}`,
    `/api/stream/${EXACT_HASH}/select`,
  ];
  const results: Array<Record<string, unknown>> = [];
  for (const endpoint of endpoints) {
    for (const requestCase of [
      {
        name: "cross-site-text",
        headers: {
          "content-type": "text/plain",
          "sec-fetch-site": "cross-site",
          origin: "https://attacker.invalid",
        },
        expected: 403,
      },
      {
        name: "same-origin-text",
        headers: {
          "content-type": "text/plain",
          "sec-fetch-site": "same-origin",
          origin: CONTROLLED_BASE,
        },
        expected: 415,
      },
    ]) {
      const response = await fetch(`${CONTROLLED_BASE}${endpoint}`, {
        method: "POST",
        headers: requestCase.headers,
        body: "{}",
      });
      results.push({
        endpoint,
        case: requestCase.name,
        status: response.status,
        expected: requestCase.expected,
        body: await response.text(),
      });
    }
  }
  check(
    `mutation-boundaries-${run}`,
    "scratch-real-server",
    results.every((result) => result.status === result.expected),
    results,
    "Title and resolution-select reject cross-site mutations with 403 and same-origin text/plain with 415",
  );
  return { results };
}

async function liveDiscovery(run: number): Promise<Record<string, unknown>> {
  const workStarted = performance.now();
  const workResponse = await fetch(
    `${LIVE_BASE}/api/search/titles?q=${encodeURIComponent(TITLE)}&category=anime&limit=12`,
  );
  const workLatencyMs = Math.round(performance.now() - workStarted);
  const workBody = (await workResponse.json()) as {
    results?: Array<Record<string, unknown>>;
    error?: string;
    message?: string;
  };
  const canonical = workBody.results?.find(
    (result) => result.title === TITLE,
  );

  const releaseStarted = performance.now();
  const releaseResponse = await fetch(
    `${LIVE_BASE}/api/search?q=${encodeURIComponent(
      TITLE,
    )}&category=anime&sources=nyaa&enrich=0&refresh=1&pageSize=20`,
  );
  const releaseLatencyMs = Math.round(performance.now() - releaseStarted);
  const releaseBody = (await releaseResponse.json()) as {
    results?: Array<Record<string, unknown>>;
    sources?: Array<Record<string, unknown>>;
    error?: string;
    message?: string;
  };
  const top = releaseBody.results?.[0] ?? null;
  const text = JSON.stringify({ canonical, top });
  const result = {
    work: {
      status: workResponse.status,
      latencyMs: workLatencyMs,
      canonical: canonical
        ? {
            title: canonical.title,
            workKey: canonical.workKey,
            year: canonical.year,
            mediaType: canonical.mediaType,
            format: canonical.format,
          }
        : null,
      error: workBody.error ?? workBody.message ?? null,
    },
    release: {
      status: releaseResponse.status,
      latencyMs: releaseLatencyMs,
      sources: releaseBody.sources ?? null,
      top: top
        ? {
            title: top.title,
            seeders: top.seeders,
            source: top.source,
            sizeBytes: top.sizeBytes,
            episode: top.episode,
          }
        : null,
      error: releaseBody.error ?? releaseBody.message ?? null,
    },
    noSwordMetadata: !/sword/i.test(text),
  };
  check(
    `live-slime-discovery-${run}`,
    "live",
    workResponse.ok &&
      Boolean(canonical) &&
      releaseResponse.ok &&
      Boolean(top) &&
      result.noSwordMetadata,
    result,
    "Live canonical Slime work and relevant top Nyaa release, source health/latency recorded, no Sword metadata",
  );
  return result;
}

let boundary: Awaited<ReturnType<typeof startBoundary>> | null = null;
let controlledApp: ChildProcess | null = null;
let liveApp: ChildProcess | null = null;
const report: Record<string, unknown> = {
  generatedAt: new Date().toISOString(),
  buildId: BUILD_ID,
  ports: {
    controlled: CONTROLLED_PORT,
    live: LIVE_PORT,
    boundary: BOUNDARY_PORT,
  },
  runs: {},
};

try {
  await seedScratch();
  boundary = await startBoundary();
  controlledApp = await startApp(CONTROLLED_PORT, true);
  const browser = await chromium.launch({ headless: true });
  try {
    const runs: Record<string, unknown> = {};
    for (const run of [1, 2]) {
      runs[`run${run}`] = {
        search: await searchJourney(
          browser,
          run,
          run === 1 ? 390 : 1280,
        ),
        searchStates: await searchStates(browser, run),
        episode: await titleTransferJourney(
          browser,
          run,
          boundary.transmissionAdds,
        ),
        deterministicSelection: deterministicSelection(run),
        serviceFailover: await deterministicFailover(run),
        uiFailover: await uiFailoverProbe(browser, run),
        resolutionRace: await resolutionRaceProbe(browser, run),
        mutationBoundaries: await mutationBoundaryProbe(run),
      };
    }
    report.runs = runs;
  } finally {
    await browser.close();
  }
  await stopApp(controlledApp);
  controlledApp = null;
  await new Promise<void>((resolve) => boundary?.server.close(() => resolve()));
  boundary = null;

  liveApp = await startApp(LIVE_PORT, false);
  const liveRuns = [];
  for (const run of [1, 2]) liveRuns.push(await liveDiscovery(run));
  report.liveRuns = liveRuns;
} finally {
  await stopApp(controlledApp);
  await stopApp(liveApp);
  if (boundary) {
    await new Promise<void>((resolve) => boundary?.server.close(() => resolve()));
  }
  report.checks = checks;
  report.summary = {
    total: checks.length,
    passed: checks.filter((item) => item.pass).length,
    failed: checks.filter((item) => !item.pass).length,
    releaseBlockers: checks.filter((item) => !item.pass).map((item) => item.id),
  };
  report.directTorrentSendRequests = directSendRequests;
  report.boundaryRequests = boundaryRequests;
  report.evidence = {
    directory: OUT,
    consoleLog: path.join(OUT, "console.log"),
    networkLog: path.join(OUT, "network.log"),
    serverLog: path.join(OUT, "server.log"),
  };
  writeFileSync(path.join(OUT, "console.log"), `${consoleLog.join("\n")}\n`);
  writeFileSync(path.join(OUT, "network.log"), `${networkLog.join("\n")}\n`);
  writeFileSync(path.join(OUT, "server.log"), `${serverLog.join("\n")}\n`);
  writeFileSync(
    path.join(OUT, "acceptance-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  const disconnect = (prisma as unknown as { $disconnect?: () => Promise<void> })
    .$disconnect;
  if (typeof disconnect === "function") await disconnect.call(prisma);
  const dbUrl = process.env.DATABASE_URL ?? "";
  if (dbUrl.startsWith("file:")) {
    const dbPath = dbUrl.slice("file:".length);
    const absolute = path.isAbsolute(dbPath)
      ? dbPath
      : path.resolve(ROOT, dbPath.replace(/^\.[\\/]/, ""));
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      try {
        rmSync(`${absolute}${suffix}`, { force: true });
      } catch (error) {
        serverLog.push(
          `[cleanup] could not remove ${absolute}${suffix}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}

console.log(JSON.stringify(report.summary, null, 2));
console.log(`BUILD_ID ${BUILD_ID}`);
console.log(`Evidence ${OUT}`);
if (checks.some((item) => !item.pass)) process.exitCode = 1;
