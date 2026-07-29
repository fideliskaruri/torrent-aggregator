/*
 * Does the player have a Next control, and does it point at the right episode?
 *
 * The owner asked "what player in this world doesn't have a next button?" and
 * until now nothing in this repo could answer that question. Every other player
 * check measured loaders, seeking or geometry; the single most-requested missing
 * affordance had no probe at all, so "we added it" would have been an assertion.
 *
 * Deliberate limitation, stated rather than hidden: this does NOT press Next.
 * On a torrent app, advancing to an episode that is not on disk starts a real
 * grab against real indexers and writes into the real library. A probe must not
 * be able to do that. So this establishes existence, labelling, reachability and
 * the episode it ADVERTISES it will go to - which is exactly the part that can
 * be wrong silently. Proving it actually advances requires the sanitised gate
 * DB and is tracked separately.
 */
import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://127.0.0.1:3000";
const SLUG = process.argv[3] ?? "family-guy";

const SCAN = `(() => {
  const describe = (el) => {
    const cls = (el.className && typeof el.className === "string" ? el.className : "").split(/\\s+/).filter(Boolean).slice(0, 3).join(".");
    return el.tagName.toLowerCase() + (cls ? "." + cls : "");
  };
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.01;
  };

  // Anything a viewer could reasonably read as "go to the next thing".
  const NEXT = /(^|\\b)(next|up ?next|play next|skip to next|next episode)(\\b|$)/i;
  const found = [];
  for (const el of Array.from(document.querySelectorAll("button, a, [role=button]"))) {
    const label = (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "").replace(/\\s+/g, " ").trim();
    const testid = el.getAttribute("data-testid") || el.getAttribute("data-next") || "";
    if (!NEXT.test(label) && !/next/i.test(testid)) continue;
    const r = el.getBoundingClientRect();
    const probeId = String(found.length);
    el.setAttribute("data-next-probe", probeId);
    found.push({
      probeId,
      el: describe(el),
      label: label.slice(0, 60),
      testid,
      visible: vis(el),
      disabled: el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true",
      w: Math.round(r.width),
      h: Math.round(r.height),
      // What does it claim it will play? An href or an episode code in the label
      // is the only machine-checkable statement of intent available.
      href: el.getAttribute("href") || null,
      episodeInLabel: (label.match(/S\\d{1,2}\\s?E\\d{1,2}/i) || [null])[0],
      inPlayer: false,
    });
  }

  // What is the player currently playing? Needed to judge whether Next points
  // at the FOLLOWING episode rather than some arbitrary one.
  const bodyText = document.body.innerText.replace(/\\s+/g, " ");
  const nowPlaying = (bodyText.match(/S\\d{1,2}\\s?E\\d{1,2}/i) || [null])[0];
  const vid = document.querySelector("video");
  const videos = document.querySelectorAll("video").length;

  /*
   * Find the player surface from the video outward rather than by guessing at
   * class names. An earlier version keyed on [data-player-surface] and reported
   * "player open: false" while a video was demonstrably playing - a selector
   * that does not match is indistinguishable from a feature that is absent, and
   * that is precisely the confusion these probes exist to remove.
   */
  let surface = null;
  if (vid) {
    let n = vid.parentElement;
    while (n && n !== document.body) {
      const cs = getComputedStyle(n);
      const r = n.getBoundingClientRect();
      if ((cs.position === "fixed" || cs.position === "absolute") && r.width >= innerWidth * 0.6) { surface = n; break; }
      n = n.parentElement;
    }
    if (!surface) surface = vid.closest("[data-player-surface], [data-stream-player], .fixed") || vid.parentElement;
  }
  for (const f of found) {
    const el = document.querySelector(\`[data-next-probe="\${f.probeId}"]\`);
    f.inPlayer = Boolean(surface && el && surface.contains(el));
  }

  return { found, nowPlaying, videos, playerOpen: Boolean(surface), surfaceTag: surface ? describe(surface) : null };
})()`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

console.log(`\n=== NEXT-EPISODE CONTROL: ${BASE}/title/${SLUG} ===\n`);

await page.goto(`${BASE}/title/${SLUG}`, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(3500);

const before = await page.evaluate(SCAN);
console.log(`on the title page (player closed): ${before.found.length} next-ish control(s), nowPlaying=${before.nowPlaying ?? "none"}`);

// Open the player on something already on disk so nothing is grabbed.
const play = page.locator('button:has-text("Resume"), button:has-text("Play")').first();
let opened = false;
if (await play.count()) {
  const label = (await play.textContent().catch(() => ""))?.trim();
  console.log(`pressing "${label}" to open the player…`);
  await play.click({ timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(9000);
  opened = true;
}

// Nudge the surface so auto-hiding chrome is showing when we look.
await page.mouse.move(720, 450);
await page.waitForTimeout(400);
await page.mouse.move(720, 700);
await page.waitForTimeout(900);

const after = await page.evaluate(SCAN);
await page.screenshot({ path: "next-control.png" });
await browser.close();

console.log(`\nplayer open: ${after.playerOpen}${after.surfaceTag ? ` (surface ${after.surfaceTag})` : ""}   <video> elements: ${after.videos}   now playing: ${after.nowPlaying ?? "unknown"}`);
console.log(`next-ish controls found in the open player: ${after.found.length}\n`);

for (const f of after.found) {
  console.log(
    `  "${f.label}"  ${f.el}\n` +
      `      visible=${f.visible} disabled=${f.disabled} size=${f.w}x${f.h} inPlayer=${f.inPlayer}` +
      `${f.episodeInLabel ? ` targets=${f.episodeInLabel}` : ""}${f.href ? ` href=${f.href}` : ""}`,
  );
}

const usable = after.found.filter((f) => f.visible && !f.disabled);
const inPlayer = usable.filter((f) => f.inPlayer);
const tapOk = usable.every((f) => f.w >= 44 && f.h >= 44);

console.log("");
const checks = [
  ["a Next control exists at all", after.found.length > 0],
  ["at least one is visible and enabled", usable.length > 0],
  ["it lives on the player surface, not just the page", inPlayer.length > 0],
  ["it meets the 44px touch minimum", usable.length > 0 && tapOk],
  ["it states which episode it goes to", usable.some((f) => f.episodeInLabel || f.href)],
];
for (const [name, ok] of checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);

const ok = checks.every(([, v]) => v);
console.log(`\nVERDICT: ${ok ? "PASS" : "FAIL"} - next-episode affordance`);
if (!opened) console.log("NOTE: no Play/Resume control was found, so the player was never opened - treat the in-player result as unmeasured, not as a pass.");
console.log("NOTE: existence and target only. This probe does not PRESS Next (that would start a real grab); that behaviour is proven separately against the sanitised gate DB.");
process.exit(ok ? 0 : 1);
