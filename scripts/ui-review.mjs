import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";

const out = path.resolve("qa-shots/review");
fs.mkdirSync(out, { recursive: true });

const viewports = [
  { name: "phone", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
];

const browser = await chromium.launch({ headless: true });

async function shot(page, name) {
  const file = path.join(out, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log("saved", path.basename(file));
  return file;
}

for (const vp of viewports) {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  // Home
  await page.goto("http://localhost:3000/", {
    waitUntil: "networkidle",
    timeout: 60000,
  });
  await page.waitForTimeout(600);
  await shot(page, `${vp.name}-01-home`);

  // Focus search to show recent panel (seed history first)
  await page.evaluate(() => {
    localStorage.setItem(
      "tf-recent-searches",
      JSON.stringify(["Severance", "Atlantis", "One Piece", "Dune"]),
    );
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await page.click('input[data-search-input="true"]');
  await page.waitForTimeout(400);
  await shot(page, `${vp.name}-02-home-recent`);

  // Search results
  await page.goto(
    "http://localhost:3000/?q=Severance&category=tv",
    { waitUntil: "networkidle", timeout: 90000 },
  );
  await page.waitForTimeout(2500);
  await shot(page, `${vp.name}-03-search`);

  // Expand first send options if present
  const chevron = page.locator('[data-torrent-card] button').filter({ has: page.locator("svg") }).nth(2);
  try {
    const expandBtns = page.locator("[data-torrent-card]").first().locator("button");
    const count = await expandBtns.count();
    // click the chevron next to Send (usually near end of action group)
    const sendGroup = page.locator("[data-torrent-card]").first().locator("button[aria-expanded]");
    if (await sendGroup.count()) {
      await sendGroup.first().click();
      await page.waitForTimeout(400);
      await shot(page, `${vp.name}-04-search-expand`);
    }
  } catch {
    console.log("no expand on", vp.name);
  }

  // Login
  await page.goto("http://localhost:3000/login", {
    waitUntil: "networkidle",
    timeout: 30000,
  });
  await page.waitForTimeout(400);
  await shot(page, `${vp.name}-05-login`);

  // Settings (may show sign-in gate)
  await page.goto("http://localhost:3000/settings", {
    waitUntil: "networkidle",
    timeout: 30000,
  });
  await page.waitForTimeout(400);
  await shot(page, `${vp.name}-06-settings`);

  await context.close();
}

await browser.close();
console.log("done →", out);
