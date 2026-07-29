/**
 * Measures the vertical dead space on a title page, and where the error/status
 * copy sits relative to the control that produced it.
 *
 * The owner's complaint was two things at once, and they are easy to conflate:
 *   1. "no error messages here"  -> a failed action reports nothing near the button
 *   2. "that gap is also soo big" -> a tall empty band under the action row
 *   3. "why can't the add to library button be placed somewhere else"
 *
 * Counting pixels is the only way to know whether a fix moved anything. This
 * walks the hero, finds the action row, and reports the largest vertical gap
 * between consecutive rendered blocks — plus the distance from each action
 * button to the nearest status/error text, which is what "no error messages
 * here" actually means: the message may exist, but not next to the button.
 *
 * Usage: node scripts/probes/title-gap.mjs [baseUrl] [slug]
 */
import { chromium } from "playwright";

const BASE = process.argv[2] || "http://127.0.0.1:3000";
const SLUG = process.argv[3] || "family-guy";
const VIEWPORTS = [
  { name: "mobile", width: 390, height: 844 },
  { name: "desktop", width: 1440, height: 900 },
];

function measure() {
  const out = { gaps: [], actions: [], viewportWidth: window.innerWidth };

  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") return false;
    if (Number(cs.opacity) === 0) return false;
    return true;
  };

  // The hero is whatever contains the primary Play/Resume control.
  const buttons = Array.from(document.querySelectorAll("button, a[href]")).filter(isVisible);
  const primary = buttons.find((b) => /^(play|resume|watch)\b/i.test((b.textContent || "").trim()));
  if (!primary) {
    out.error = "no primary Play/Resume control found";
    return out;
  }

  // Gap measurement, done without guessing at a "hero" container.
  //
  // An ancestor walk is not stable here: on mobile every ancestor is either the
  // button's own 36px row or the whole 12,000px document, so any threshold
  // picks one or the other and the resulting "gaps" measure nothing real.
  // Instead measure the thing the owner actually pointed at — the empty band
  // directly BELOW a given control, in absolute page coordinates, which is
  // viewport-independent and needs no heuristic.
  const allBlocks = Array.from(document.querySelectorAll("body *"))
    .filter(isVisible)
    .filter((el) => {
      // leaf-ish: no visible block-level child of its own
      return !Array.from(el.children).some((c) => {
        if (!isVisible(c)) return false;
        return getComputedStyle(c).display !== "inline";
      });
    })
    .map((el) => {
      const r = el.getBoundingClientRect();
      return {
        el,
        top: r.top + window.scrollY,
        bottom: r.bottom + window.scrollY,
        left: r.left,
        right: r.right,
        text: (el.textContent || "").trim().slice(0, 50),
        tag: el.tagName.toLowerCase(),
      };
    });

  const gapBelow = (el) => {
    const r = el.getBoundingClientRect();
    const myBottom = r.bottom + window.scrollY;
    const myLeft = r.left;
    const myRight = r.right;
    let nearest = null;
    for (const b of allBlocks) {
      if (b.el === el || el.contains(b.el) || b.el.contains(el)) continue;
      if (b.top < myBottom - 1) continue;
      // must overlap horizontally, otherwise it is a different column
      if (b.right <= myLeft || b.left >= myRight) continue;
      if (!nearest || b.top < nearest.top) nearest = b;
    }
    if (!nearest) return { gap: null, next: "(nothing below in this column)" };
    return { gap: Math.round(nearest.top - myBottom), next: nearest.text || `<${nearest.tag}>` };
  };
  out.gapBelowPrimary = gapBelow(primary);

  // Where does "Add to library" / "In library" sit, and how far is it from the
  // primary action? A control that belongs elsewhere usually shows up as a long
  // horizontal or vertical hop from the thing it is grouped with.
  const pr = primary.getBoundingClientRect();
  out.primary = {
    text: (primary.textContent || "").trim().slice(0, 40),
    x: Math.round(pr.left),
    y: Math.round(pr.top),
    w: Math.round(pr.width),
    h: Math.round(pr.height),
  };
  for (const b of buttons) {
    const t = (b.textContent || "").trim();
    if (!/library|watchlist/i.test(t)) continue;
    const r = b.getBoundingClientRect();
    out.actions.push({
      text: t.slice(0, 40),
      x: Math.round(r.left),
      y: Math.round(r.top + window.scrollY),
      w: Math.round(r.width),
      h: Math.round(r.height),
      sameRowAsPrimary: Math.abs(r.top - pr.top) < 8,
      dyFromPrimary: Math.round(r.top - pr.top),
      below: gapBelow(b),
    });
  }

  // Status / error copy anywhere on the page, and how far it sits from the
  // nearest button. "No error messages here" is usually "the message rendered
  // 600px away from the control", not "nothing rendered".
  const statusNodes = Array.from(
    document.querySelectorAll('[role="alert"], [role="status"], [data-error], .text-destructive, [data-status-message]'),
  ).filter(isVisible);
  out.statuses = statusNodes.slice(0, 8).map((n) => {
    const r = n.getBoundingClientRect();
    let nearest = Infinity;
    for (const b of buttons) {
      const br = b.getBoundingClientRect();
      const d = Math.hypot(r.left - br.left, r.top - br.top);
      if (d < nearest) nearest = d;
    }
    return {
      text: (n.textContent || "").trim().slice(0, 60),
      y: Math.round(r.top),
      nearestButtonPx: Math.round(nearest),
    };
  });

  return out;
}

const browser = await chromium.launch();
try {
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/title/${SLUG}`, { waitUntil: "networkidle", timeout: 45_000 });
    await page.waitForTimeout(1200);
    const r = await page.evaluate(measure);
    console.log(`\n=== ${vp.name} ${vp.width}x${vp.height} — /title/${SLUG} ===`);
    if (r.error) {
      console.log(`  ! ${r.error}`);
    } else {
      console.log(`  primary: "${r.primary.text}" at (${r.primary.x},${r.primary.y}) ${r.primary.w}x${r.primary.h}`);
      console.log(
        `  empty band directly BELOW primary: ${r.gapBelowPrimary.gap ?? "n/a"}px  -> next: "${r.gapBelowPrimary.next}"`,
      );
      console.log(`  library control:`);
      if (!r.actions.length) console.log(`    (none found)`);
      for (const a of r.actions) {
        console.log(
          `    "${a.text}" at (${a.x},${a.y}) ${a.w}x${a.h} — sameRowAsPrimary=${a.sameRowAsPrimary} dy=${a.dyFromPrimary}px`,
        );
        console.log(`      empty band below it: ${a.below.gap ?? "n/a"}px -> next: "${a.below.next}"`);
      }
      console.log(`  status/error nodes: ${r.statuses.length}`);
      for (const s of r.statuses) {
        console.log(`    y=${s.y} nearestButton=${s.nearestButtonPx}px  "${s.text}"`);
      }
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}
