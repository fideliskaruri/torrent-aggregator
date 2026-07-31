/**
 * Walk the whole app and report defects a person would actually hit.
 *
 * Not a screenshot dump: every check below is a rule the product should hold,
 * expressed so a failure names the defect rather than "looks different". It
 * covers the surfaces a locked workstation stops me driving by hand.
 *
 * Run:  node scripts\probes\app-audit.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const OUT = path.resolve("qa-shots", "audit");
fs.mkdirSync(OUT, { recursive: true });

const defects = [];
let passes = 0;

function check(area, name, ok, detail = "") {
  if (ok) {
    passes += 1;
  } else {
    defects.push({ area, name, detail });
    console.error(`  DEFECT [${area}] ${name}${detail ? `\n           ${detail}` : ""}`);
  }
}

/**
 * Interactive controls with no accessible name, per the browser's own name
 * computation.
 *
 * Guessing at this from attributes produces false positives that are worse than
 * no check: it flags correct code, and "fixing" it means adding a redundant
 * aria-label that can drift from the visible text. The CDP tree is what a
 * screen reader actually gets.
 */
async function namelessControls(page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Accessibility.enable");
    const { nodes } = await cdp.send("Accessibility.getFullAXTree");
    const INTERACTIVE = new Set([
      "button",
      "checkbox",
      "link",
      "tab",
      "switch",
      "radio",
      "textbox",
      "combobox",
      "slider",
    ]);
    return nodes
      .filter((n) => {
        if (n.ignored) return false; // aria-hidden / display:none — not reachable
        const role = n.role?.value;
        if (!role || !INTERACTIVE.has(role)) return false;
        return !(n.name?.value ?? "").trim();
      })
      .map((n) => `${n.role?.value}#${n.backendDOMNodeId ?? "?"}`);
  } catch {
    return [];
  } finally {
    await cdp.detach().catch(() => {});
  }
}

const ROUTES = [
  "/",
  "/everything",
  "/watchlist",
  "/client",
  "/activity",
  "/settings",
  "/history",
  "/rules",
  "/about",
];

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
];

const browser = await chromium.launch({ headless: true });

