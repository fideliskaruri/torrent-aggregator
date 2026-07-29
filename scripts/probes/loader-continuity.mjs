// Measure loader continuity from click to playback, body-scoped.
// Counts every loader node anywhere in the document, tracks node identity and
// animation restarts, and samples every animation frame.
//
//   node scripts/probes/loader-continuity.mjs [baseUrl] [titleSlug]

import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:3000";
const SLUG = process.argv[3] ?? "dune";

const INSTALL = `(() => {
  const LOADER = '[data-player-loader], [data-stream-loading], .animate-spin';
  const state = { samples: [], nodes: [], animStarts: [], t0: performance.now() };
  window.__loaderProbe = state;

  const ident = (el) => {
    let i = state.nodes.findIndex((n) => n.el === el);
    if (i === -1) {
      const cls = (el.getAttribute('class') || '').split(/\\s+/).slice(0, 3).join('.');
      const owner = el.closest('[data-play-overlay]') ? 'overlay'
        : el.closest('[data-inline-player]') ? 'player'
        : el.closest('button') ? 'button:' + ((el.closest('button').textContent || '').trim().slice(0, 18) || '?')
        : 'other';
      state.nodes.push({ el, id: state.nodes.length, tag: el.tagName.toLowerCase(), cls, owner,
                         firstSeen: Math.round(performance.now() - state.t0), lastSeen: null });
      i = state.nodes.length - 1;
    }
    return i;
  };

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };

  document.addEventListener('animationstart', (e) => {
    const el = e.target;
    if (el instanceof Element && el.matches(LOADER)) {
      state.animStarts.push({ t: Math.round(performance.now() - state.t0), node: ident(el), name: e.animationName });
    }
  }, true);

  const tick = () => {
    const t = Math.round(performance.now() - state.t0);
    const live = Array.from(document.querySelectorAll(LOADER)).filter(visible);
    const ids = live.map((el) => { const i = ident(el); state.nodes[i].lastSeen = t; return i; });
    state.samples.push({ t, count: live.length, ids });
    if (state.samples.length < 6000) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return true;
})()`;

const REPORT = `(() => {
  const s = window.__loaderProbe;
  if (!s) return { error: 'probe not installed' };
  const nonZero = s.samples.filter((x) => x.count > 0);
  const peak = s.samples.reduce((m, x) => Math.max(m, x.count), 0);
  const first = nonZero[0]?.t ?? null;
  const last = nonZero[nonZero.length - 1]?.t ?? null;
  // A gap = a sample with 0 loaders between the first and last visible loader.
  let gaps = 0, gapMs = 0;
  if (first !== null) {
    let prev = null;
    for (const x of s.samples) {
      if (x.t < first || x.t > last) continue;
      if (x.count === 0) { gaps++; if (prev !== null) gapMs += x.t - prev; }
      prev = x.t;
    }
  }
  return {
    peak, first, last, gaps, gapMs,
    samples: s.samples.length,
    uniqueNodes: s.nodes.length,
    nodes: s.nodes.map((n) => ({ id: n.id, tag: n.tag, cls: n.cls, owner: n.owner, firstSeen: n.firstSeen, lastSeen: n.lastSeen })),
    animStarts: s.animStarts,
  };
})()`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

await page.goto(`${BASE}/title/${SLUG}`, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(3500);

await page.evaluate(INSTALL);

const btn = page.locator('button:has-text("Resume"), button:has-text("Play")').first();
const label = (await btn.textContent().catch(() => "?"))?.trim();
console.log(`pressing: "${label}"`);
await btn.click({ timeout: 15000 });

await page.waitForTimeout(20000);

const r = await page.evaluate(REPORT);

/*
 * The continuity numbers alone are gameable, and a duck caught it: a single
 * spinner that never goes away and never resolves into a video satisfies
 * "one node, one animationstart, no gaps" perfectly. That is a worse product
 * than the bug being fixed. So the verdict also has to establish that the
 * loader was a loader - it appeared promptly after the press, playback actually
 * began, and the loader then went away.
 */
const outcome = await page.evaluate(() => {
  const vids = Array.from(document.querySelectorAll("video"));
  const playing = vids.find((v) => v.readyState >= 3 || v.currentTime > 0);
  const anyLoaderNow = Array.from(document.querySelectorAll("[data-player-loader], .animate-spin")).some((el) => {
    const rect = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && cs.visibility !== "hidden" && Number(cs.opacity) !== 0;
  });
  return {
    videos: vids.length,
    started: Boolean(playing),
    readyState: playing?.readyState ?? (vids[0]?.readyState ?? null),
    currentTime: playing?.currentTime ?? (vids[0]?.currentTime ?? null),
    loaderStillOnScreen: anyLoaderNow,
  };
});

await page.screenshot({ path: "loader-continuity.png" });
await browser.close();

console.log(`\n=== LOADER CONTINUITY: /title/${SLUG} ===`);
console.log(`samples            ${r.samples} (per animation frame)`);
console.log(`peak concurrent    ${r.peak}`);
console.log(`unique nodes       ${r.uniqueNodes}   <-- must be 1`);
console.log(`animationstarts    ${r.animStarts.length}   <-- must be 1`);
console.log(`first visible      ${r.first} ms   <-- must be prompt after the press`);
console.log(`last visible       ${r.last} ms`);
console.log(`gap samples        ${r.gaps} (${r.gapMs} ms with NO loader between first and last)`);
console.log(`\noutcome after 20s:`);
console.log(`  <video> elements   ${outcome.videos}`);
console.log(`  playback started   ${outcome.started}  (readyState ${outcome.readyState}, currentTime ${outcome.currentTime})`);
console.log(`  loader still up    ${outcome.loaderStillOnScreen}   <-- must be false`);
console.log(`\nnodes that held the loader:`);
for (const n of r.nodes ?? []) console.log(`  #${n.id} ${n.owner.padEnd(22)} ${n.tag}.${n.cls}  seen ${n.firstSeen}->${n.lastSeen} ms`);
console.log(`\nanimation starts:`);
for (const a of r.animStarts ?? []) console.log(`  t=${a.t}ms node#${a.node} "${a.name}"`);

// Continuity: one node, one spin, never interrupted, and it did exist.
const continuous = r.uniqueNodes === 1 && r.animStarts.length <= 1 && r.peak <= 1 && r.gaps === 0 && r.peak >= 1;
// Promptness: the press must be acknowledged immediately. A loader that only
// appears 800ms later leaves a dead period where the user pressed and nothing
// happened - which is the same complaint from the other end.
const prompt = r.first !== null && r.first <= 400;
// Resolution: it has to have been loading something, and then stopped.
const resolved = outcome.started && !outcome.loaderStillOnScreen;

const ok = continuous && prompt && resolved;
console.log(
  `\nVERDICT: ${ok ? "PASS - one continuous loader, promptly shown, resolved into playback" : "FAIL"}`,
);
if (!ok) {
  if (!continuous) console.log(`  - not one continuous node (nodes ${r.uniqueNodes}, animstarts ${r.animStarts.length}, peak ${r.peak}, gaps ${r.gaps})`);
  if (!prompt) console.log(`  - loader did not appear promptly after the press (first visible ${r.first} ms, budget 400)`);
  if (!outcome.started) console.log(`  - playback never started: a spinner that never resolves is not a pass`);
  if (outcome.loaderStillOnScreen) console.log(`  - loader is STILL on screen after 20s`);
}
process.exit(ok ? 0 : 1);
