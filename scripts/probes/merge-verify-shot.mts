/**
 * Post-merge verification against a PRODUCTION build on :3000.
 *
 * Checks the three user-visible promises made by today's merges:
 *   1. /search  — every result card offers BOTH a Stream and a Download button.
 *   2. /settings — the retention panel actually renders (it was dead code).
 *   3. /library, /activity, /rules — no full-page spinner; skeletons reserve space.
 *
 * The dev server's HMR websocket is broken here, so client components never
 * hydrate and every client page freezes on its loading state. Point this at
 * `next start` only.
 *
 * page.evaluate bodies are STRINGS on purpose: tsx's esbuild injects a `__name`
 * helper into arrow functions that does not exist in the page.
 */
import { chromium } from "playwright";

const BASE = process.env.BASE ?? "http://127.0.0.1:3000";
const OUT_DIR = process.env.OUT_DIR ?? "ui-sweep";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

async function shot(name: string) {
  await page.screenshot({ path: `${OUT_DIR}/${name}.png`, fullPage: false });
}

// ── 1. Search: the two buttons the user asked for ────────────────────────
await page.goto(`${BASE}/search?q=The+Boys`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("[data-torrent-card]", { timeout: 45_000 }).catch(() => null);
await page.waitForTimeout(4000);

const search = await page.evaluate(`(() => {
  const cards = Array.from(document.querySelectorAll("[data-torrent-card]"));
  const withStream = cards.filter(function (c) {
    return c.querySelector('[data-action="stream"]');
  }).length;
  const withDownload = cards.filter(function (c) {
    return c.querySelector('[data-action="download"]');
  }).length;
  const streamDisabled = Array.from(
    document.querySelectorAll('[data-action="stream"]'),
  ).filter(function (b) { return b.disabled; }).length;
  const text = document.body.innerText;
  return {
    cards: cards.length,
    withStream: withStream,
    withDownload: withDownload,
    streamDisabled: streamDisabled,
    helperRepeats: (text.match(/Stream plays now and can be reclaimed later/g) || []).length,
    checkingClient: (text.match(/Checking client…/g) || []).length,
    spinners: document.querySelectorAll(".animate-spin").length,
  };
})()`);
await shot("verify-search");

// ── 2. Settings: the panel that was never rendered ───────────────────────
await page.goto(`${BASE}/settings`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000);

const settings = await page.evaluate(`(() => {
  const text = document.body.innerText;
  return {
    hasFreeUpSpace: /Free up space after watching/i.test(text),
    hasKeepNew: /Keep new downloads/i.test(text),
    saysEphemeral: /EPHEMERAL/.test(text),
    hasPreviewButton: /Preview reclaimable files/i.test(text),
    hasDeleteButton: /Delete reclaimable stream-only files/i.test(text),
    spinners: document.querySelectorAll(".animate-spin").length,
  };
})()`);
await shot("verify-settings");

// ── 3. Loading states across the pages loaders rewrote ───────────────────
const loading: Record<string, unknown> = {};
for (const path of ["/library", "/activity", "/rules", "/client", "/watchlist"]) {
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  const mid = await page.evaluate(`(() => ({
    spinners: document.querySelectorAll(".animate-spin").length,
    skeletons: document.querySelectorAll("[data-skeleton], .animate-pulse").length,
  }))()`);
  await page.waitForTimeout(5000);
  const after = await page.evaluate(`(() => ({
    spinners: document.querySelectorAll(".animate-spin").length,
    skeletons: document.querySelectorAll("[data-skeleton], .animate-pulse").length,
    stuckOnLoading: /^\\s*(Loading|Loading…)\\s*$/i.test(document.body.innerText.trim()),
  }))()`);
  loading[path] = { mid, after };
  await shot(`verify-${path.replace(/\//g, "") || "home"}`);
}

console.log(JSON.stringify({ search, settings, loading }, null, 2));
await browser.close();

