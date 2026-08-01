import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";

const BASE = process.env.BASE ?? "http://127.0.0.1:3129";
const OUT = path.resolve(
  process.env.OUT ?? "qa-screens/episode-transfer-player",
);
const HASH = "a".repeat(40);
mkdirSync(OUT, { recursive: true });

type TransferState = "none" | "queued" | "downloading" | "downloaded";

function titlePayload(state: TransferState) {
  const transfer =
    state === "none"
      ? null
      : {
          status: state,
          progress:
            state === "downloading" ? 0.061 : state === "downloaded" ? 1 : 0,
          infoHash: state === "downloaded" ? HASH : null,
          filePath:
            state === "downloaded"
              ? "The.Expanse.S01E02.1080p.WEB-DL-GROUP.mkv"
              : null,
          error: null,
        };
  return {
    workKey: "the-expanse",
    title: "The Expanse",
    year: 2015,
    mediaType: "tv",
    isSeries: true,
    overview: "Humanity has colonized the solar system.",
    rating: 8.4,
    posterUrl: null,
    backdropUrl: null,
    releaseDate: "2015-12-14",
    availability: null,
    infoHash: null,
    downloadFraction: null,
    resume: null,
    seasons: [
      {
        season: 1,
        knownEpisodes: 2,
        pack: {
          name: "The.Expanse.S01.COMPLETE.1080p.WEB-DL",
          availability: "warm",
          infoHash: "c".repeat(40),
          downloadFraction: 0.13,
        },
      },
    ],
    season: 1,
    episodes: [
      {
        season: 1,
        episode: 1,
        label: "S01E01",
        availability: null,
        infoHash: null,
        filePath: null,
        downloadFraction: null,
        watchedFraction: null,
        resumePositionSec: null,
        watched: false,
        nextUp: true,
        fromPack: false,
        transfer: null,
      },
      {
        season: 1,
        episode: 2,
        label: "S01E02",
        availability: state === "downloaded" ? "ready" : null,
        infoHash: state === "downloaded" ? HASH : null,
        filePath:
          state === "downloaded"
            ? "The.Expanse.S01E02.1080p.WEB-DL-GROUP.mkv"
            : null,
        downloadFraction: state === "downloaded" ? 1 : null,
        watchedFraction: null,
        resumePositionSec: null,
        watched: false,
        nextUp: false,
        fromPack: false,
        transfer,
      },
    ],
    episodesTruncated: false,
    library: {
      inLibrary: true,
      watchListItemId: "expanse",
      monitored: true,
      status: "watching",
      cursorSeason: 1,
      cursorEpisode: 1,
      addPayload: null,
    },
    releasesHref: "/search?q=The%20Expanse",
    known: true,
    generatedAt: new Date().toISOString(),
  };
}

const extrasPayload = {
  workKey: "the-expanse",
  season: 1,
  seasonCount: 1,
  seasons: [1],
  episodes: [
    {
      episode: 1,
      name: "Dulcinea",
      overview: null,
      airDate: "2015-12-14",
      runtimeMin: 44,
      stillUrl: null,
    },
    {
      episode: 2,
      name: "Doors & Corners",
      overview: null,
      airDate: "2015-12-15",
      runtimeMin: 43,
      stillUrl: null,
    },
  ],
  moreLikeThis: [],
  overview: null,
  rating: 8.4,
  releaseDate: "2015-12-14",
  inTheatricalWindow: false,
  nextHomeReleaseAt: null,
  resolved: true,
  generatedAt: new Date().toISOString(),
};

async function installRoutes(
  page: Page,
  state: { transfer: TransferState },
  titlePosts: Record<string, unknown>[],
  selectPosts: Record<string, unknown>[],
  directSends: Record<string, unknown>[],
) {
  await page.route("**/api/torrent/send", async (route) => {
    directSends.push((route.request().postDataJSON() ?? {}) as Record<string, unknown>);
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "Direct send is forbidden in this probe" }),
    });
  });
  await page.route("**/api/title/the-expanse**", async (route) => {
    if (new URL(route.request().url()).pathname.endsWith("/extras")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(extrasPayload),
      });
      return;
    }
    if (route.request().method() === "POST") {
      const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
      titlePosts.push(body);
      state.transfer = "queued";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          message: "Intercepted: no transfer was sent.",
          infoHash: null,
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(titlePayload(state.transfer)),
    });
  });
  await page.route("**/api/stream/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/select")) {
      selectPosts.push(
        (route.request().postDataJSON() ?? {}) as Record<string, unknown>,
      );
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, infoHash: HASH }),
      });
      return;
    }
    const isManifest = /^\/api\/stream\/[a-f0-9]{40}$/.test(url.pathname);
    if (isManifest) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          files: [
            {
              path: "The.Expanse.S01E02.1080p.WEB-DL-GROUP.mkv",
              length: 1_610_612_736,
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
        }),
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
  await page.route("**/api/subtitles/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ tracks: [] }),
    }),
  );
}

