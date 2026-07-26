/**
 * Layout regression probe: horizontal overflow and sticky positioning.
 *
 * Both of these are invisible to `tsc`, `eslint` and `next build`, and both are
 * things the app previously got wrong in a way that survived for months:
 *
 *  - `overflow-x: hidden` was set on four ancestors, which HID horizontal
 *    overflow rather than fixing it — and, because a non-`visible` value on one
 *    axis forces the other to `auto` (CSS Overflow 3), silently turned
 *    `.app-main` into a scroll container so every `position: sticky` descendant
 *    stuck to something that never scrolled.
 *  - So a screenshot looked fine while the header didn't stick and content was
 *    quietly clipped off the right edge.
 *
 * This measures both directly. Run against an already-running server:
 *   node scripts/check-layout.mjs
 *   node scripts/check-layout.mjs --base http://127.0.0.1:3000
 */
import { chromium } from "playwright";

const baseArg = process.argv.indexOf("--base");
const BASE =
  (baseArg > -1 ? process.argv[baseArg + 1] : null) ||
  process.env.PLAYWRIGHT_BASE_URL ||
  "http://127.0.0.1:3000";

const ROUTES = ["/", "/search", "/watchlist", "/client", "/history", "/rules", "/settings"];
const WIDTHS = [375, 768, 1440];

const failures = [];
function fail(msg) {
  failures.push(msg);
  console.error(`FAIL  ${msg}`);
}
function ok(msg) {
  console.log(`  ok  ${msg}`);
}

/**
 * Elements wider than the viewport. Reported with enough identity to fix:
 * a bare "the page overflows by 40px" is not actionable.
 */
async function overflowingElements(page, width) {
  return page.evaluate((vw) => {
    const bad = [];
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const style = getComputedStyle(el);
      if (style.position === "fixed") continue;
      // Only report the outermost offender; a wide child inside a wide parent
      // is the same bug reported twice.
      if (r.right > vw + 1 || r.left < -1) {
        if (bad.some((b) => b.el.contains(el))) continue;
        bad.push({
          el,
          desc:
            el.tagName.toLowerCase() +
            (el.id ? `#${el.id}` : "") +
            (typeof el.className === "string" && el.className
              ? `.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}`
              : ""),
          left: Math.round(r.left),
          right: Math.round(r.right),
        });
      }
    }
    return bad.map(({ desc, left, right }) => ({ desc, left, right }));
  }, width);
}

/**
 * A sticky element is only meaningful if its nearest scrollable ancestor is the
 * viewport (or something that actually scrolls). This finds sticky elements
 * whose scroll parent cannot scroll — the exact failure the four `overflow-x`
 * declarations caused.
 */
async function brokenStickies(page) {
  return page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll("body *")) {
      if (getComputedStyle(el).position !== "sticky") continue;
      const desc =
        el.tagName.toLowerCase() +
        (typeof el.className === "string" && el.className
          ? `.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}`
          : "");

      let p = el.parentElement;
      let scrollParent = null;
      while (p && p !== document.documentElement) {
        const s = getComputedStyle(p);
        if (/(auto|scroll|hidden)/.test(s.overflowY + s.overflowX)) {
          scrollParent = p;
          break;
        }
        p = p.parentElement;
      }
      if (!scrollParent) continue; // viewport is the scroll parent — correct

      const canScroll = scrollParent.scrollHeight > scrollParent.clientHeight + 1;
      if (!canScroll) {
        out.push({
          desc,
          parent:
            scrollParent.tagName.toLowerCase() +
            (typeof scrollParent.className === "string" && scrollParent.className
              ? `.${scrollParent.className.trim().split(/\s+/).slice(0, 3).join(".")}`
              : ""),
        });
      }
    }
    return out;
  });
}

/** Does the sticky header actually stay put when the page is scrolled? */
async function stickyHoldsOnScroll(page) {
  const header = page.locator(".app-header").first();
  if ((await header.count()) === 0) return null;
  const before = await header.boundingBox();
  await page.evaluate(() => window.scrollBy(0, 600));
  await page.waitForTimeout(250);
  const after = await header.boundingBox();
  if (!before || !after) return null;
  return Math.abs(after.y - before.y) < 2;
}

const browser = await chromium.launch();
try {
  for (const width of WIDTHS) {
    console.log(`\n=== ${width}px ===`);
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await ctx.newPage();

    for (const route of ROUTES) {
      try {
        await page.goto(`${BASE}${route}`, {
          waitUntil: "domcontentloaded",
          timeout: 45_000,
        });
        await page.waitForTimeout(1200);
      } catch (err) {
        fail(`${route} @${width} did not load: ${err.message}`);
        continue;
      }

      const docOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      const offenders = await overflowingElements(page, width);
      if (offenders.length) {
        fail(
          `${route} @${width} horizontal overflow (doc +${docOverflow}px): ` +
            offenders
              .slice(0, 4)
              .map((o) => `${o.desc} [${o.left}..${o.right}]`)
              .join(" | "),
        );
      } else {
        ok(`${route} @${width} no horizontal overflow`);
      }

      const broken = await brokenStickies(page);
      if (broken.length) {
        fail(
          `${route} @${width} sticky inside a non-scrolling parent: ` +
            broken.map((b) => `${b.desc} -> ${b.parent}`).join(" | "),
        );
      } else {
        ok(`${route} @${width} sticky elements resolve against a real scroller`);
      }

      const held = await stickyHoldsOnScroll(page);
      if (held === false) {
        fail(`${route} @${width} .app-header moved when the page scrolled`);
      } else if (held === true) {
        ok(`${route} @${width} .app-header stayed put on scroll`);
      }
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}

console.log(
  failures.length === 0
    ? "\ncheck-layout: all routes clean"
    : `\ncheck-layout: ${failures.length} FAILED`,
);
process.exit(failures.length === 0 ? 0 : 1);
