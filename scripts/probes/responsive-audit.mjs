// Objective responsiveness audit against a running server.
// Measures what the user actually complained about: horizontal overflow,
// squeezed text columns, and touch targets below 44x44.
//
//   node scripts/probes/responsive-audit.mjs [baseUrl]

import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:3000";

const ROUTES = [
  "/",
  "/title/family-guy",
  "/title/dune",
  "/title/rick-and-morty",
  "/search?q=family%20guy",
  "/client",
  "/activity",
  "/watchlist",
  "/settings",
  "/rules",
];

const VIEWPORTS = [
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
];

const AUDIT = `(() => {
  const vw = document.documentElement.clientWidth;
  const docOverflow = Math.max(0, document.documentElement.scrollWidth - vw);

  const describe = (el) => {
    const cls = (el.getAttribute("class") || "").split(/\\s+/).slice(0, 4).join(".");
    const id = el.id ? "#" + el.id : "";
    const txt = (el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 40);
    return el.tagName.toLowerCase() + id + (cls ? "." + cls : "") + (txt ? ' "' + txt + '"' : "");
  };

  // An element inside ANY horizontally-scrollable/clipping ancestor is not a page-level
  // overflow bug -- carousels and tab strips are supposed to extend past the viewport.
  const insideScroller = (el) => {
    let n = el;
    while (n && n !== document.body) {
      const ox = getComputedStyle(n).overflowX;
      if (ox === "auto" || ox === "scroll" || ox === "hidden") return true;
      n = n.parentElement;
    }
    return false;
  };

  // sr-only / visually-hidden text is 1px by design.
  const visuallyHidden = (el) => {
    const s = getComputedStyle(el);
    if (s.clipPath && s.clipPath !== "none") return true;
    if (s.clip && s.clip !== "auto") return true;
    const r = el.getBoundingClientRect();
    return r.width <= 2 || r.height <= 2;
  };

  const wide = [];
  const tiny = [];
  const exempt = [];
  const squeezed = [];
  for (const el of Array.from(document.querySelectorAll("body *"))) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") continue;
    if (visuallyHidden(el)) continue;

    if (r.right > vw + 1 && r.width > 8 && !insideScroller(el)) {
      wide.push({ el: describe(el), right: Math.round(r.right), width: Math.round(r.width) });
    }

    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role");
    const interactive =
      tag === "button" || tag === "a" || tag === "select" || tag === "input" ||
      role === "button" || role === "tab" || role === "link" || role === "switch";
    if (interactive && !el.hasAttribute("disabled")) {
      if (el.closest("[data-dense-ui]")) {
        // A reviewed exemption, but it must never be a silent one: an agent can
        // zero this metric by painting data-dense-ui on a container. Count them
        // so the escape hatch is always visible in the report.
        if (r.width < 44 || r.height < 44) exempt.push({ el: describe(el), w: Math.round(r.width), h: Math.round(r.height) });
      } else if (r.width < 44 || r.height < 44) {
        tiny.push({ el: describe(el), w: Math.round(r.width), h: Math.round(r.height) });
      }
    }

    const direct = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim().length > 12);
    if (direct && r.width < 70) squeezed.push({ el: describe(el), w: Math.round(r.width) });
  }

  const loaders = document.querySelectorAll("[data-player-loader], [data-stream-loading], .animate-spin").length;

  return { vw, docOverflow, wide: wide.slice(0, 10), tiny: tiny.slice(0, 10), squeezed: squeezed.slice(0, 10),
           wideCount: wide.length, tinyCount: tiny.length, squeezedCount: squeezed.length,
           exemptCount: exempt.length, loaders };
})()`;

const browser = await chromium.launch();
const rows = [];
let failures = 0;

for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  for (const route of ROUTES) {
    let result;
    try {
      await page.goto(BASE + route, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(2500);
      result = await page.evaluate(AUDIT);
    } catch (err) {
      rows.push({ vp: vp.name, route, error: err.message.split("\n")[0] });
      failures++;
      continue;
    }
    rows.push({ vp: vp.name, route, ...result });
    /*
     * Tap targets under 44x44 are a CRITICAL-priority failure on touch
     * viewports, not a note. They were previously printed but excluded from the
     * exit code, which meant the gate reported 85 unreachable controls on mobile
     * "/" and still exited 0. A number nobody is required to act on is decoration.
     */
    const touchViewport = vp.name !== "desktop";
    if (
      result.docOverflow > 1 ||
      result.wideCount > 0 ||
      result.squeezedCount > 0 ||
      (touchViewport && result.tinyCount > 0)
    ) failures++;
  }
  await ctx.close();
}

await browser.close();

console.log("\n=== RESPONSIVE AUDIT: " + BASE + " ===\n");
console.log("viewport  route                      overflow  wide  tiny-tap  squeezed  exempt  loaders");
console.log("-".repeat(92));
for (const r of rows) {
  if (r.error) {
    console.log(`${r.vp.padEnd(9)} ${r.route.padEnd(26)} ERROR ${r.error}`);
    continue;
  }
  console.log(
    `${r.vp.padEnd(9)} ${r.route.padEnd(26)} ${String(r.docOverflow).padStart(8)}  ${String(r.wideCount).padStart(4)}  ${String(r.tinyCount).padStart(8)}  ${String(r.squeezedCount).padStart(8)}  ${String(r.exemptCount ?? 0).padStart(6)}  ${String(r.loaders).padStart(7)}`,
  );
}

console.log("\n--- offenders ---");
for (const r of rows) {
  if (r.error) continue;
  if (!r.wideCount && !r.squeezedCount && !r.tinyCount) continue;
  console.log(`\n[${r.vp}] ${r.route}`);
  for (const w of r.wide) console.log(`   OVERFLOWS x by ${w.right - r.vw}px  ${w.el}`);
  for (const s of r.squeezed) console.log(`   TEXT ${s.w}px wide       ${s.el}`);
  if (r.vp !== "desktop") for (const t of r.tiny) console.log(`   TAP ${t.w}x${t.h}          ${t.el}`);
}

console.log(`\nVERDICT: ${failures === 0 ? "PASS" : failures + " route/viewport combos with layout defects"}`);
process.exit(failures === 0 ? 0 : 1);
