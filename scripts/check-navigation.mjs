/**
 * The navigation model, as actually rendered.
 *
 * `flow.test.ts` asserts the model offline. This asserts that the header and
 * the mobile bar agree with it in a browser, and that the routes it names
 * resolve — a model can be perfectly consistent and still point at a 404.
 *
 * The specific regressions guarded:
 *  - Client and Activity were renamed. Old links must still land somewhere,
 *    because both were header entries for the app's whole life.
 *  - The mobile bar holds five tabs at 390px. "Notifications" is 13 characters
 *    and truncates to a half-word if a sixth column is ever reintroduced.
 */
import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE ?? "http://127.0.0.1:3100";

const EXPECTED = ["Browse", "Library", "Downloads", "Notifications", "Settings"];

/** Old path -> where it must end up. */
const REDIRECTS = [
  ["/client", "/downloads"],
  ["/activity", "/notifications"],
];

const browser = await chromium.launch();
let failures = 0;
const fail = (m) => {
  failures++;
  console.log(`FAIL  ${m}`);
};
const ok = (m) => console.log(`ok    ${m}`);

// --- Desktop header -------------------------------------------------------
{
  const page = await (
    await browser.newContext({ viewport: { width: 1440, height: 900 } })
  ).newPage();
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(800);

  const labels = await page.$$eval("header nav a, header a[href]", (as) =>
    as
      .map((a) => (a.textContent ?? "").trim())
      .filter((t) => t.length > 0 && t.length < 24),
  );
  for (const want of EXPECTED) {
    if (labels.includes(want)) ok(`header shows ${want}`);
    else fail(`header is missing ${want} (saw: ${labels.join(", ")})`);
  }
  for (const gone of ["Client", "Activity", "Rules"]) {
    if (labels.includes(gone)) fail(`header still shows ${gone}`);
    else ok(`header no longer shows ${gone}`);
  }
  const density = await page.$("[data-density-toggle]");
  if (density) fail("the Compact density toggle is still in the header");
  else ok("Compact toggle is gone");
  await page.close();
}

// --- Redirects ------------------------------------------------------------
{
  const page = await (await browser.newContext()).newPage();
  for (const [from, to] of REDIRECTS) {
    await page.goto(`${BASE}${from}`, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    await page.waitForTimeout(600);
    const landed = new URL(page.url()).pathname;
    if (landed === to) ok(`${from} -> ${to}`);
    else fail(`${from} landed on ${landed}, expected ${to}`);
  }
  await page.close();
}

// --- Mobile bar -----------------------------------------------------------
{
  const page = await (
    await browser.newContext({ viewport: { width: 390, height: 844 } })
  ).newPage();
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(800);

  const tabs = await page.$$eval("[data-mobile-nav] a, [data-mobile-nav] button", (els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      const span = el.querySelector("span");
      return {
        label: (el.textContent ?? "").trim(),
        width: Math.round(r.width),
        height: Math.round(r.height),
        // Truncation shows up as the rendered text being narrower than the
        // text it claims to contain.
        truncated: span ? span.scrollWidth > span.clientWidth + 1 : false,
      };
    }),
  );

  if (tabs.length === EXPECTED.length) ok(`mobile bar has ${tabs.length} tabs`);
  else fail(`mobile bar has ${tabs.length} tabs, expected ${EXPECTED.length}: ${tabs.map((t) => t.label).join(", ")}`);

  for (const t of tabs) {
    if (t.truncated) fail(`mobile tab "${t.label}" is truncated at ${t.width}px`);
    // 44px is the documented minimum touch target.
    if (t.height < 44) fail(`mobile tab "${t.label}" is only ${t.height}px tall`);
  }
  if (!tabs.some((t) => t.truncated)) ok("no mobile tab label is truncated");
  if (tabs.every((t) => t.height >= 44)) ok("every mobile tab meets 44px");

  const more = await page.$("[data-mobile-more]");
  if (more) fail("a More tab is rendered though nothing was demoted to it");
  else ok("no empty More tab");
  await page.close();
}

console.log(failures === 0 ? "\nNAV OK" : `\n${failures} nav check(s) failed`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
