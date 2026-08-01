/**
 * Title-first Search overlay contract, exercised against a production build.
 *
 * The deterministic section intercepts only `/api/search/titles`, so CI proves
 * UI behavior without depending on TMDB/AniList availability. The final live
 * Anime check is read-only, clearly labeled, and treats provider unavailability
 * as non-gating while still failing on a successful but contract-breaking reply.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page, type Route } from "playwright";

const BASE = process.env.BASE ?? "http://127.0.0.1:3108";
const OUT = process.env.OUT ?? "ui-sweep/search-overlay.png";
const VIEWPORTS = [
  { name: "mobile", width: 375, height: 844 },
  { name: "desktop", width: 1280, height: 800 },
] as const;
const PRODUCT_TABS = ["Movies", "Series", "Anime"];
const RAW_FIELDS = [
  "seeders",
  "leechers",
  "sourceUrl",
  "infoHash",
  "downloadUrl",
  "files",
];

type ProductCategory = "movies" | "series" | "anime";

interface WorkHit {
  workKey: string;
  title: string;
  year: number | null;
  category: ProductCategory;
  provider: "tmdb" | "anilist";
  mediaType: "movie" | "tv" | "anime";
  isSeries: boolean;
  format: string | null;
  posterUrl: string | null;
  overview: string | null;
  releaseDate: string | null;
  href: string;
}

interface FixtureState {
  rateAttempts: number;
  requests: string[];
}

const failures: string[] = [];
const passes: string[] = [];

function expect(condition: unknown, message: string): asserts condition {
  if (condition) passes.push(message);
  else failures.push(message);
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function fixtureHit(query: string, category: ProductCategory): WorkHit {
  const title = query === "rate" ? "Recovered title" : `${query} ${category}`;
  const mediaType =
    category === "movies" ? "movie" : category === "series" ? "tv" : "anime";
  const isSeries = category !== "movies";
  const workKey = slug(title);
  return {
    workKey,
    title,
    year: 2020,
    category,
    provider: category === "anime" ? "anilist" : "tmdb",
    mediaType,
    isSeries,
    format: category === "anime" ? "TV" : null,
    posterUrl: null,
    overview: `${title} synopsis`,
    releaseDate: "2020-01-01",
    href: `/title/${workKey}?t=${encodeURIComponent(title)}&type=${mediaType}`,
  };
}

async function fulfillTitleFixture(route: Route, state: FixtureState) {
  const url = new URL(route.request().url());
  state.requests.push(url.toString());
  const query = url.searchParams.get("q") ?? "";
  const rawCategory = url.searchParams.get("category") ?? "movies";
  const category = (
    ["movies", "series", "anime"].includes(rawCategory) ? rawCategory : "movies"
  ) as ProductCategory;

  if (query === "loading") {
    await new Promise((resolve) => setTimeout(resolve, 900));
  }
  if (query === "rate" && state.rateAttempts++ === 0) {
    await route.fulfill({
      status: 429,
      contentType: "application/json",
      body: JSON.stringify({ error: "Too many requests", results: [] }),
    });
    return;
  }
  if (query === "server") {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ results: [] }),
    });
    return;
  }

  await route
    .fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        query,
        category,
        results: query === "empty" ? [] : [fixtureHit(query, category)],
      }),
    })
    .catch(() => undefined);
}

function screenshotPath(viewport: (typeof VIEWPORTS)[number]): string {
  if (viewport.name === "desktop") return OUT;
  const parsed = path.parse(OUT);
  return path.join(parsed.dir, `${parsed.name}-${viewport.name}${parsed.ext || ".png"}`);
}

function titleResponse(page: Page, query: string, category?: ProductCategory) {
  return page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === "/api/search/titles" &&
      url.searchParams.get("q") === query &&
      (category == null || url.searchParams.get("category") === category)
    );
  });
}

async function assertTitleOnlyDom(page: Page, label: string) {
  const overlay = page.locator("[data-search-overlay]");
  const tabs = await overlay.getByRole("tab").allTextContents();
  const cards = overlay.locator("[data-title-card]");
  const links = overlay.locator('[data-card-target="title"]');
  const cardCount = await cards.count();
  const linkCount = await links.count();
  const text = (await overlay.textContent()) ?? "";

  expect(
    JSON.stringify(tabs) === JSON.stringify(PRODUCT_TABS),
    `${label}: tabs are exactly Movies, Series, Anime`,
  );
  expect(cardCount > 0, `${label}: work title cards render`);
  expect(linkCount === cardCount, `${label}: every work card is one title link`);
  for (let index = 0; index < linkCount; index += 1) {
    const href = await links.nth(index).getAttribute("href");
    expect(href?.startsWith("/title/"), `${label}: title link ${index + 1} targets /title`);
  }

  const forbiddenSelectors = [
    '[data-action="play"]',
    '[data-action="download"]',
    '[data-action="expand-releases"]',
    "[data-release-row]",
    "[data-artifact-row]",
    "[data-torrent-row]",
  ];
  for (const selector of forbiddenSelectors) {
    expect(
      (await overlay.locator(selector).count()) === 0,
      `${label}: ${selector} is absent`,
    );
  }
  expect(
    !/\b(?:provider|indexer|torrent|seeders?|leechers?|infohash)\b/i.test(text),
    `${label}: provider/torrent/swarm facts are absent`,
  );
}

const outDir = path.dirname(OUT);
if (outDir && outDir !== ".") fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
try {
  for (const viewport of VIEWPORTS) {
    const state: FixtureState = { rateAttempts: 0, requests: [] };
    const page = await browser.newPage({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: 1,
    });
    await page.route("**/api/search/titles**", (route) =>
      fulfillTitleFixture(route, state),
    );

    const initialResponse = titleResponse(page, "Fixture", "anime");
    await page.goto(`${BASE}/search?q=Fixture&category=anime`, {
      waitUntil: "domcontentloaded",
    });
    await initialResponse;
    await page.locator("[data-search-overlay]").waitFor();
    await page
      .locator('[data-search-overlay] [data-card-target="title"]')
      .waitFor();

    expect(
      new URL(page.url()).searchParams.get("q") === "Fixture",
      `${viewport.name}: durable URL keeps q`,
    );
    expect(
      new URL(page.url()).searchParams.get("category") === "anime",
      `${viewport.name}: durable URL keeps category`,
    );
    await assertTitleOnlyDom(page, viewport.name);
    await page.screenshot({
      path: screenshotPath(viewport),
      fullPage: false,
    });

    for (const [category, tabLabel] of [
      ["movies", "Movies"],
      ["series", "Series"],
      ["anime", "Anime"],
    ] as const) {
      const response = titleResponse(page, "Fixture", category);
      await page.getByRole("tab", { name: tabLabel }).click();
      await response;
      const current = new URL(page.url());
      expect(
        current.searchParams.get("q") === "Fixture" &&
          current.searchParams.get("category") === category,
        `${viewport.name}: ${tabLabel} round-trips q + category`,
      );
      await page.getByText(`Fixture ${category}`, { exact: true }).waitFor();
    }

    const input = page.locator("[data-search-overlay-input]");

    const emptyResponse = titleResponse(page, "empty", "anime");
    await input.fill("empty");
    await emptyResponse;
    await page.locator("[data-results-empty]").waitFor();
    expect(true, `${viewport.name}: empty state renders`);

    const loadingResponse = titleResponse(page, "loading", "anime");
    await input.fill("loading");
    await page.locator("[data-title-card-skeleton]").first().waitFor();
    expect(true, `${viewport.name}: loading state renders`);
    await loadingResponse;
    await page.getByText("loading anime", { exact: true }).waitFor();

    const rateResponse = titleResponse(page, "rate", "anime");
    await input.fill("rate");
    await rateResponse;
    await page.locator("[data-search-error]").waitFor();
    expect(
      ((await page.locator("[data-search-error]").textContent()) ?? "").includes(
        "wait a moment",
      ),
      `${viewport.name}: rate-limit error is actionable`,
    );
    const retryResponse = titleResponse(page, "rate", "anime");
    await page.getByRole("button", { name: "Try search again" }).click();
    await retryResponse;
    await page.getByText("Recovered title", { exact: true }).waitFor();
    expect(true, `${viewport.name}: retry recovers title results`);

    const serverResponse = titleResponse(page, "server", "anime");
    await input.fill("server");
    await serverResponse;
    await page
      .locator("[data-search-error]")
      .getByText(/title services did not answer/i)
      .waitFor();
    expect(true, `${viewport.name}: server error state renders`);

    const navigationResponse = titleResponse(page, "Navigate", "anime");
    await input.fill("Navigate");
    await navigationResponse;
    const navigationLink = page
      .locator('[data-search-overlay] [data-card-target="title"]')
      .first();
    await navigationLink.waitFor();
    await navigationLink.click();
    await page.waitForURL(/\/title\/navigate-anime/);
    expect(
      new URL(page.url()).pathname === "/title/navigate-anime",
      `${viewport.name}: title-card click navigates`,
    );

    expect(
      state.requests.length > 0 &&
        state.requests.every(
          (request) => new URL(request).pathname === "/api/search/titles",
        ),
      `${viewport.name}: normal Search never calls raw /api/search`,
    );
    await page.close();
  }
} finally {
  await browser.close();
}