async function capture(
  page: Page,
  viewport: string,
  state: TransferState,
) {
  const row = page.locator('[data-episode-row][data-episode="2"]');
  await row.waitFor();
  await page.screenshot({
    path: path.join(OUT, `${viewport}-${state}.png`),
    fullPage: false,
  });
  return (await row.textContent())?.replace(/\s+/g, " ").trim() ?? "";
}

async function runViewport(name: string, width: number, height: number) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  const state = { transfer: "none" as TransferState };
  const titlePosts: Record<string, unknown>[] = [];
  const selectPosts: Record<string, unknown>[] = [];
  const directSends: Record<string, unknown>[] = [];
  await installRoutes(page, state, titlePosts, selectPosts, directSends);

  await page.goto(
    `${BASE}/title/the-expanse?t=The%20Expanse&type=tv&y=2015&s=1`,
    { waitUntil: "domcontentloaded" },
  );
  await page.getByRole("button", { name: "Play season" }).waitFor();
  await page.getByRole("button", { name: "Download season" }).waitFor();
  assert.doesNotMatch(await page.locator("body").innerText(), /Review season|Review download/i);
  const e02 = page.locator('[data-episode-row][data-episode="2"]');
  await e02.locator('[data-action="download"]').click();
  await page.getByRole("alertdialog").waitFor();
  await page.getByRole("radio", { name: /^1080p/ }).check();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Download" })
    .click();
  await page.waitForSelector(
    '[data-episode-row][data-episode="2"] [data-episode-transfer="queued"]',
  );
  const queued = await capture(page, name, "queued");

  state.transfer = "downloading";
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(
    '[data-episode-row][data-episode="2"] [data-episode-transfer="downloading"]',
  );
  const downloading = await capture(page, name, "downloading");
  const sibling = (
    await page.locator('[data-episode-row][data-episode="1"]').textContent()
  )?.replace(/\s+/g, " ");

  state.transfer = "downloaded";
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(
    '[data-episode-row][data-episode="2"] [data-episode-transfer="downloaded"]',
  );
  await page.waitForFunction(() => {
    const name = document.querySelector(
      '[data-episode-row][data-episode="2"] [data-episode-name]',
    );
    return name?.textContent?.includes("Doors & Corners") === true;
  });
  const downloaded = await capture(page, name, "downloaded");

  await page
    .locator('[data-episode-row][data-episode="2"] [data-action="stream"]')
    .click();
  const player = page.locator("[data-inline-player]").last();
  await player.waitFor();
  await player.locator("[data-player-identity]").waitFor();
  await player.getByRole("button", { name: "Quality" }).click();
  const quality = player.locator("[data-player-quality-choices]");
  await quality.waitFor();
  const qualityText = (await quality.innerText()).replace(/\s+/g, " ").trim();
  const playerText = (await player.innerText()).replace(/\s+/g, " ").trim();
  const episodeCodes = playerText.match(/S01E02/g) ?? [];
  await page.screenshot({
    path: path.join(OUT, `${name}-player.png`),
    fullPage: false,
  });

  await quality.getByRole("button", { name: "720p" }).click();
  await page.waitForFunction(() => {
    const menu = document.querySelector("[data-quality-selector]");
    return menu == null;
  });

  assert.equal(directSends.length, 0);
  assert.equal(titlePosts.length, 1);
  assert.deepEqual(titlePosts[0], {
    scope: "episode",
    season: 1,
    episode: 2,
    title: "The Expanse",
    mediaType: "tv",
    year: 2015,
    retention: "keep",
    preferredResolution: 1080,
  });
  assert.match(queued, /Queued/);
  assert.match(downloading, /Downloading 6\.1%/);
  assert.doesNotMatch(sibling ?? "", /6\.1%|Downloading|Downloaded\/Available/);
  assert.match(downloaded, /Downloaded\/Available/);
  assert.match(downloaded, /Play/);
  assert.match(playerText, /The Expanse/);
  assert.match(playerText, /Doors & Corners/);
  assert.equal(episodeCodes.length, 1);
  assert.doesNotMatch(
    playerText,
    /WEB-DL|GROUP|Video \d|torrent|provider|source|[a-f0-9]{40}/i,
  );
  assert.deepEqual(qualityText.split(/\s+/), [
    "480p",
    "720p",
    "1080p",
    "2160p",
  ]);
  assert.equal(selectPosts.length, 1);
  assert.equal("infoHash" in selectPosts[0], false);
  assert.equal("currentInfoHash" in selectPosts[0], false);

  await context.close();
  return {
    viewport: `${name} ${width}x${height}`,
    titlePost: titlePosts[0],
    resolutionPost: selectPosts[0],
    queued,
    downloading,
    downloaded,
    qualityText,
  };
}

