/**
 * Route screenshotter.
 *
 * Runs against whatever build is currently served on BASE_URL, so the same
 * script produces the before/after pairs used to review UI work. Playwright
 * browser binaries are not downloadable on this network, so it drives the
 * system Edge install via the msedge channel instead.
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const OUT = process.env.SHOT_DIR ?? "qa-screens/before";
const ROUTES = [
  ["home", "/"],
  ["search", "/search?q=breaking+bad"],
  ["watchlist", "/watchlist"],
  ["client", "/client"],
  ["activity", "/activity"],
  ["history", "/history"],
  ["rules", "/rules"],
  ["settings", "/settings"],
  ["about", "/about"],
];
const VIEWPORTS = [
  ["desktop", 1440, 900],
  ["mobile", 390, 844],
];

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: "msedge", headless: true });
const failures = [];

for (const [vpName, width, height] of VIEWPORTS) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
    colorScheme: "dark",
  });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

  for (const [name, path] of ROUTES) {
    consoleErrors.length = 0;
    const file = join(OUT, `${vpName}-${name}.png`);
    try {
      const res = await page.goto(`${BASE}${path}`, {
        waitUntil: "networkidle",
        timeout: 45_000,
      });
      // Data-driven pages settle after their fetches resolve; a fixed pause
      // keeps skeleton states out of the screenshots without racing on a
      // selector that differs per route.
      await page.waitForTimeout(1200);
      await page.screenshot({ path: file, fullPage: true });
      const status = res?.status() ?? 0;
      const flag = status >= 400 ? ` HTTP ${status}` : "";
      const errs = consoleErrors.length ? ` console:${consoleErrors.length}` : "";
      console.log(`ok   ${vpName}/${name}${flag}${errs}`);
      if (status >= 400 || consoleErrors.length) {
        failures.push({ route: `${vpName}/${name}`, status, errors: [...consoleErrors] });
      }
    } catch (err) {
      console.log(`FAIL ${vpName}/${name}: ${err.message.split("\n")[0]}`);
      failures.push({ route: `${vpName}/${name}`, error: err.message.split("\n")[0] });
    }
  }
  await context.close();
}

await browser.close();

if (failures.length) {
  console.log(`\n${failures.length} route(s) with problems:`);
  for (const f of failures) console.log(JSON.stringify(f));
} else {
  console.log("\nall routes clean");
}
