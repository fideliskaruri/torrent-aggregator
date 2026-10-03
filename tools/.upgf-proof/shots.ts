import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";

const require = createRequire("D:/code/memtest/english-rule/shooter/");
const { chromium } = require("playwright-core");
const [, , name, path] = process.argv;
const base = "http://127.0.0.1:3967";
const out = "D:/code/memtest/wt-upgf/tools/.upgf-proof";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const dom: Record<string, unknown> = {};
for (const width of [390, 768, 1280]) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto(base + path, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const target = page.locator("[data-title-episodes]");
  if (await target.count()) await target.first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${out}/${name}-${width}.png`, fullPage: width !== 1280 ? false : true });
  dom[width] = await page.evaluate(() => {
    const box = (el: Element) => Math.round(el.getBoundingClientRect().height);
    return {
      inLibraryPill: document.querySelectorAll("[data-in-library]").length,
      remove: [...document.querySelectorAll("[data-remove-from-library]")].map(box),
      ownedText: [...document.querySelectorAll("[data-owned-text]")].map((e) => e.textContent),
      ownedState: [...document.querySelectorAll("[data-owned-quality]")].map((e) => e.getAttribute("data-owned-quality")),
      queued: [...document.querySelectorAll("[data-owned-queued]")].map((e) => ({ text: e.textContent, h: box(e) })),
      upgradeButtons: [...document.querySelectorAll("[data-owned-upgrade],[data-season-upgrade]")].map((e) => ({ text: e.textContent, h: box(e) })),
      checkButtons: [...document.querySelectorAll("[data-owned-check]")].map(box),
      seasonLine: document.querySelector("[data-season-progress]")?.textContent ?? null,
      episodeBadges: [...document.querySelectorAll("[data-episode-owned]")].map((e) => e.getAttribute("title")),
      buttons: [...document.querySelectorAll("[data-title-owned] button")].map((e) => e.textContent),
    };
  });
  await page.close();
}
writeFileSync(`${out}/${name}.dom.json`, JSON.stringify(dom, null, 2));
await browser.close();