console.log("[deterministic:title-first] PASS");
for (const message of passes) console.log(`  ok  ${message}`);
if (failures.length) {
  console.error("[deterministic:title-first] FAIL");
  for (const message of failures) console.error(`  XX  ${message}`);
  process.exitCode = 1;
}

if (process.exitCode !== 1) {
  try {
    const response = await fetch(
      `${BASE}/api/search/titles?q=Slime&category=anime&limit=12`,
    );
    if (!response.ok) {
      console.log(
        `[live:anime-slime] UNAVAILABLE HTTP ${response.status} (non-gating provider check)`,
      );
    } else {
      const body = (await response.json()) as { results?: WorkHit[] };
      const results = Array.isArray(body.results) ? body.results : [];
      if (results.length === 0) {
        console.log(
          "[live:anime-slime] UNAVAILABLE no AniList results (non-gating provider check)",
        );
      } else {
        const canonical = results.some((hit) =>
          hit.title.includes("That Time I Got Reincarnated as a Slime"),
        );
        const titleOnly = results.every(
          (hit) =>
            hit.category === "anime" &&
            hit.provider === "anilist" &&
            hit.href.startsWith("/title/") &&
            !RAW_FIELDS.some((field) => field in hit),
        );
        if (!canonical || !titleOnly) {
          console.error(
            `[live:anime-slime] FAIL canonical=${canonical} titleOnly=${titleOnly}`,
          );
          process.exitCode = 1;
        } else {
          console.log(
            `[live:anime-slime] PASS ${results.length} work titles; canonical identified; no raw release fields`,
          );
        }
      }
    }
  } catch (error) {
    console.log(
      `[live:anime-slime] UNAVAILABLE ${
        error instanceof Error ? error.message : String(error)
      } (non-gating provider check)`,
    );
  }
}

console.log(`wrote ${OUT} and ${screenshotPath(VIEWPORTS[0])}`);
