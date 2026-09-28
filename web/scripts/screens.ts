// Headless screenshot sweep of the shared shells at the breakpoints that
// have broken before. Run against an isolated instance, never a live one:
//   PW_ROOT=<dir with playwright installed> BASE_URL=http://127.0.0.1:3940 \
//   SHOTS_DIR=<out dir> pnpm --dir web screens
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

type Page = {
  goto(url: string, opts?: { waitUntil?: string }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  screenshot(opts: { path: string; fullPage?: boolean }): Promise<unknown>;
  evaluate<T>(fn: () => T): Promise<T>;
  click(selector: string, opts?: { timeout?: number }): Promise<void>;
  close(): Promise<void>;
};
type Context = { newPage(): Promise<Page>; close(): Promise<void> };
type Browser = {
  newContext(opts: { viewport: { width: number; height: number }; deviceScaleFactor?: number }): Promise<Context>;
  close(): Promise<void>;
};
type Playwright = { chromium: { launch(opts: { channel?: string; headless: boolean }): Promise<Browser> } };

const pwRoot = process.env.PW_ROOT;
if (!pwRoot) throw new Error("Set PW_ROOT to a folder that has playwright installed");
const { chromium } = createRequire(join(pwRoot, "package.json"))("playwright") as Playwright;

const base = process.env.BASE_URL ?? "http://127.0.0.1:3940";
const out = process.env.SHOTS_DIR ?? "shots";
const widths = [390, 1024, 1240, 1440];
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: "msedge", headless: true });

async function titleHref(): Promise<string> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${base}/`, { waitUntil: "networkidle" });
  const href = await page.evaluate(
    () => document.querySelector<HTMLAnchorElement>('a[href^="/title/"]')?.getAttribute("href") ?? null,
  );
  await context.close();
  return href ?? "/title/tmdb-movie-603";
}

const routes: Array<[string, string]> = [
  ["browse", "/"],
  ["title", await titleHref()],
  ["downloads", "/downloads"],
  ["settings", "/settings"],
  ["requests", "/requests"],
];

const report: string[] = [];
for (const width of widths) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  for (const [name, path] of routes) {
    await page.goto(`${base}${path}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    const overflow = await page.evaluate(() => {
      const header = document.querySelector<HTMLElement>("[data-app-header] .container-app");
      const nav = document.querySelector<HTMLElement>("[data-desktop-nav]");
      return {
        page: document.documentElement.scrollWidth - window.innerWidth,
        header: header ? header.scrollWidth - header.clientWidth : 0,
        nav: nav && nav.offsetParent ? nav.scrollWidth - nav.clientWidth : 0,
        fold: nav?.getAttribute("data-header-fold") ?? "",
        nativeSelects: document.querySelectorAll("select:not([aria-hidden])").length,
      };
    });
    report.push(`${name}@${width} ${JSON.stringify(overflow)}`);
    await page.screenshot({ path: join(out, `${name}-${width}.png`) });
  }
  await context.close();
}
// The phone More sheet. The desktop More menu only appears when links overflow.
for (const [width, selector, name] of [
  [390, "[data-mobile-more]", "more-sheet-390"],
] as const) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${base}/downloads`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  try {
    await page.click(selector, { timeout: 5000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(out, `${name}.png`) });
  } catch (error) {
    report.push(`${name}: ${(error as Error).message.split("\n")[0]}`);
    await page.screenshot({ path: join(out, `${name}-failed.png`) });
  }
  await context.close();
}
await browser.close();
console.log(report.join("\n"));
