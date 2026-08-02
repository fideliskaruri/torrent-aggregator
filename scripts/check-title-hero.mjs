/**
 * Does the title hero size itself from its content, or from the screen?
 *
 * The defect: the hero carried `grow` and `min-h: clamp(360px, 56vh, 560px)`,
 * so it claimed a share of the viewport regardless of what was in it. The same
 * title, holding the same words, rendered a 404px hero on a 720p laptop and a
 * 561px hero on a 1080p desktop — 157px of extra empty band bought purely by
 * having a taller screen, pushing the first useful section down with it.
 *
 * The first version of this script asserted "the hero is at most 72% of the
 * viewport". That passed on the broken code (52%) and on the fixed code (36%)
 * alike, which makes it decoration rather than a gate. The rule below is the
 * one that actually separates them: a hero measuring the same content must be
 * the same height on every screen. Height that tracks the viewport is the bug.
 */
import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE ?? "http://127.0.0.1:3000";

/** Same width, different heights: only the viewport height varies. */
const HEIGHT_PAIR = [
  { width: 1280, height: 720, label: "720p" },
  { width: 1280, height: 1080, label: "1080p" },
];

/**
 * How much the hero may differ between those two viewports.
 *
 * Not zero: fonts reflow and a long title can wrap differently. But 157px of
 * drift — the measured gap before the fix — is not reflow, it is proportional
 * sizing.
 */
const MAX_HEIGHT_DRIFT_PX = 24;

/** Layout sanity at the widths the product supports. */
const VIEWPORTS = [
  { width: 1280, height: 720, label: "laptop 1280x720" },
  { width: 1920, height: 1080, label: "desktop 1920x1080" },
  { width: 768, height: 1024, label: "tablet 768x1024" },
  { width: 375, height: 667, label: "mobile 375x667" },
];

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();

async function measure(href, vp) {
  await page.setViewportSize({ width: vp.width, height: vp.height });
  await page.goto(`${BASE}${href}`, {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });
  await page.waitForSelector("[data-title-hero]", { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(800);
  return page.evaluate(() => {
    const hero = document.querySelector("[data-title-hero]");
    if (!hero) return null;
    const rect = hero.getBoundingClientRect();
    let nextTop = null;
    for (let el = hero.nextElementSibling; el; el = el.nextElementSibling) {
      const r = el.getBoundingClientRect();
      if (r.height > 40) {
        nextTop = r.top;
        break;
      }
    }
    return {
      heroHeight: Math.round(rect.height),
      nextTop: nextTop == null ? null : Math.round(nextTop),
      viewport: window.innerHeight,
      overflowX: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
}

await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 45_000 });
const hrefs = await page.$$eval('a[href^="/title/"]', (as) =>
  [...new Set(as.map((a) => a.getAttribute("href")).filter(Boolean))],
);
if (!hrefs.length) {
  console.error("No title links on Browse — cannot probe.");
  await browser.close();
  process.exit(1);
}

let failures = 0;

for (const href of hrefs.slice(0, 4)) {
  // The rule that matters: content-sized, not viewport-sized.
  const short = await measure(href, HEIGHT_PAIR[0]);
  const tall = await measure(href, HEIGHT_PAIR[1]);
  if (!short || !tall) {
    failures++;
    console.log(`FAIL  ${href}  no hero element`);
    continue;
  }
  const drift = Math.abs(tall.heroHeight - short.heroHeight);
  if (drift > MAX_HEIGHT_DRIFT_PX) {
    failures++;
    console.log(
      `FAIL  ${href.slice(0, 52)}\n        hero grew ${drift}px with the screen ` +
        `(${short.heroHeight}px at 720p, ${tall.heroHeight}px at 1080p)`,
    );
  } else {
    console.log(
      `ok    ${href.slice(0, 52)}  content-sized: ${short.heroHeight}px / ${tall.heroHeight}px (drift ${drift}px)`,
    );
  }

  // Layout sanity, same as before.
  for (const vp of VIEWPORTS) {
    const m = await measure(href, vp);
    if (!m) continue;
    const problems = [];
    if (vp.width >= 768 && m.nextTop != null && m.nextTop >= m.viewport) {
      problems.push(
        `next section starts at ${m.nextTop}px, below the ${m.viewport}px fold`,
      );
    }
    if (m.overflowX) problems.push("horizontal overflow");
    if (problems.length) {
      failures++;
      console.log(`FAIL  ${vp.label.padEnd(20)} ${href.slice(0, 46)}`);
      for (const p of problems) console.log(`        ${p}`);
    }
  }
}

console.log(
  failures === 0
    ? `\nHERO OK — content-sized on every title checked`
    : `\n${failures} hero check(s) failed`,
);

await browser.close();
process.exit(failures === 0 ? 0 : 1);

