/**
 * Accessibility and keyboard QA.
 *
 * Deliberately dependency-free: axe-core cannot be fetched on this network,
 * and the checks that matter most here are product-specific anyway. Each one
 * below corresponds to a defect this app has actually had or is at risk of.
 *
 *   1. **Icon-only controls need accessible names.** This UI is full of them
 *      (send, magnet, delete, refresh). A button whose entire content is an
 *      SVG announces as "button" to a screen reader, and is unusable.
 *
 *   2. **Sibling tabs must not share an accessible name.** This is the
 *      screen-reader half of the Dune bug: two different shows were both
 *      bucketed into a tab called "S01", so choosing a season could silently
 *      hand you a different programme. Visually the grouping now separates
 *      them; this asserts the *names* separate them too, per work section.
 *
 *   3. **Images need alt text.** Poster grids are the bulk of the new browse
 *      UI, and an unlabelled poster wall is pure noise.
 *
 *   4. **Keyboard focus must be visible.** The app ships custom focus styling;
 *      if a reset removes the outline without replacing it, the app becomes
 *      unnavigable by keyboard while looking perfectly fine.
 *
 *   5. **One h1 per page, and no skipped heading levels.** Heading structure
 *      is how a screen-reader user skims a page.
 *
 * Playwright browser binaries are not downloadable on this network, so this
 * drives the system Edge install via the msedge channel.
 */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const ROUTES = (
  process.env.A11Y_ROUTES ??
  "/,/search?q=dune,/watchlist,/client,/activity,/history,/rules,/settings"
).split(",");

const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  colorScheme: "dark",
});

const findings = [];
const note = (route, check, detail) =>
  findings.push({ route, check, detail });

for (const route of ROUTES) {
  const page = await context.newPage();
  try {
    await page.goto(`${BASE}${route}`, {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });
    // Let client components hydrate and first data land.
    await page.waitForTimeout(4000);

    const result = await page.evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return false;
        const s = getComputedStyle(el);
        return s.visibility !== "hidden" && s.display !== "none";
      };

      // Approximates the accessible-name computation for the cases we care
      // about: explicit labels win, then text content, then a title.
      const accName = (el) => {
        const aria = el.getAttribute("aria-label");
        if (aria?.trim()) return aria.trim();
        const labelledBy = el.getAttribute("aria-labelledby");
        if (labelledBy) {
          const names = labelledBy
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
            .filter(Boolean)
            .join(" ");
          if (names) return names;
        }
        const text = el.textContent?.replace(/\s+/g, " ").trim();
        if (text) return text;
        const title = el.getAttribute("title");
        if (title?.trim()) return title.trim();
        return "";
      };

      // An element hidden from the accessibility tree cannot be a naming
      // defect: assistive tech never reaches it, so there is nothing to name.
      // This mirrors the alt="" carve-out below — both are ways of declaring
      // "this is decorative on purpose". Redundant mouse-only affordances use
      // it (the rail scroll arrows: aria-hidden + tabIndex=-1, because the
      // same scrolling is already reachable by arrow-keying the cards).
      // Checked up the ancestor chain, since aria-hidden is inherited.
      const inA11yTree = (el) => !el.closest('[aria-hidden="true"], [aria-hidden=""]');

      const describe = (el) => {        const cls =
          typeof el.className === "string" ? el.className.slice(0, 60) : "";
        return `<${el.tagName.toLowerCase()}${
          el.id ? ` id=${el.id}` : ""
        }${cls ? ` class="${cls}"` : ""}>`;
      };

      const out = {
        namelessControls: [],
        imagesWithoutAlt: [],
        duplicateTabNames: [],
        headings: [],
        h1Count: 0,
      };

      for (const el of document.querySelectorAll(
        'button, a[href], [role="button"], [role="tab"]',
      )) {
        if (!visible(el)) continue;
        if (!inA11yTree(el)) continue;
        if (accName(el)) continue;
        out.namelessControls.push(describe(el));
      }

      for (const img of document.querySelectorAll("img")) {
        if (!visible(img)) continue;
        if (!inA11yTree(img)) continue;
        // alt="" is a valid, deliberate "this is decorative".
        if (img.getAttribute("alt") === null) {
          out.imagesWithoutAlt.push(describe(img) + ` src=${img.src.slice(-60)}`);
        }
      }

      // Tabs are only ambiguous against their *siblings* — two different work
      // sections may both legitimately offer a season 1.
      const groups = new Set();
      for (const tab of document.querySelectorAll('[role="tab"]')) {
        if (tab.parentElement) groups.add(tab.parentElement);
      }
      for (const group of groups) {
        const seen = new Map();
        for (const tab of group.querySelectorAll(':scope > [role="tab"]')) {
          if (!visible(tab)) continue;
          if (!inA11yTree(tab)) continue;
          const name = accName(tab).toLowerCase();
          if (!name) continue;
          seen.set(name, (seen.get(name) ?? 0) + 1);
        }
        for (const [name, count] of seen) {
          if (count > 1) {
            out.duplicateTabNames.push(`"${name}" x${count} in ${describe(group)}`);
          }
        }
      }

      for (const h of document.querySelectorAll("h1,h2,h3,h4,h5,h6")) {
        if (!visible(h)) continue;
        out.headings.push(Number(h.tagName[1]));
      }
      out.h1Count = document.querySelectorAll("h1").length;
      return out;
    });

    for (const c of result.namelessControls) {
      note(route, "control has no accessible name", c);
    }
    for (const i of result.imagesWithoutAlt) {
      note(route, "image missing alt attribute", i);
    }
    for (const d of result.duplicateTabNames) {
      note(route, "sibling tabs share an accessible name", d);
    }
    if (result.h1Count === 0) {
      note(route, "no h1 on page", "");
    } else if (result.h1Count > 1) {
      note(route, "multiple h1 elements", `count=${result.h1Count}`);
    }
    for (let i = 1; i < result.headings.length; i += 1) {
      const jump = result.headings[i] - result.headings[i - 1];
      if (jump > 1) {
        note(
          route,
          "heading level skipped",
          `h${result.headings[i - 1]} -> h${result.headings[i]}`,
        );
      }
    }

    // Keyboard focus must leave a visible mark on the first few stops.
    let focusChecked = 0;
    let focusInvisible = 0;
    for (let i = 0; i < 8; i += 1) {
      await page.keyboard.press("Tab");
      const styled = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const s = getComputedStyle(el);
        const ring =
          (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) ||
          s.boxShadow !== "none";
        return { ring, tag: el.tagName.toLowerCase() };
      });
      if (!styled) continue;
      focusChecked += 1;
      if (!styled.ring) focusInvisible += 1;
    }
    if (focusChecked && focusInvisible === focusChecked) {
      note(
        route,
        "no visible focus indicator",
        `${focusInvisible}/${focusChecked} tab stops had neither outline nor box-shadow`,
      );
    }
  } catch (err) {
    note(route, "page threw", err.message.slice(0, 160));
  } finally {
    await page.close();
  }
}

await browser.close();

if (!findings.length) {
  console.log(`ALL GREEN — no a11y findings across ${ROUTES.length} routes`);
  process.exit(0);
}

const byRoute = new Map();
for (const f of findings) {
  if (!byRoute.has(f.route)) byRoute.set(f.route, []);
  byRoute.get(f.route).push(f);
}
for (const [route, items] of byRoute) {
  console.log(`\n${route}`);
  for (const i of items) {
    console.log(`  ${i.check}${i.detail ? `: ${i.detail}` : ""}`);
  }
}
console.log(`\n${findings.length} finding(s) across ${byRoute.size} route(s)`);
process.exit(1);
