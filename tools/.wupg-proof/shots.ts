// Headless proof shots for OPS-857. Usage:
//   node --experimental-strip-types shots.ts <name> [click-selector] [wait-selector]
import { createRequire } from "node:module";

type Page = {
  goto(url: string, opts?: { waitUntil?: string }): Promise<unknown>;
  waitForSelector(selector: string, opts?: { timeout?: number; state?: string }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  screenshot(opts: { path: string; fullPage?: boolean }): Promise<unknown>;
  click(selector: string, opts?: { timeout?: number }): Promise<void>;
  evaluate<T, A>(fn: (arg: A) => T, arg: A): Promise<T>;
};
type Context = { newPage(): Promise<Page>; close(): Promise<void> };
type Route = {
  request(): { method(): string };
  continue(): Promise<void>;
  fetch(): Promise<{ json(): Promise<unknown> }>;
  fulfill(opts: { response: unknown; json: unknown }): Promise<void>;
};
type Browser = {
  newContext(opts: { viewport: { width: number; height: number } }): Promise<Context>;
  close(): Promise<void>;
};
const require = createRequire("D:/code/node_modules/");
const { chromium } = require("playwright-core") as {
  chromium: { launch(opts: { channel: string; headless: boolean }): Promise<Browser> };
};

const [name, clickSel, waitSel, pathArg] = process.argv.slice(2);
const base = "http://127.0.0.1:3967";
const path = pathArg ?? "/title/tmdb%3Amovie%3A45745";
const out = "D:/code/platformApps-worktrees/rebuild/tools/.wupg-proof";
const widths = (process.env.WIDTHS ?? "390,768,1280").split(",").map(Number);
const browser = await chromium.launch({ channel: "msedge", headless: true });
const report: Record<string, unknown> = {};
for (const width of widths) {
  const context = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 900 } });
  const page = await context.newPage();
  if (process.env.BEST_ONCE) {
    // Labelled visual fixture: the first title read is rewritten to carry a
    // bestAvailable result; every later read (after Check again) is real.
    let used = false;
    await (page as unknown as { route(u: (url: URL) => boolean, h: (r: Route) => Promise<void>): Promise<void> }).route(
      (url) => /\/api\/title\/[^/]+$/.test(url.pathname),
      async (route) => {
        if (used || route.request().method() !== "GET") return route.continue();
        used = true;
        const response = await route.fetch();
        const json = (await response.json()) as Record<string, unknown>;
        json.upgrade = null;
        json.bestAvailable = { resolution: 480, checkedAt: new Date(Date.now() - 2 * 3600_000).toISOString() };
        await route.fulfill({ response, json });
      },
    );
  }
  await page.goto(base + path, { waitUntil: "networkidle" });
  await page.waitForSelector("[data-title-owned], [data-episode-owned]", { timeout: 20000 });
  if (clickSel) {
    await page.click(clickSel, { timeout: 10000 });
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${out}/${name}-pending-${width}.png` });
    if (waitSel) await page.waitForSelector(waitSel, { timeout: 120000 });
    await page.waitForTimeout(600);
  }
  await page.screenshot({ path: `${out}/${name}-${width}.png` });
  report[width] = await page.evaluate((sel: string) => {
    const nodes = Array.from(document.querySelectorAll(sel));
    return nodes.map((n) => ({
      text: (n as HTMLElement).innerText,
      buttons: Array.from(n.querySelectorAll("button")).map((b) => ({
        label: b.getAttribute("aria-label"),
        h: Math.round(b.getBoundingClientRect().height),
        w: Math.round(b.getBoundingClientRect().width),
      })),
    }));
  }, "[data-title-owned], [data-owned-quality], [data-season-progress], [data-season-upgrade]");
  await context.close();
}
await browser.close();
console.log(JSON.stringify(report, null, 1));
