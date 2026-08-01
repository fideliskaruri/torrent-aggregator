import fs from "node:fs";
import path from "node:path";
import { chromium, type Page, type Route } from "playwright";

const base = process.env.BASE ?? "http://127.0.0.1:3111";
const distDir = process.env.NEXT_DIST_DIR ?? ".next";
const outDir = path.join("qa-shots", "title-first-search");
const widths = [320, 375, 768, 1280, 1920] as const;
fs.mkdirSync(outDir, { recursive: true });

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function waitForResults(page: Page) {
  await page
    .locator("[data-results-list], [data-results-empty], [data-search-error]")
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });
}

function mockHit(title: string, category: string) {
  const isSeries = category !== "movies";
  const mediaType =
    category === "movies" ? "movie" : category === "series" ? "tv" : "anime";
  const workKey = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return {
    workKey,
    title,
    year: 2026,
    category,
    provider: category === "anime" ? "anilist" : "tmdb",
    mediaType,
    isSeries,
    format: category === "anime" ? "TV" : null,
    posterUrl: null,
    overview: `${title} overview`,
    releaseDate: "2026-01-01",
    href: `/title/${workKey}?t=${encodeURIComponent(title)}&type=${mediaType}`,
  };
}

async function mockedTitles(route: Route) {
  const url = new URL(route.request().url());
  const query = url.searchParams.get("q") ?? "";
  const category = url.searchParams.get("category") ?? "movies";
  if (query === "rate") {
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
  if (query === "slow") await new Promise((resolve) => setTimeout(resolve, 1_200));
  const results =
    query === "empty" ? [] : [mockHit(query === "fresh" ? "Fresh title" : `${query} ${category}`, category)];
  await route
    .fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ query, category, results }),
    })
    .catch(() => undefined);
}

const browser = await chromium.launch({ headless: true });
const evidence: {
  buildId: string;
  responsive: unknown[];
  interactions: Record<string, unknown>;
  states: Record<string, unknown>;
  redirects: Record<string, unknown>;
} = {
  buildId: fs.readFileSync(path.join(distDir, "BUILD_ID"), "utf8").trim(),
  responsive: [],
  interactions: {},
  states: {},
  redirects: {},
};

