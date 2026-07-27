/**
 * Screenshot + measure /search?q=The+Boys against a PRODUCTION build.
 *
 * The dev server's HMR websocket is broken in this environment, so client
 * components never hydrate and every client page freezes on its loading state.
 * Always point this at `next start`, never `next dev`.
 *
 * page.evaluate bodies are passed as STRINGS on purpose: tsx's esbuild injects
 * a `__name` helper into arrow functions, which does not exist in the page.
 */
import { chromium } from "playwright";

const BASE = process.env.BASE ?? "http://127.0.0.1:3000";
const OUT = process.env.OUT ?? "ui-sweep/search-flow.png";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const started = Date.now();
await page.goto(`${BASE}/search?q=The+Boys`, { waitUntil: "domcontentloaded" });

// Results arrive from an API call after hydration; give them a real chance.
await page
  .waitForSelector("[data-result-card]", { timeout: 45_000 })
  .catch(() => null);
await page.waitForTimeout(4000);

const stats = await page.evaluate(`(() => {
  const cards = Array.from(document.querySelectorAll("[data-result-card]"));
  const text = document.body.innerText;
  const posters = document.querySelectorAll("[data-result-card] img").length;
  const titles = cards.slice(0, 6).map(function (c) {
    const t = c.querySelector("[data-result-title]");
    return (t ? t.textContent : c.textContent || "").trim().slice(0, 90);
  });
  return {
    cardCount: cards.length,
    posters: posters,
    topTitles: titles,
    seasonChips: document.querySelectorAll("[data-season-chip]").length,
    qualityGroups: document.querySelectorAll("[data-quality-group]").length,
    disclosures: (text.match(/\\d+ more /g) || []).length,
    playButtons: Array.from(document.querySelectorAll("button, a")).filter(
      function (b) { return /^play\\b/i.test((b.textContent || "").trim()); },
    ).length,
    spinners: document.querySelectorAll(".animate-spin").length,
    firstScreen: text.slice(0, 420),
  };
})()`);

console.log(JSON.stringify(stats, null, 2));
console.log(`elapsed ${Date.now() - started} ms`);

await page.screenshot({ path: OUT, fullPage: false });
console.log(`wrote ${OUT}`);
await browser.close();
