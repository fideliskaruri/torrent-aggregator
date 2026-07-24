import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";

const out = path.resolve("qa-shots");
fs.mkdirSync(out, { recursive: true });

const viewports = [
  { name: "phone", width: 390, height: 844 },
  { name: "phablet", width: 430, height: 932 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "laptop", width: 1280, height: 800 },
  { name: "desktop", width: 1536, height: 960 },
];

const pages = [
  { name: "home", url: "http://localhost:3000/" },
  { name: "search", url: "http://localhost:3000/?q=Severance&category=tv" },
  { name: "login", url: "http://localhost:3000/login" },
  { name: "settings", url: "http://localhost:3000/settings" },
];

const browser = await chromium.launch({ headless: true });
const issues = [];

for (const vp of viewports) {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  page.on("pageerror", (err) =>
    issues.push({ vp: vp.name, error: String(err.message || err) }),
  );
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      issues.push({ vp: vp.name, console: msg.text().slice(0, 200) });
    }
  });

  for (const p of pages) {
    try {
      await page.goto(p.url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(1200);

      const metrics = await page.evaluate(() => {
        const doc = document.documentElement;
        const body = document.body;
        const scrollWidth = Math.max(doc.scrollWidth, body.scrollWidth);
        const clientWidth = doc.clientWidth;

        // Find elements sticking past viewport
        const offenders = [];
        for (const el of document.querySelectorAll("body *")) {
          const r = el.getBoundingClientRect();
          if (r.width > clientWidth + 2 && r.right > clientWidth + 2) {
            const tag = el.tagName.toLowerCase();
            const cls = (el.className && String(el.className).slice(0, 60)) || "";
            offenders.push({ tag, cls, w: Math.round(r.width) });
            if (offenders.length >= 5) break;
          }
        }

        let gradientCount = 0;
        for (const el of document.querySelectorAll("body *")) {
          const bg = getComputedStyle(el).backgroundImage;
          if (bg && bg !== "none" && bg.includes("gradient")) {
            gradientCount += 1;
          }
        }

        return {
          scrollWidth,
          clientWidth,
          overflowX: scrollWidth - clientWidth,
          gradientCount,
          offenders,
        };
      });

      const file = path.join(out, `${vp.name}-${p.name}.png`);
      await page.screenshot({ path: file, fullPage: true });
      console.log(
        JSON.stringify({
          vp: vp.name,
          page: p.name,
          overflowX: metrics.overflowX,
          gradients: metrics.gradientCount,
          offenders: metrics.offenders,
          shot: path.basename(file),
        }),
      );

      if (metrics.overflowX > 2) {
        issues.push({
          vp: vp.name,
          page: p.name,
          issue: "horizontal-overflow",
          px: metrics.overflowX,
          offenders: metrics.offenders,
        });
      }
      if (metrics.gradientCount > 0) {
        issues.push({
          vp: vp.name,
          page: p.name,
          issue: "gradients-present",
          count: metrics.gradientCount,
        });
      }
    } catch (e) {
      issues.push({ vp: vp.name, page: p.name, error: e.message });
      console.log("ERR", vp.name, p.name, e.message.slice(0, 160));
    }
  }
  await context.close();
}

console.log("ISSUES\n" + JSON.stringify(issues, null, 2));
await browser.close();