try {
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
    });
    const page = await ctx.newPage();

    const consoleErrors = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

    for (const route of ROUTES) {
      consoleErrors.length = 0;
      const res = await page
        .goto(`${BASE}${route}`, { waitUntil: "networkidle", timeout: 45000 })
        .catch(() => null);

      check(vp.name, `${route} responds`, res != null && res.status() < 400,
        res ? `HTTP ${res.status()}` : "no response");
      if (!res || res.status() >= 400) continue;

      // ── A page that renders nothing is broken, however green the build ──
      const text = (await page.innerText("body").catch(() => "")).trim();
      check(vp.name, `${route} renders content`, text.length > 60,
        `${text.length} chars`);

      // ── Horizontal overflow: the classic mobile break ──────────────────
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      check(vp.name, `${route} no horizontal overflow`, overflow <= 1, `${overflow}px`);

      // ── Runtime errors ─────────────────────────────────────────────────
      const real = consoleErrors.filter(
        (e) =>
          !/favicon|404 \(Not Found\).*favicon|Failed to load resource.*favicon/i.test(e),
      );
      check(vp.name, `${route} no console errors`, real.length === 0,
        real.slice(0, 2).join(" | "));

      // ── Every page needs exactly one H1 ────────────────────────────────
      const h1s = await page.locator("h1").count();
      check(vp.name, `${route} has exactly one h1`, h1s === 1, `found ${h1s}`);

      // ── Touch targets on mobile ────────────────────────────────────────
      if (vp.width < 500) {
        const small = await page.evaluate(() => {
          const bad = [];
          for (const el of document.querySelectorAll(
            "button, a[href], [role='tab'], [role='checkbox'], [role='switch']",
          )) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue; // hidden
            const cs = getComputedStyle(el);
            if (cs.visibility === "hidden" || cs.display === "none") continue;
            if (el.closest("[aria-hidden='true']")) continue;
            // WCAG 2.5.5 exempts a link sitting inside a sentence of running
            // text — it cannot be enlarged without breaking the line. Detected
            // structurally (an inline element with text siblings) rather than
            // by name, so the exemption cannot be claimed by a real button.
            const inlineInProse =
              cs.display.startsWith("inline") &&
              el.parentElement != null &&
              Array.from(el.parentElement.childNodes).some(
                (n) => n.nodeType === 3 && (n.textContent ?? "").trim().length > 0,
              );
            if (inlineInProse) continue;
            if (r.height < 32) {
              bad.push(
                `${el.tagName.toLowerCase()}"${(el.textContent ?? "").trim().slice(0, 22)}" ${Math.round(r.height)}px`,
              );
            }
          }
          return bad;
        });
        check(vp.name, `${route} touch targets >= 32px`, small.length === 0,
          small.slice(0, 4).join(" | "));
      }

      // ── Images must have alt text ──────────────────────────────────────
      const noAlt = await page.evaluate(
        () =>
          Array.from(document.querySelectorAll("img"))
            .filter((i) => !i.hasAttribute("alt"))
            .map((i) => i.getAttribute("src")?.slice(0, 40) ?? "?")
            .slice(0, 3),
      );
      check(vp.name, `${route} images have alt`, noAlt.length === 0, noAlt.join(" | "));

      // ── Controls must be nameable ──────────────────────────────────────
      //
      // Computed through CDP rather than by looking for aria-label/text. Two
      // whole classes were mis-reported by the naive version: a control named
      // by a wrapping <label> (correct — <button> is a labelable element), and
      // a decorative arrow marked aria-hidden with tabIndex -1 (correct — a
      // redundant mouse affordance that no screen reader ever reaches). Both
      // would have been "fixed" into something worse.
      const unnamed = await namelessControls(page);
      check(vp.name, `${route} controls have accessible names`, unnamed.length === 0,
        unnamed.slice(0, 3).join(" | "));
    }

    await page.screenshot({
      path: path.join(OUT, `nav-${vp.name}.png`),
    }).catch(() => {});
    await ctx.close();
  }

  // ── Mobile nav specifically: 6 items now, does it still work? ──────────
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/`, { waitUntil: "networkidle" });

    const navMetrics = await page.evaluate(() => {
      const nav =
        document.querySelector("nav[class*='fixed'], [data-mobile-nav], footer nav") ??
        Array.from(document.querySelectorAll("nav")).pop();
      if (!nav) return null;
      const items = Array.from(nav.querySelectorAll("a[href], button"));
      return {
        count: items.length,
        navWidth: Math.round(nav.getBoundingClientRect().width),
        overflows: items.some((i) => {
          const r = i.getBoundingClientRect();
          return r.right > window.innerWidth + 1 || r.left < -1;
        }),
        clipped: items
          .map((i) => {
            const label = i.querySelector("span:last-child") ?? i;
            return {
              text: (i.textContent ?? "").trim().slice(0, 14),
              clipped: label.scrollWidth > label.clientWidth + 1,
            };
          })
          .filter((x) => x.clipped)
          .map((x) => x.text),
      };
    });

    check("mobile-nav", "the tab bar exists", navMetrics != null);
    if (navMetrics) {
      check("mobile-nav", "no item escapes the viewport", !navMetrics.overflows,
        JSON.stringify(navMetrics));
      check("mobile-nav", "no label is visually clipped", navMetrics.clipped.length === 0,
        `clipped: ${JSON.stringify(navMetrics.clipped)} across ${navMetrics.count} items`);
    }
    await page.screenshot({ path: path.join(OUT, "mobile-nav.png") });
    await ctx.close();
  }

  // ── Keyboard: the palette must stay drivable with artifact rows ────────
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
    await page.keyboard.press("/");
    await page.waitForSelector("[data-search-overlay]", { timeout: 8000 }).catch(() => {});

    const focusedTag = await page.evaluate(
      () => document.activeElement?.getAttribute("data-search-overlay-input") ?? "no",
    );
    check("keyboard", "the palette focuses its input on open", focusedTag === "true",
      `activeElement data-search-overlay-input=${focusedTag}`);

    // Esc must close.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    const stillOpen = await page.locator("[data-search-overlay]").count();
    check("keyboard", "Esc closes the palette", stillOpen === 0);
    await ctx.close();
  }

  // ── The section page: error and empty states must not be blank ─────────
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();

    // An unknown scope in a URL must be handled, not crash.
    await page.goto(`${BASE}/everything?scope=podcasts&q=test`, {
      waitUntil: "networkidle",
    });
    const badScopeText = await page.innerText("body");
    check("section", "an unknown scope is handled gracefully",
      badScopeText.length > 60 && !/error|crash/i.test(badScopeText.slice(0, 200)),
      badScopeText.slice(0, 120));

    // A query that matches nothing must say so, not show a void.
    await page.goto(
      `${BASE}/everything?scope=music&q=zzzzqqqxxnothingmatchesthis`,
      { waitUntil: "networkidle" },
    );
    await page.waitForTimeout(9000);
    const emptyText = await page.innerText("body");
    check("section", "an empty result set explains itself",
      /nothing|no results|no match/i.test(emptyText), emptyText.slice(-260));
    await page.screenshot({ path: path.join(OUT, "section-empty.png"), fullPage: true });
    await ctx.close();
  }
} finally {
  await browser.close();
}

console.log(`\n${passes} checks passed, ${defects.length} defect(s)`);
if (defects.length) {
  console.log("\nDEFECTS:");
  for (const d of defects) console.log(`  [${d.area}] ${d.name} — ${d.detail}`);
  process.exit(1);
}
console.log("no defects found");
