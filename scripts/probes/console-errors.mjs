// Collect console errors, page errors and failed requests across routes.
//   node scripts/probes/console-errors.mjs [baseUrl]

import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:3000";
const ROUTES = [
  "/", "/title/family-guy", "/title/dune", "/title/rick-and-morty",
  "/search?q=family%20guy", "/client", "/activity", "/watchlist", "/settings", "/rules", "/about",
];

const NOISE = [/Download the React DevTools/i, /Lit is in dev mode/i, /favicon/i];
const isNoise = (s) => NOISE.some((r) => r.test(s));

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

let total = 0;
for (const route of ROUTES) {
  const found = [];
  const onConsole = (m) => { if (m.type() === "error" && !isNoise(m.text())) found.push("console: " + m.text().slice(0, 180)); };
  const onPageError = (e) => found.push("pageerror: " + e.message.split("\n")[0].slice(0, 180));
  const onResponse = (r) => { if (r.status() >= 400 && !isNoise(r.url())) found.push(`http ${r.status()} ${r.url().replace(BASE, "").slice(0, 120)}`); };

  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  page.on("response", onResponse);
  try {
    await page.goto(BASE + route, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(4000);
  } catch (err) {
    found.push("navigation: " + err.message.split("\n")[0]);
  }
  page.off("console", onConsole);
  page.off("pageerror", onPageError);
  page.off("response", onResponse);

  const uniq = [...new Set(found)];
  total += uniq.length;
  console.log(`${uniq.length === 0 ? "clean" : String(uniq.length).padStart(5)}  ${route}`);
  for (const f of uniq.slice(0, 6)) console.log(`         ${f}`);
}

await browser.close();
console.log(`\nTOTAL ${total} error signals`);
process.exit(total === 0 ? 0 : 1);
