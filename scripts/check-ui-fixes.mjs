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

const browser = await chromium.launch();

try {
  // --- Preferred quality and mobile form text -----------------------------
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`${BASE}/settings?tab=folders`, { waitUntil: "networkidle" });

    const quality = page.locator("#preferred-quality");
    const qualityCount = await quality.count();
    check("quality control is one labelled native select", () => {
      if (qualityCount !== 1) {
        throw new Error(`expected one #preferred-quality, found ${qualityCount}`);
      }
    });
    const options = await quality.locator("option").allTextContents();
    check("quality control preserves all four choices", () => {
      if (options.length !== 4) {
        throw new Error(`expected 4 options, found ${options.length}`);
      }
      if (!options.some((label) => label.startsWith("4K"))) {
        throw new Error(`4K missing from ${JSON.stringify(options)}`);
      }
    });
    const selected = await quality.inputValue();
    check("quality control has exactly one selected value", () => {
      if (!["480", "720", "1080", "2160"].includes(selected)) {
        throw new Error(`unexpected value ${selected}`);
      }
    });

    await page.setViewportSize({ width: 320, height: 800 });
    await page.waitForTimeout(150);
    const mobileSizes = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll(
          "[data-settings-form] input, [data-settings-form] select, [data-settings-form] textarea",
        ),
      )
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })
        .map((element) => ({
          id: element.id,
          size: parseFloat(getComputedStyle(element).fontSize),
        })),
    );
    check("visible Settings fields use at least 16px text at 320px", () => {
      const small = mobileSizes.filter(({ size }) => size < 16);
      if (small.length) {
        throw new Error(JSON.stringify(small));
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

      // The sheet says aria-modal="true". That is a promise that everything
      // behind it is unreachable; without focus management it was a lie —
      // focus stayed on the More button and Tab walked the dimmed page.
      const landed = await page.evaluate(() => {
        const sheet = document.querySelector("[data-mobile-more-sheet]");
        return Boolean(sheet && sheet.contains(document.activeElement));
      });
      check("opening the sheet moves focus into it", () => {
        if (!landed) throw new Error("focus stayed outside the dialog");
      });

      let escaped = 0;
      for (let i = 0; i < 12; i += 1) {
        await page.keyboard.press("Tab");
        const inside = await page.evaluate(() => {
          const sheet = document.querySelector("[data-mobile-more-sheet]");
          return Boolean(sheet && sheet.contains(document.activeElement));
        });
        if (!inside) escaped += 1;
      }
      check("Tab stays inside the sheet (12 presses)", () => {
        if (escaped) throw new Error(`${escaped}/12 tab stops fell outside`);
      });

      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
      const restored = await page.evaluate(
        () => document.activeElement?.textContent?.trim() ?? "",
      );
      check("closing the sheet returns focus to the More button", () => {
        if (!/More/.test(restored)) {
          throw new Error(`focus went to "${restored}" instead`);
        }
      });
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

  // --- Text contrast across the app --------------------------------------
  // `--text-tertiary` was #71717a = 3.59:1, below WCAG AA, and it is the
  // colour of every form label, hint and metadata line in the app. A local
  // patch on one control would have left the same failure everywhere else, so
  // this sweeps real rendered text on every route.
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    for (const route of ["/", "/watchlist", "/client", "/history", "/rules", "/settings"]) {
      await page.goto(`${BASE}${route}`, { waitUntil: "networkidle" });
      await page.waitForTimeout(400);
      const worst = await page.evaluate(() => {
        const lum = ([r, g, b]) => {
          const f = (c) => {
            const s = c / 255;
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          };
          return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
        };
        const rgb = (s) => {
          const m = s.match(/-?\d+(\.\d+)?/g) ?? [0, 0, 0];
          return [Number(m[0]), Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : 1];
        };
        const over = (fg, bg) => {
          const a = fg[3] ?? 1;
          return [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a));
        };
        // Walk up for the first opaque background actually painted behind it,
        // compositing every translucent layer above it in the right order —
        // top-down accumulation gives nonsense ratios like 1.00:1.
        const backdrop = (el) => {
          const layers = [];
          for (let p = el; p; p = p.parentElement) {
            const c = rgb(getComputedStyle(p).backgroundColor);
            if ((c[3] ?? 1) === 0) continue;
            layers.push(c);
            if ((c[3] ?? 1) === 1) break;
          }
          if (!layers.length) return [0, 0, 0];
          let base = layers[layers.length - 1].slice(0, 3);
          for (let i = layers.length - 2; i >= 0; i -= 1) {
            base = over(layers[i], base);
          }
          return base;
        };
        let out = null;
        for (const el of document.querySelectorAll("body *")) {
          const text = Array.from(el.childNodes)
            .filter((n) => n.nodeType === 3)
            .map((n) => n.textContent.trim())
            .join("");
          if (!text) continue;
          const cs = getComputedStyle(el);
          if (cs.visibility === "hidden" || cs.display === "none") continue;
          if (el.closest("[aria-hidden='true']")) continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const bg = backdrop(el);
          const fg = over(rgb(cs.color), bg);
          const a = lum(fg);
          const b = lum(bg);
          const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
          // AA allows 3:1 for large text (>=24px, or >=18.66px bold).
          const size = parseFloat(cs.fontSize);
          const bold = parseInt(cs.fontWeight, 10) >= 700;
          const floor = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
          if (ratio < floor && (!out || ratio < out.ratio)) {
            out = { ratio, text: text.slice(0, 40), color: cs.color, size };
          }
        }
        return out;
      });
      check(`${route}: all text meets WCAG AA`, () => {
        if (worst) {
          throw new Error(
            `"${worst.text}" ${worst.ratio.toFixed(2)}:1 at ${worst.size}px (${worst.color})`,
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
