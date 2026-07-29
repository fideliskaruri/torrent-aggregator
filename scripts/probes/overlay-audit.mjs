/*
 * Measures touch-target sizes INSIDE overlays that only mount when opened.
 *
 * Why this exists: responsive-audit.mjs walks `body *` on a freshly-loaded page.
 * Anything rendered as `open ? <Sheet/> : null` is simply not in the DOM, so the
 * audit reported the mobile nav as clean while its "More" sheet shipped a 32x32
 * close button, ~40px nav links and ~34px density toggles - on the app's primary
 * mobile navigation surface. The measurement was structurally incapable of
 * seeing the defect, which makes its green worthless rather than merely
 * incomplete. An agent found this by reading the code; no probe run could have.
 *
 * So: find the things that open, open them, and measure what appears.
 *
 * Deliberately reports triggers it could not open rather than skipping them
 * silently - an overlay this cannot reach is an overlay nobody is measuring, and
 * that is exactly the state this file exists to end.
 */
import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://127.0.0.1:3000";
const ROUTES = ["/", "/title/family-guy", "/client", "/settings", "/watchlist", "/rules", "/activity"];
const VIEWPORTS = [
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
];

const FIND_TRIGGERS = `(() => {
  const describe = (el) => {
    const cls = (el.className && typeof el.className === "string" ? el.className : "").split(/\\s+/).filter(Boolean).slice(0, 3).join(".");
    return el.tagName.toLowerCase() + (cls ? "." + cls : "") + (el.id ? "#" + el.id : "");
  };
  const out = [];
  const els = Array.from(document.querySelectorAll("button, [role=button], a[aria-haspopup], [aria-expanded]"));
  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
    const expanded = el.getAttribute("aria-expanded");
    const haspopup = el.getAttribute("aria-haspopup");
    const label = (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 28);
    // Only things that ANNOUNCE they open something. Clicking arbitrary buttons
    // on a torrent app can start downloads or delete files - the probe must not
    // be able to mutate the user's library just by auditing.
    const opens = expanded === "false" || haspopup === "menu" || haspopup === "dialog" || haspopup === "true" ||
                  /^(more|menu|options|filters?|settings)$/i.test(label);
    if (!opens) continue;
    el.setAttribute("data-overlay-probe-trigger", String(out.length));
    out.push({ idx: out.length, el: describe(el), label, expanded, haspopup });
  }
  return out;
})()`;

const MEASURE_NEW = `(() => {
  const describe = (el) => {
    const cls = (el.className && typeof el.className === "string" ? el.className : "").split(/\\s+/).filter(Boolean).slice(0, 3).join(".");
    return el.tagName.toLowerCase() + (cls ? "." + cls : "") + (el.id ? "#" + el.id : "");
  };
  const tiny = [];
  const exempt = [];
  let interactive = 0;
  for (const el of Array.from(document.querySelectorAll("body *"))) {
    // Only elements that appeared AFTER the trigger was pressed.
    if (!el.hasAttribute("data-overlay-probe-new")) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) continue;
    if (el.closest(".sr-only")) continue;
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role");
    const isInteractive =
      tag === "button" || tag === "a" || tag === "select" || tag === "input" ||
      role === "button" || role === "tab" || role === "link" || role === "switch" || role === "menuitem";
    if (!isInteractive || el.hasAttribute("disabled")) continue;
    interactive++;
    if (r.width < 44 || r.height < 44) {
      const rec = { el: describe(el), w: Math.round(r.width), h: Math.round(r.height) };
      if (el.closest("[data-dense-ui]")) exempt.push(rec); else tiny.push(rec);
    }
  }
  return { interactive, tiny: tiny.slice(0, 12), tinyCount: tiny.length, exemptCount: exempt.length };
})()`;

const MARK_BASELINE = `(() => {
  for (const el of Array.from(document.querySelectorAll("body *"))) el.setAttribute("data-overlay-probe-seen", "1");
  return true;
})()`;

const MARK_NEW = `(() => {
  let n = 0;
  for (const el of Array.from(document.querySelectorAll("body *"))) {
    if (!el.hasAttribute("data-overlay-probe-seen")) { el.setAttribute("data-overlay-probe-new", "1"); n++; }
  }
  return n;
})()`;

const browser = await chromium.launch();
const findings = [];
let opened = 0;
let unreachable = 0;

for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    hasTouch: true,
    isMobile: vp.name === "mobile",
  });
  for (const route of ROUTES) {
    const page = await ctx.newPage();
    try {
      await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(2500);
      const triggers = await page.evaluate(FIND_TRIGGERS);

      for (const t of triggers) {
        try {
          await page.evaluate(MARK_BASELINE);
          const loc = page.locator(`[data-overlay-probe-trigger="${t.idx}"]`);
          if (!(await loc.count())) continue;
          await loc.click({ timeout: 4000 });
          await page.waitForTimeout(650);
          const newNodes = await page.evaluate(MARK_NEW);
          if (newNodes === 0) {
            // Pressed something that announced it opens, and nothing mounted.
            unreachable++;
            findings.push({ vp: vp.name, route, trigger: t, nothingOpened: true });
          } else {
            opened++;
            const m = await page.evaluate(MEASURE_NEW);
            findings.push({ vp: vp.name, route, trigger: t, newNodes, ...m });
          }
          await page.keyboard.press("Escape").catch(() => {});
          await page.waitForTimeout(250);
          await page.evaluate(`(() => { for (const el of Array.from(document.querySelectorAll("[data-overlay-probe-new]"))) el.removeAttribute("data-overlay-probe-new"); })()`);
        } catch {
          unreachable++;
          findings.push({ vp: vp.name, route, trigger: t, unreachable: true });
        }
      }
    } catch (e) {
      findings.push({ vp: vp.name, route, error: String(e).slice(0, 90) });
    }
    await page.close();
  }
  await ctx.close();
}

await browser.close();

console.log(`\n=== OVERLAY TOUCH-TARGET AUDIT: ${BASE} ===`);
console.log(`overlays opened and measured: ${opened}   triggers that did not open: ${unreachable}\n`);

let failures = 0;
for (const f of findings) {
  if (f.error) { console.log(`[${f.vp}] ${f.route}  ERROR ${f.error}`); continue; }
  if (f.nothingOpened || f.unreachable) {
    console.log(`[${f.vp}] ${f.route}  NOT OPENED  "${f.trigger.label}" (${f.trigger.el}) - cannot be measured`);
    continue;
  }
  const bad = f.tinyCount > 0;
  if (bad) failures++;
  console.log(
    `[${f.vp}] ${f.route}  "${f.trigger.label}" -> ${f.newNodes} new nodes, ${f.interactive} interactive, ` +
    `${f.tinyCount} under 44px${f.exemptCount ? `, ${f.exemptCount} exempt` : ""}${bad ? "   <-- FAIL" : ""}`,
  );
  for (const t of f.tiny) console.log(`      TAP ${t.w}x${t.h}   ${t.el}`);
}

console.log(`\nVERDICT: ${failures === 0 ? "PASS - every overlay that opened has reachable controls" : `${failures} overlays contain touch targets under 44px`}`);
if (unreachable) console.log(`NOTE: ${unreachable} trigger(s) announced they open something but nothing mounted - unmeasured, and possibly broken.`);
process.exit(failures === 0 ? 0 : 1);
