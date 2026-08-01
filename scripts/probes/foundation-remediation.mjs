import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE ?? "http://127.0.0.1:3108";
const OUT = path.resolve("qa-screens/foundation-after");
const WIDTHS = [320, 375, 390, 768, 1280, 1920];
const ROUTES = ["/activity", "/history", "/watchlist", "/client", "/rules"];
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const failures = [];
const checks = [];

for (const width of WIDTHS) {
  const context = await browser.newContext({
    viewport: { width, height: width < 768 ? 844 : 1000 },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => failures.push(`${width}: page error: ${error.message}`));

  for (const route of ROUTES) {
    await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(900);
    const result = await page.evaluate(() => ({
      overflow:
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
      rulesLink: [...document.querySelectorAll("a")].some(
        (a) => a.getAttribute("href") === "/rules" && a.offsetParent !== null,
      ),
      skip: Boolean(document.querySelector('a[href="#main-content"]')),
    }));
    checks.push({ width, route, ...result });
    if (result.overflow > 1) failures.push(`${width} ${route}: ${result.overflow}px overflow`);
    if (!result.skip) failures.push(`${width} ${route}: no skip link`);
    if (width >= 768 && !result.rulesLink) failures.push(`${width} ${route}: Rules hidden`);
    await page.screenshot({
      path: path.join(OUT, `${width}-${route.slice(1)}.png`),
      fullPage: true,
    });
  }

  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  const trigger = page.locator("[data-search-trigger]:visible").first();
  await trigger.focus();
  await trigger.click();
  await page.locator("[data-search-overlay]").waitFor();
  await page.locator("[data-search-overlay-input]").fill("dune");
  await page.waitForTimeout(350);
  const modal = await page.evaluate(() => ({
    path: location.pathname,
    query: new URLSearchParams(location.search).get("q"),
    htmlOverflow: document.documentElement.style.overflow,
    bodyOverflow: document.body.style.overflow,
  }));
  if (modal.path !== "/search" || modal.query !== "dune")
    failures.push(`${width}: search URL not durable: ${JSON.stringify(modal)}`);
  if (modal.htmlOverflow !== "hidden" || modal.bodyOverflow !== "hidden")
    failures.push(`${width}: search did not lock both scroll roots`);
  await page.screenshot({
    path: path.join(OUT, `${width}-search-overlay.png`),
    fullPage: false,
  });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  if (!(await trigger.evaluate((element) => element === document.activeElement)))
    failures.push(`${width}: search did not restore opener focus`);

  await page.goto(`${BASE}/search?q=one%20piece`, {
    waitUntil: "domcontentloaded",
  });
  await page.locator("[data-search-overlay]").waitFor();
  if (new URL(page.url()).searchParams.get("q") !== "one piece")
    failures.push(`${width}: shared search query was erased`);

  await context.close();
}

const interactionContext = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 1,
});
const interactionPage = await interactionContext.newPage();
let searchAttempts = 0;
await interactionPage.route("**/api/search/titles?*", async (route) => {
  searchAttempts += 1;
  await route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ error: "Indexer test outage" }),
  });
});
await interactionPage.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
const searchTrigger = interactionPage.locator("[data-search-trigger]:visible").first();
await searchTrigger.click();
const searchInput = interactionPage.locator("[data-search-overlay-input]");
await searchInput.fill("failure");
const retry = interactionPage.getByRole("button", { name: "Try search again" });
await retry.waitFor();
if ((await interactionPage.locator("[data-search-error]").getAttribute("role")) !== "alert")
  failures.push("search failure is not announced as an alert");
await retry.click();
await retry.waitFor();
if (searchAttempts < 2) failures.push("search retry did not issue another request");
const modalPanel = interactionPage.locator(
  "[data-search-overlay] > div.relative",
);
const modalFocusables = modalPanel.locator(
  'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
);
const firstModalControl = modalFocusables.first();
const lastModalControl = modalFocusables.last();
await lastModalControl.focus();
await interactionPage.keyboard.press("Tab");
if (!(await firstModalControl.evaluate((element) => element === document.activeElement)))
  failures.push("search focus did not wrap from last to first");
await firstModalControl.focus();
await interactionPage.keyboard.press("Shift+Tab");
if (!(await lastModalControl.evaluate((element) => element === document.activeElement)))
  failures.push("search focus did not wrap from first to last");
await interactionPage.keyboard.press("Escape");

await interactionPage.unroute("**/api/search/titles?*");
await interactionPage.route("**/api/client/torrents", async (route) => {
  if (route.request().method() !== "GET") return route.continue();
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      clientType: "builtin",
      torrents: [
        {
          hash: "probe-hash",
          name: "Foundation Probe S01E01 1080p WEB-DL.mkv",
          progress: 0.5,
          sizeBytes: 1_000_000,
          dlspeed: 1_000,
          upspeed: 0,
          state: "downloading",
          category: "tv",
          retentionState: "kept",
        },
      ],
    }),
  });
});
await interactionPage.goto(`${BASE}/client`, { waitUntil: "domcontentloaded" });
const clientRow = interactionPage.locator("[data-client-torrent]");
await clientRow.waitFor();
await clientRow.focus();
await interactionPage.keyboard.press("Enter");
if ((await clientRow.getAttribute("aria-pressed")) !== "true")
  failures.push("Client row Enter did not select the row");
if (!(await clientRow.getByRole("progressbar", { name: /download progress/i }).count()))
  failures.push("Client progress has no accessible name");

await interactionPage.unroute("**/api/client/torrents");
await interactionPage.route("**/api/watchlist", async (route) => {
  if (route.request().method() !== "GET") return route.continue();
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      items: [
        {
          id: "probe-library",
          mediaType: "tv",
          externalId: "probe",
          title: "Foundation Probe",
          status: "watching",
          monitored: true,
          updatedAt: new Date().toISOString(),
        },
      ],
    }),
  });
});
await interactionPage.goto(`${BASE}/watchlist`, { waitUntil: "domcontentloaded" });
await interactionPage.getByRole("button", { name: "Run automation" }).click();
if (!(await interactionPage.locator("[data-automation-review]").count()))
  failures.push("Library automation has no consequence review step");
await interactionPage.getByRole("button", { name: "Review library" }).click();

await interactionContext.close();
await browser.close();
console.log(JSON.stringify({ checks, screenshots: OUT, failures }, null, 2));
if (failures.length) process.exit(1);
