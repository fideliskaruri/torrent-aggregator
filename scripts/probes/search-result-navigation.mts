import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const base = process.env.BASE ?? "http://127.0.0.1:3108";
const outputDir = path.join("qa-screens", "search-result-navigation");
const viewports = [
  { name: "mobile-375", width: 375, height: 844 },
  { name: "tablet-768", width: 768, height: 900 },
  { name: "desktop-1440", width: 1440, height: 900 },
] as const;

fs.mkdirSync(outputDir, { recursive: true });

const browser = await chromium.launch();
const results: Array<{
  viewport: string;
  beforeClick: string;
  afterClick: string;
  overlayClosed: boolean;
  rootsLocked: boolean;
  focusTrapped: boolean;
  rootsRestored: boolean;
}> = [];

try {
  for (const viewport of viewports) {
    const page = await browser.newPage({ viewport });
    await page.route("**/api/search/titles**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          results: [
            {
              workKey: "search-navigation-proof",
              title: "Search Navigation Proof",
              year: 2026,
              mediaType: "movie",
              href: "/title/search-navigation-proof?title=Search+Navigation+Proof&year=2026&mediaType=movie",
            },
          ],
        }),
      }),
    );

    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1_000);
    await page.keyboard.press("/");
    const input = page.locator('[data-search-input="true"]');
    await input.waitFor({ state: "visible" });
    const rootsLocked = await page.evaluate(
      () =>
        document.documentElement.style.overflow === "hidden" &&
        document.body.style.overflow === "hidden",
    );
    if (!rootsLocked) throw new Error("the modal did not lock both scroll roots");

    await page.evaluate(() => {
      const outside = document.querySelector<HTMLElement>(
        "body a, body button",
      );
      outside?.focus();
    });
    await page.keyboard.press("Tab");
    const focusTrapped = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
      return !!dialog?.contains(document.activeElement);
    });
    if (!focusTrapped) throw new Error("focus escaped the Search modal");

    await input.fill("Search Navigation Proof");

    const title = page.locator("[data-search-overlay] [data-title-card] h3");
    await title.waitFor({ state: "visible" });
    await page.screenshot({
      path: path.join(outputDir, `${viewport.name}-overlay.png`),
      fullPage: false,
    });
    const beforeClick = new URL(page.url()).pathname;
    if (beforeClick !== "/search") {
      throw new Error(`expected durable /search URL before click, got ${beforeClick}`);
    }

    await title.click();
    await page.waitForURL(/\/title\/search-navigation-proof/, {
      timeout: 15_000,
    });
    await page.locator("[data-search-overlay]").waitFor({
      state: "detached",
      timeout: 5_000,
    });

    const afterClick = new URL(page.url()).pathname;
    const overlayClosed =
      (await page.locator("[data-search-overlay]").count()) === 0;
    const rootsRestored = await page.evaluate(
      () =>
        document.documentElement.style.overflow !== "hidden" &&
        document.body.style.overflow !== "hidden",
    );
    if (!rootsRestored) throw new Error("scroll roots stayed locked after navigation");
    results.push({
      viewport: viewport.name,
      beforeClick,
      afterClick,
      overlayClosed,
      rootsLocked,
      focusTrapped,
      rootsRestored,
    });
    await page.screenshot({
      path: path.join(outputDir, `${viewport.name}-title.png`),
      fullPage: false,
    });
    await page.close();
  }
} finally {
  await browser.close();
}

console.log(JSON.stringify(results, null, 2));