async function runCandidateFailover(
  run: number,
  candidateCount: number,
  width: number,
  height: number,
) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  const candidateHashes = [HASH, ...Array.from({ length: candidateCount - 1 }, (_, index) =>
    (index + 1).toString(16).padStart(40, "0"),
  )];
  const switchAttempts: string[] = [];
  let prematureExhaustion = false;

  await page.route("**/api/title/the-expanse**", async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        url.pathname.endsWith("/extras")
          ? extrasPayload
          : titlePayload("downloaded"),
      ),
    });
  });
  await page.route("**/api/prewarm**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ next: null }),
    }),
  );
  await page.route("**/api/watch-progress/**", (route) =>
    route.fulfill({ status: 204, body: "" }),
  );
  await page.route("**/api/subtitles/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ tracks: [] }),
    }),
  );
  await page.route("**/api/playback/candidates", async (route) => {
    const currentInfoHash = route.request().postDataJSON()?.currentInfoHash;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        candidates: candidateHashes.map((infoHash, index) => ({
          infoHash,
          title: `Hidden release ${index + 1}`,
          resolution: index === 5 ? 720 : 1080,
          sourceLabel: "WEB-DL",
          sizeBytes: 1_610_612_736,
          sizeLabel: "1.5 GB",
          codec: "H.264",
          audio: "AAC",
          playability: "direct",
          seeders: 30 - index,
          isCurrent: infoHash === currentInfoHash,
          verdict: "good",
        })),
      }),
    });
  });
  await page.route("**/api/playback/switch", async (route) => {
    const chosenInfoHash = route.request().postDataJSON()?.chosenInfoHash;
    switchAttempts.push(chosenInfoHash);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        infoHash: chosenInfoHash,
        positionSec: 321,
      }),
    });
  });
  await page.route("**/api/playback/plan", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
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
        body: JSON.stringify({
          files: [{
            path: "The.Expanse.S01E02.1080p.WEB-DL-GROUP.mkv",
            length: 1_610_612_736,
            index: 0,
          }],
          primaryVideoIndex: 0,
          targetVideoIndex: 0,
          clientType: "builtin",
          swarm: {
            peers: 4,
            downloadSpeedBps: 4_000_000,
            progress: 1,
            observedAt: Date.now(),
          },
        }),
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
    `${BASE}/title/the-expanse?t=The%20Expanse&type=tv&y=2015&s=1`,
    { waitUntil: "domcontentloaded" },
  );
  await page
    .locator('[data-episode-row][data-episode="2"] [data-action="stream"]')
    .click();
  const player = page.locator("[data-inline-player]").last();
  await player.waitFor();

  const deadline = Date.now() + 20_000;
  while (switchAttempts.length < candidateCount - 1 && Date.now() < deadline) {
    const text = (await player.innerText()).replace(/\s+/g, " ").trim();
    if (/\bRetry\b/.test(text)) prematureExhaustion = true;
    await page.waitForTimeout(25);
  }
  await page.getByRole("button", { name: "Retry" }).waitFor({ timeout: 8_000 });
  const playerText = (await player.innerText()).replace(/\s+/g, " ").trim();
  const screenshot = path.join(
    OUT,
    `failover-${candidateCount}-${run}-${width}.png`,
  );
  await page.screenshot({ path: screenshot, fullPage: false });

  assert.equal(prematureExhaustion, false);
  assert.deepEqual(switchAttempts, candidateHashes.slice(1));
  assert.equal(new Set(switchAttempts).size, switchAttempts.length);
  assert.match(playerText, /\bRetry\b/);
  assert.doesNotMatch(playerText, /Try another version/i);
  assert.doesNotMatch(
    playerText,
    /Hidden release|WEB-DL|torrent|provider|source|[a-f0-9]{40}/i,
  );

  await context.close();
  return {
    run,
    candidateCount,
    viewport: `${width}x${height}`,
    switchAttempts,
    playerText,
    screenshot,
  };
}

const browser = await chromium.launch({ headless: true });
try {
  const results = [
    await runViewport("desktop", 1280, 900),
    await runViewport("mobile", 390, 844),
  ];
  const failoverResults = [
    await runCandidateFailover(1, 6, 390, 844),
    await runCandidateFailover(2, 6, 1280, 900),
    await runCandidateFailover(1, 12, 390, 844),
    await runCandidateFailover(2, 12, 1280, 900),
  ];
  writeFileSync(
    path.join(OUT, "report.json"),
    `${JSON.stringify({ journeys: results, failover: failoverResults }, null, 2)}\n`,
  );
  console.log(JSON.stringify({ journeys: results, failover: failoverResults }, null, 2));
  console.log(`PASS episode transfer/player journey (${OUT})`);
} finally {
  await browser.close();
}
