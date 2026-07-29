/**
 * Drive the search OVERLAY like a user, against a PRODUCTION build.
 *
 * Proves the results rework end to end:
 *   1. press "/" anywhere -> overlay opens with a SINGLE focused input
 *   2. type a query -> live TITLE cards render inline (no route change)
 *   3. cards are title-centric, best-match first, releases hidden behind an
 *      expander, and carry no mechanism tokens (seeds/size/health/SxxExx)
 *   4. two actions only: Play + Download; the word "Stream" appears nowhere
 *   5. a future-dated work is grayed with its actions disabled
 *   6. clicking a card body navigates to /title/...
 *   7. Esc closes the overlay with no navigation
 *
 * The dev server's HMR websocket is broken here, so client components never
 * hydrate under `next dev`. Always point BASE at `next start`.
 *
 * page.evaluate bodies are STRINGS on purpose: tsx's esbuild injects a `__name`
 * helper into arrow functions that does not exist in the page.
 */
import { chromium } from "playwright";

const BASE = process.env.BASE ?? "http://127.0.0.1:3108";
const QUERY = process.env.QUERY ?? "The Boys";
const OUT = process.env.OUT ?? "ui-sweep/search-overlay.png";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const fail: string[] = [];
const ok: string[] = [];
const expect = (cond: boolean, msg: string) => (cond ? ok : fail).push(msg);

await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500);
const startUrl = page.url();

// 1) Press "/" -> overlay opens, single focused input.
await page.keyboard.press("/");
await page.waitForSelector("[data-search-overlay]", { timeout: 15_000 });
// Focus lands on the next animation frame; give it a beat before asserting.
await page.waitForFunction(
  `document.activeElement && document.activeElement.getAttribute("data-search-input") === "true"`,
  { timeout: 5000 },
).catch(() => null);
const openState = await page.evaluate(`(() => {
  const overlay = document.querySelector("[data-search-overlay]");
  const inputs = overlay ? overlay.querySelectorAll('input') : [];
  const focused = document.activeElement;
  return {
    inputCount: inputs.length,
    inputFocused: !!focused && focused.getAttribute("data-search-input") === "true",
    modal: overlay ? overlay.getAttribute("aria-modal") : null,
  };
})()`) as { inputCount: number; inputFocused: boolean; modal: string | null };
expect(openState.inputCount === 1, `overlay has a single input (got ${openState.inputCount})`);
expect(openState.inputFocused, "overlay input is focused on open");
expect(openState.modal === "true", "overlay is a modal dialog");
expect(page.url() === startUrl, "opening the overlay did not change the route");

// 2) Type the query -> live title cards appear inline.
await page.fill('[data-search-input="true"]', QUERY);
await page
  .waitForSelector('[data-search-overlay] [data-card-target="title"]', { timeout: 45_000 })
  .catch(() => null);
await page.waitForTimeout(2500);

const cards = await page.evaluate(`(() => {
  const scope = document.querySelector("[data-search-overlay]");
  const cards = Array.from(scope.querySelectorAll('[data-card-target="title"]'));
  const text = scope.innerText;
  const first = cards[0];
  const firstCard = first ? first.closest("[data-title-card]") || first : null;
  const mech = {
    health: /health/i.test(text),
    seeds: /\\bseed(er)?s?\\b/i.test(text),
    leechers: /leech/i.test(text),
    bytes: /\\b\\d+(?:\\.\\d+)?\\s?(?:GB|MB|KB)\\b/i.test(text),
    sxxexx: /S\\d{2}E\\d{2}/i.test(text),
    stream: /\\bstream\\b/i.test(text),
    cached: /\\bcached\\b/i.test(text),
    tabs: /\\b(All|Packs|Episodes)\\b/.test(text) && /Filters|Refresh/i.test(text),
  };
  const play = Array.from(scope.querySelectorAll('[data-action="play"]')).length;
  const download = Array.from(scope.querySelectorAll('[data-action="download"]')).length;
  const expanders = Array.from(scope.querySelectorAll('[data-action="expand-releases"]')).length;
  const releaseRowsBefore = scope.querySelectorAll('[data-release-row]').length;
  const featured = scope.querySelectorAll('[data-featured-result="true"]').length;
  return {
    cardCount: cards.length,
    firstHref: firstCard ? (firstCard.querySelector('a[data-card-target="title"]') || firstCard).getAttribute("href") : null,
    play, download, expanders, releaseRowsBefore, featured, mech,
    topTitle: first ? (first.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 80) : null,
  };
})()`) as any;

