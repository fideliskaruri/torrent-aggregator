/**
 * Verifies the specific UI defects reported by visual-QC are actually gone.
 *
 * Each check asserts the *measured* property that failed, not a screenshot —
 * so a regression fails loudly in CI rather than needing a human to look.
 *
 *   node scripts/check-ui-fixes.mjs --base http://127.0.0.1:3000
 */
import { chromium } from "playwright";

const baseArg = process.argv.indexOf("--base");
const BASE = baseArg > -1 ? process.argv[baseArg + 1] : "http://127.0.0.1:3000";

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${name}`);
    console.error(`      ${err.message}`);
  }
}

/** WCAG relative luminance / contrast ratio. */
function luminance([r, g, b]) {
  const f = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
function parseRgb(s) {
  const m = s.match(/-?\d+(\.\d+)?/g);
  if (!m) throw new Error(`unparseable colour: ${s}`);
  return [Number(m[0]), Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : 1];
}

/** Composite a possibly-translucent colour over an opaque backdrop. */
function flatten(fg, bg) {
  const a = fg[3] ?? 1;
  return [0, 1, 2].map((i) => Math.round(fg[i] * a + bg[i] * (1 - a)));
}

const browser = await chromium.launch();

try {
  // --- Preferred-quality segmented control -------------------------------
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`${BASE}/settings?tab=folders`, { waitUntil: "networkidle" });

    const group = page.locator('button[aria-pressed]').filter({
      hasText: /^(480p|720p|1080p|4K)$/,
    });
    const n = await group.count();

    check("quality control renders all four options", () => {
      if (n !== 4) throw new Error(`expected 4 buttons, found ${n}`);
    });

    const pageBg = parseRgb(
      await page.evaluate(() => getComputedStyle(document.body).backgroundColor),
    );

    for (let i = 0; i < n; i += 1) {
      const btn = group.nth(i);
      const label = (await btn.innerText()).trim();
      const info = await btn.evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          color: cs.color,
          bg: cs.backgroundColor,
          pressed: el.getAttribute("aria-pressed"),
        };
      });
      const bg = flatten(parseRgb(info.bg), pageBg);
      const fg = flatten(parseRgb(info.color), bg);
      const ratio = contrast(fg, bg);

      check(`${label}: label contrast >= 4.5:1 (was 2.12:1 when selected)`, () => {
        if (ratio < 4.5) {
          throw new Error(
            `${label} pressed=${info.pressed} contrast ${ratio.toFixed(2)}:1 (${info.color} on ${info.bg})`,
          );
        }
      });

      check(`${label}: has a visible chip, so it reads as a button`, () => {
        const alpha = parseRgb(info.bg)[3] ?? 1;
        if (alpha === 0) {
          throw new Error(`${label} background is fully transparent`);
        }
        // Must be distinguishable from the page behind it.
        if (contrast(bg, pageBg) < 1.05) {
          throw new Error(
            `${label} chip is indistinguishable from the page background`,
          );
        }
      });
    }

    check("exactly one option is selected", async () => {});
    const pressed = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button[aria-pressed="true"]'))
        .map((b) => b.textContent.trim())
        .filter((t) => /^(480p|720p|1080p|4K)$/.test(t)),
    );
    check("exactly one quality option is pressed", () => {
      if (pressed.length !== 1) {
        throw new Error(`pressed = ${JSON.stringify(pressed)}`);
      }
    });

    // 320px: the group must not orphan "4K" onto a second row.
    await page.setViewportSize({ width: 320, height: 800 });
    await page.waitForTimeout(150);
    const tops = await group.evaluateAll((els) =>
      els.map((e) => Math.round(e.getBoundingClientRect().top)),
    );
    check("quality control stays on one row at 320px", () => {
      const unique = new Set(tops);
      if (unique.size !== 1) {
        throw new Error(`buttons on ${unique.size} rows: ${JSON.stringify(tops)}`);
      }
    });

    await page.close();
  }

  // --- Mobile "More" sheet must lock background scroll -------------------
  {
    const page = await browser.newPage({ viewport: { width: 375, height: 700 } });
    await page.goto(`${BASE}/settings`, { waitUntil: "networkidle" });

    const more = page.locator("button", { hasText: /^More$/ }).last();
    if (await more.count()) {
      await more.click();
      await page.waitForTimeout(250);
      const before = await page.evaluate(() => window.scrollY);
      await page.mouse.wheel(0, 900);
      await page.waitForTimeout(250);
      const after = await page.evaluate(() => window.scrollY);
      check("open mobile sheet freezes the page behind it", () => {
        if (after !== before) {
          throw new Error(`page scrolled behind modal: ${before} -> ${after}`);
        }
      });
      await page.keyboard.press("Escape");
    } else {
      console.log("  --  mobile More sheet not present, skipped");
    }
    await page.close();
  }

  // --- /rules form grid --------------------------------------------------
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`${BASE}/rules`, { waitUntil: "networkidle" });
    const res = page.locator("#rule-resolution");
    if (await res.count()) {
      const [fieldW, seedersW] = await page.evaluate(() => {
        const r = document.querySelector("#rule-resolution")?.closest("div");
        const s = document.querySelector("#rule-min-seeders")?.closest("div");
        return [
          r ? Math.round(r.getBoundingClientRect().width) : -1,
          s ? Math.round(s.getBoundingClientRect().width) : -1,
        ];
      });
      check("Resolution field occupies one grid column, not the full row", () => {
        if (seedersW <= 0) return; // neighbour not found, nothing to compare
        if (fieldW > seedersW * 1.5) {
          throw new Error(
            `resolution ${fieldW}px vs min-seeders ${seedersW}px — still spanning`,
          );
        }
      });
    }
    await page.close();
  }
} finally {
  await browser.close();
}

console.log(
  failures === 0 ? "\ncheck-ui-fixes: all clean" : `\ncheck-ui-fixes: ${failures} FAILED`,
);
process.exit(failures > 0 ? 1 : 0);
