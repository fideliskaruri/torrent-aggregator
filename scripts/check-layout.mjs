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
    // Content an ancestor deliberately clips is not overflow the user can see.
    // A Radix progress indicator, for example, is a full-width bar translated
    // left by (100 - value)% inside an `overflow: hidden` track: its rect
    // legitimately starts at a negative x on every partial download, and
    // reporting it as a layout bug is a false positive that trains you to
    // ignore this probe.
    const isClipped = (el) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (s.overflowX !== "visible" || s.overflow === "clip") return true;
      }
      return false;
    };
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const style = getComputedStyle(el);
      if (style.position === "fixed") continue;
      // Only report the outermost offender; a wide child inside a wide parent
      // is the same bug reported twice.
      if (r.right > vw + 1 || r.left < -1) {
        if (bad.some((b) => b.el.contains(el))) continue;
        if (isClipped(el)) continue;
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

/**
 * The mobile tab bar is `position: fixed`, so it floats over the document and
 * costs no layout height. Nothing below it is scrollable into view — the page
 * has to *reserve* that height itself (`app-main` does, via
 * `--mobile-nav-h + --safe-bottom`).
 *
 * If that reservation is ever dropped, shortened, or overridden by a route,
 * the failure is invisible everywhere except the very bottom of the page on a
 * phone: the last row of content sits permanently under the bar and cannot be
 * tapped. No other probe here sees it — overflow is horizontal, and a
 * full-page screenshot renders fixed elements at the viewport origin, so the
 * bar appears to float mid-page and looks fine.
 *
 * So: scroll to the true bottom and assert that no interactive element's box
 * intrudes into the bar's box.
 */
async function contentUnderMobileNav(page) {
  return page.evaluate(async () => {
    const nav = document.querySelector("[data-mobile-nav]");
    if (!nav) return null; // Desktop widths: the bar is display:none.
    window.scrollTo(0, document.documentElement.scrollHeight);
    await new Promise((r) => setTimeout(r, 350));

    const bar = nav.getBoundingClientRect();
    if (bar.height === 0) return null;

    const describe = (el) =>
      `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}` +
      `${el.className && typeof el.className === "string" ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}` : ""}` +
      `("${(el.textContent ?? "").trim().slice(0, 32)}")`;

    const problems = [];

    /*
      Primary, and the only assertion here that is actually sensitive.

      An occlusion check ("is anything interactive sitting under the bar?")
      sounds like the right test and is nearly useless: whether a control
      happens to land in the bar's band depends entirely on how tall the
      seeded content is. On a sparse page the last elements are
      non-interactive filler that stops short of the bar, so the check passes
      just as happily with the reservation deleted. Verified by deleting it.

      What is actually invariant is the reservation: the document must be
      taller than its own content by at least the bar's height, so the last
      pixel of content can be scrolled clear of it. That holds regardless of
      what the content is, and it fails the instant the padding goes.
    */
    const main = document.querySelector(".app-main");
    if (main) {
      const scrollY = window.scrollY;
      let contentBottom = 0;
      for (const el of main.querySelectorAll("*")) {
        const s = getComputedStyle(el);
        if (s.position === "fixed" || s.display === "none" || s.visibility === "hidden")
          continue;
        const r = el.getBoundingClientRect();
        if (r.height === 0) continue;
        contentBottom = Math.max(contentBottom, r.bottom + scrollY);
      }
      const docH = document.documentElement.scrollHeight;
      const slack = Math.round(docH - contentBottom);
      if (slack < Math.round(bar.height) - 2) {
        problems.push(
          `the page reserves only ${slack}px below its last content but the ` +
            `fixed bar is ${Math.round(bar.height)}px tall, so that much of ` +
            `the page can never be scrolled out from under it`,
        );
      }
    }

    // Secondary: a control actually sitting under the bar right now. Weaker
    // (see above) but when it does fire it names the offending element.
    for (const el of document.querySelectorAll(
      "a, button, input, select, textarea, [role='tab']",
    )) {
      if (nav.contains(el)) continue;
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden" || s.position === "fixed")
        continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.bottom > bar.top + 2 && r.top < bar.bottom - 2) {
        problems.push(`${describe(el)} is under the bar`);
      }
    }
    return problems;
  });
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

      const occluded = await contentUnderMobileNav(page);
      if (occluded === null) {
        // No mobile bar at this width — nothing to assert.
      } else if (occluded.length) {
        fail(
          `${route} @${width} content is stranded under the fixed mobile nav ` +
            `at the bottom of the page: ${occluded.slice(0, 4).join(" | ")}`,
        );
      } else {
        ok(`${route} @${width} nothing stranded under the mobile nav`);
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