try {
  for (const width of widths) {
    const page = await browser.newPage({
      viewport: {
        width,
        height: width <= 375 ? 760 : width === 1280 ? 800 : 900,
      },
      deviceScaleFactor: 1,
    });
    const requests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/search")) requests.push(request.url());
    });
    await page.goto(`${base}/search?category=anime&q=Slime`, {
      waitUntil: "domcontentloaded",
    });
    await page.locator("[data-search-overlay]").waitFor();
    await waitForResults(page);

    const dom = await page.locator("[data-search-overlay]").evaluate((overlay) => {
      const text = (overlay.textContent ?? "").replace(/\s+/g, " ").trim();
      const tabs = [...overlay.querySelectorAll('[role="tab"]')].map((tab) =>
        tab.textContent?.trim(),
      );
      const links = [...overlay.querySelectorAll<HTMLAnchorElement>("[data-title-card]")];
      return {
        tabs,
        titleCards: overlay.querySelectorAll("[data-title-card]").length,
        titleLinksOnly: links.every((link) => link.href.includes("/title/")),
        artifactRows: overlay.querySelectorAll("[data-artifact-row]").length,
        actions: overlay.querySelectorAll(
          '[data-action="play"], [data-action="download"]',
        ).length,
        forbiddenControls: [
          "Games",
          "Music",
          "Software",
          "Books",
          "All categories",
        ].filter((label) => tabs.includes(label)),
        rawFacts: /\b(?:seeders?|leechers?|provider|indexer|infohash)\b/i.test(text),
        canonicalFound: text.includes("That Time I Got Reincarnated as a Slime"),
        overflow: document.documentElement.scrollWidth > window.innerWidth,
        url: location.href,
      };
    });
    assert(
      JSON.stringify(dom.tabs) === JSON.stringify(["Movies", "Series", "Anime"]),
      `${width}: wrong category tabs ${JSON.stringify(dom.tabs)}`,
    );
    assert(dom.titleCards > 0, `${width}: no anime title cards`);
    assert(dom.titleLinksOnly, `${width}: a result is not a title link`);
    assert(dom.artifactRows === 0, `${width}: raw artifact rows rendered`);
    assert(dom.actions === 0, `${width}: Play/Download rendered in discovery`);
    assert(dom.forbiddenControls.length === 0, `${width}: legacy controls rendered`);
    assert(!dom.rawFacts, `${width}: raw provider/swarm facts rendered`);
    assert(dom.canonicalFound, `${width}: canonical Slime title was not identified`);
    assert(!dom.overflow, `${width}: horizontal overflow`);
    assert(
      requests.every((request) => request.includes("/api/search/titles?")),
      `${width}: normal search called the raw aggregator`,
    );
    await page.screenshot({
      path: path.join(outDir, `after-anime-slime-${width}.png`),
      fullPage: false,
    });
    evidence.responsive.push({ width, requests, dom });
    await page.close();
  }

  const interactionPage = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
  });
  await interactionPage.route("**/api/search/titles**", mockedTitles);
  await interactionPage.goto(base, { waitUntil: "domcontentloaded" });
  const trigger = interactionPage.locator("[data-search-trigger]:visible").first();
  await trigger.focus();
  await trigger.click();
  const input = interactionPage.locator("[data-search-overlay-input]");
  await input.waitFor();
  const focusedOnOpen = await input.evaluate((element) => element === document.activeElement);
  const rootsLocked = await interactionPage.evaluate(
    () =>
      document.documentElement.style.overflow === "hidden" &&
      document.body.style.overflow === "hidden",
  );

  const movies = interactionPage.getByRole("tab", { name: "Movies" });
  await movies.focus();
  await movies.press("ArrowRight");
  const categoryAfterArrow = await interactionPage
    .getByRole("tab", { selected: true })
    .textContent();
  const categoryFocus = await interactionPage.evaluate(
    () => document.activeElement?.textContent?.trim() ?? null,
  );

  await input.fill("Proof");
  await interactionPage
    .locator('[data-search-overlay] [data-card-target="title"]')
    .waitFor();
  const result = interactionPage
    .locator('[data-search-overlay] [data-card-target="title"]')
    .first();
  await result.focus();
  await interactionPage.keyboard.press("Tab");
  const tabWrapped = await input.evaluate((element) => element === document.activeElement);
  await input.press("Shift+Tab");
  const shiftTabWrapped = await result.evaluate(
    (element) => element === document.activeElement,
  );
  await interactionPage.keyboard.press("Escape");
  await interactionPage.locator("[data-search-overlay]").waitFor({ state: "detached" });
  await interactionPage.waitForTimeout(50);
  const focusRestored = await trigger.evaluate((element) => element === document.activeElement);
  const rootsRestored = await interactionPage.evaluate(
    () =>
      document.documentElement.style.overflow !== "hidden" &&
      document.body.style.overflow !== "hidden",
  );

  await trigger.click();
  await input.fill("Enter proof");
  await interactionPage
    .locator('[data-search-overlay] [data-card-target="title"]')
    .waitFor();
  await input.press("Enter");
  await interactionPage.waitForURL(/\/title\/enter-proof-movies/);
  evidence.interactions = {
    focusedOnOpen,
    rootsLocked,
    categoryAfterArrow,
    categoryFocus,
    tabWrapped,
    shiftTabWrapped,
    focusRestored,
    rootsRestored,
    enterResultUrl: interactionPage.url(),
  };
  for (const [name, value] of Object.entries(evidence.interactions)) {
    assert(value, `interaction failed: ${name}`);
  }
  await interactionPage.close();

  const statePage = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
  });
  await statePage.route("**/api/search/titles**", mockedTitles);
  await statePage.goto(`${base}/search?category=movies`, {
    waitUntil: "domcontentloaded",
  });
  await statePage.locator("[data-search-overlay]").waitFor();
  const stateInput = statePage.locator("[data-search-overlay-input]");
  const prompt = await statePage
    .locator("#search-results-region")
    .getByText("Find a movie by title.")
    .isVisible();
  await stateInput.fill("s");
  const shortQuery = await statePage
    .locator("#search-results-region")
    .getByText("Find a movie by title.")
    .isVisible();
  await stateInput.fill("slow");
  await statePage.locator("[data-title-card-skeleton]").first().waitFor();
  const loading = true;
  await stateInput.fill("fresh");
  await statePage.getByText("Fresh title", { exact: true }).waitFor();
  await statePage.waitForTimeout(1_300);
  const staleSuppressed =
    (await statePage.getByText("slow movies", { exact: true }).count()) === 0;
  await stateInput.fill("empty");
  await statePage.locator("[data-results-empty]").waitFor();
  const empty = true;
  await stateInput.fill("rate");
  await statePage.locator("[data-search-error]").getByText(/wait a moment/i).waitFor();
  const rateLimited = true;
  await statePage.getByRole("button", { name: "Try search again" }).click();
  await statePage.locator("[data-search-error]").waitFor();
  const retry = true;
  await stateInput.fill("server");
  await statePage
    .locator("[data-search-error]")
    .getByText(/title services did not answer/i)
    .waitFor();
  const serverError = true;
  evidence.states = {
    prompt,
    shortQuery,
    loading,
    staleSuppressed,
    empty,
    rateLimited,
    retry,
    serverError,
  };
  for (const [name, value] of Object.entries(evidence.states)) {
    assert(value, `state failed: ${name}`);
  }
  await statePage.close();

  const animeRedirect = await fetch(`${base}/everything?scope=anime&q=x`, {
    redirect: "manual",
  });
  const unsupportedRedirect = await fetch(`${base}/everything?scope=music&q=x`, {
    redirect: "manual",
  });
  evidence.redirects = {
    anime: animeRedirect.headers.get("location"),
    unsupported: unsupportedRedirect.headers.get("location"),
  };
  assert(
    evidence.redirects.anime === "/search?category=anime&q=x",
    `unexpected anime redirect ${evidence.redirects.anime}`,
  );
  assert(
    evidence.redirects.unsupported === "/search?q=x",
    `unexpected unsupported redirect ${evidence.redirects.unsupported}`,
  );
} finally {
  await browser.close();
}

fs.writeFileSync(
  path.join(outDir, "after-browser-evidence.json"),
  JSON.stringify(evidence, null, 2),
);
console.log(JSON.stringify(evidence, null, 2));