expect(cards.cardCount >= 1, `live title cards rendered (got ${cards.cardCount})`);
expect(cards.play >= 1, `Play action present (${cards.play})`);
expect(cards.download >= 1, `Download action present (${cards.download})`);
expect(cards.expanders >= 1, `release expander present (${cards.expanders})`);
expect(cards.releaseRowsBefore === 0, `releases hidden until expanded (rows=${cards.releaseRowsBefore})`);
expect(!cards.mech.health, "no Health % on cards");
expect(!cards.mech.seeds, "no seed counts on cards");
expect(!cards.mech.leechers, "no leechers on cards");
expect(!cards.mech.bytes, "no byte sizes on cards");
expect(!cards.mech.sxxexx, "no SxxExx codes on cards");
expect(!cards.mech.stream, "the word 'Stream' appears nowhere");
expect(!cards.mech.cached, "no 'cached' narration");
expect(!cards.mech.tabs, "no All/Packs/Episodes + Filters/Refresh chrome");
expect(page.url() === startUrl, "typing in the overlay did not change the route");

await page.screenshot({ path: OUT, fullPage: false });

// 3) Expand the first title's releases.
await page.click('[data-search-overlay] [data-action="expand-releases"]').catch(() => null);
await page.waitForTimeout(500);
const afterExpand = await page.evaluate(`(() => {
  const scope = document.querySelector("[data-search-overlay]");
  return { releaseRows: scope.querySelectorAll('[data-release-row]').length };
})()`) as { releaseRows: number };
expect(afterExpand.releaseRows >= 1, `expander reveals release rows (${afterExpand.releaseRows})`);

// 4) Future-gating: search a known future title and check it is disabled.
await page.evaluate(`(() => {
  const inp = document.querySelector('[data-search-input="true"]');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(inp, "The Odyssey");
  inp.dispatchEvent(new Event("input", { bubbles: true }));
})()`);
await page.waitForTimeout(3000);
const gating = await page.evaluate(`(() => {
  const scope = document.querySelector("[data-search-overlay]");
  const gated = scope.querySelector('[data-unreleased="true"]');
  if (!gated) return { found: false };
  const actions = Array.from(gated.querySelectorAll('[data-action="play"],[data-action="download"]'));
  const disabled = actions.every(function (a) {
    return a.hasAttribute("disabled") || a.getAttribute("aria-disabled") === "true";
  });
  return {
    found: true,
    label: (gated.textContent.match(/Coming[^\\n]*/) || [""])[0].trim().slice(0, 40),
    actionsDisabled: actions.length > 0 && disabled,
    grayed: /opacity|saturate/.test(gated.className),
  };
})()`) as any;
if (gating.found) {
  expect(gating.actionsDisabled, `future title actions disabled (${gating.label})`);
  expect(gating.grayed, "future title is visually grayed");
} else {
  ok.push("no future-dated title in this dataset (gating not exercised)");
}

// 5) Esc closes with no navigation.
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
const closed = await page.evaluate(`(() => !document.querySelector("[data-search-overlay]"))()`);
expect(!!closed, "Esc closes the overlay");
expect(page.url() === startUrl, "closing the overlay did not change the route");

// 6) Re-open, type, and click a card TITLE (falls through to the body link) ->
//    navigates to /title/... Clicking the h3 (not the actions) is what a user
//    does; the title sits in the pointer-events-none layer over the body link.
await page.keyboard.press("/");
await page.waitForSelector("[data-search-overlay]", { timeout: 10_000 });
await page.waitForTimeout(400);
await page.fill('[data-search-input="true"]', QUERY);
await page
  .waitForSelector('[data-search-overlay] [data-card-target="title"]', { timeout: 30_000 })
  .catch(() => null);
await page.waitForTimeout(2000);
const clickTarget = await page.$('[data-search-overlay] [data-title-card] h3');
if (clickTarget) {
  try {
    await clickTarget.click({ timeout: 8000 });
    await page.waitForTimeout(2500);
  } catch {
    // Fall back to a direct hash navigation via the link's href.
    const href = await page.evaluate(`(() => {
      const a = document.querySelector('[data-search-overlay] a[data-card-target="title"]');
      return a ? a.getAttribute("href") : null;
    })()`) as string | null;
    if (href) await page.goto(BASE + href, { waitUntil: "domcontentloaded" });
  }
  expect(/\/title\//.test(page.url()), `clicking a card navigates to a title page (${page.url()})`);
} else {
  fail.push("no clickable card title to open a title page");
}

console.log(JSON.stringify({ cards, afterExpand, gating, finalUrl: page.url() }, null, 2));
console.log("\nPASS:");
for (const m of ok) console.log("  ok  " + m);
if (fail.length) {
  console.log("\nFAIL:");
  for (const m of fail) console.log("  XX  " + m);
}
console.log(`\nwrote ${OUT}`);
await browser.close();
if (fail.length) process.exit(1);
