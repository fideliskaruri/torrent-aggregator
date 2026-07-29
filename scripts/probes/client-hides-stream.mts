import { chromium } from "playwright";

const BASE = process.env.BASE ?? "http://127.0.0.1:3000";

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`${BASE}/client`, { waitUntil: "networkidle" });
// give hydration + first poll time to render rows
await page.waitForTimeout(3000);

const bodyText = await page.evaluate("document.body.innerText");
const text = String(bodyText);

const streamNeedle = "Family Guy S06";
const keptNeedle = "Dune Part Two";

const hasStream = text.includes(streamNeedle);
const hasKept = text.includes(keptNeedle);

console.log(JSON.stringify({ hasStream, hasKept }, null, 2));

await browser.close();

if (hasStream) {
  console.error(`FAIL: stream-only row "${streamNeedle}" is visible on /client`);
  process.exit(1);
}
if (!hasKept) {
  console.error(`FAIL: kept row "${keptNeedle}" is NOT visible on /client`);
  process.exit(1);
}
console.log("PASS: stream-only hidden, kept downloads shown");
