// Capture the same routes at mobile + desktop for before/after comparison.
//   node scripts/probes/shoot.mjs <baseUrl> <outDir>

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.argv[2] ?? "http://localhost:3000";
const OUT = process.argv[3] ?? "ui-shots";

const SHOTS = [
  { name: "title-family-guy", route: "/title/family-guy" },
  { name: "title-rick-and-morty", route: "/title/rick-and-morty" },
  { name: "home", route: "/" },
  { name: "search", route: "/search?q=family%20guy" },
  { name: "client", route: "/client" },
];

const VIEWPORTS = [
  { name: "mobile", width: 390, height: 844 },
  { name: "desktop", width: 1440, height: 900 },
];

fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  for (const shot of SHOTS) {
    try {
      await page.goto(BASE + shot.route, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(3000);
      const file = path.join(OUT, `${shot.name}.${vp.name}.png`);
      await page.screenshot({ path: file, fullPage: false });
      console.log(`ok   ${file}`);
    } catch (err) {
      console.log(`FAIL ${shot.name}.${vp.name}: ${err.message.split("\n")[0]}`);
    }
  }
  await ctx.close();
}
await browser.close();
