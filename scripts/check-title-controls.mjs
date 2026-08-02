/**
 * Title-page control truth, in a real browser.
 *
 * Two claims are checked, both of which unit tests cannot reach because they
 * are about what the assembled page *renders*:
 *
 *  1. No target ever exposes two Download affordances at once. The primary
 *     control and the secondary Download used to be able to appear together,
 *     and a title mid-download used to offer Download beside the running
 *     transfer because the detail route never read title-scope state.
 *
 *  2. A series with no known episodes does not claim S01E01. The old page
 *     rendered "Play S01E01" above an episode list that said there were no
 *     episodes — two contradictory statements from one payload.
 *
 * Navigates by clicking real cards rather than constructing URLs, so the work
 * keys exercised are the ones the app actually links to.
 */
import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE ?? "http://127.0.0.1:3100";
const MAX_TITLES = Number(process.env.PROBE_TITLES ?? 6);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

await page.goto(BASE, { waitUntil: "networkidle", timeout: 45_000 });

const hrefs = await page.$$eval('a[href^="/title/"]', (as) =>
  [...new Set(as.map((a) => a.getAttribute("href")).filter(Boolean))],
);

if (hrefs.length === 0) {
  console.error("No title links on Browse — cannot probe. Is the catalog empty?");
  await browser.close();
  process.exit(1);
}

let failures = 0;
const seen = [];

for (const href of hrefs.slice(0, MAX_TITLES)) {
  consoleErrors.length = 0;
  // Not `networkidle`: a title page keeps talking to the server (swarm probes,
  // episode metadata, artwork), so idle never arrives and a timeout here would
  // look like a page failure when the page is fine. Wait for the control this
  // probe is actually about instead.
  await page.goto(`${BASE}${href}`, {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });
  await page
    .waitForSelector("[data-title-primary], [data-title-hero]", { timeout: 30_000 })
    .catch(() => {});
  await page.waitForTimeout(1500);

  const state = await page.evaluate(() => {
    const primary = document.querySelector("[data-title-primary]");
    const download = document.querySelector("[data-title-download]");
    const transfer = document.querySelector("[data-title-transfer]");
    const text = (el) => (el ? (el.textContent ?? "").replace(/\s+/g, " ").trim() : null);
    return {
      primaryKind: primary?.getAttribute("data-action-kind") ?? null,
      primaryText: text(primary),
      primaryDisabled: primary ? primary.hasAttribute("disabled") : null,
      downloadPresent: Boolean(download),
      downloadText: text(download),
      transferStatus: transfer?.getAttribute("data-transfer-status") ?? null,
      transferText: text(transfer),
      bodyText: (document.body.textContent ?? "").replace(/\s+/g, " "),
      episodeRows: document.querySelectorAll("[data-episode-row]").length,
    };
  });

  const problems = [];

  // (1) Two Download affordances at once.
  const primaryIsDownload =
    state.primaryKind === "get" || /download/i.test(state.primaryText ?? "");
  if (primaryIsDownload && state.downloadPresent) {
    problems.push(
      `two Download controls: primary="${state.primaryText}" secondary="${state.downloadText}"`,
    );
  }

  // (1b) A live transfer must not sit beside an enabled Download.
  if (
    state.transferStatus &&
    ["queued", "downloading", "downloaded"].includes(state.transferStatus) &&
    state.downloadPresent
  ) {
    problems.push(
      `transfer is ${state.transferStatus} but a Download control is still rendered`,
    );
  }

  // (2) An invented first episode.
  const claimsS01E01 = /S01E01/i.test(state.primaryText ?? "");
  const saysNoEpisodes = /no episodes|episodes have not/i.test(state.bodyText);
  if (claimsS01E01 && (saysNoEpisodes || state.episodeRows === 0)) {
    problems.push(
      `claims S01E01 with ${state.episodeRows} episode rows rendered`,
    );
  }

  if (consoleErrors.length) {
    problems.push(...consoleErrors.map((e) => `console: ${e.slice(0, 140)}`));
  }

  seen.push({ href, state, problems });
  if (problems.length) failures++;
}

for (const { href, state, problems } of seen) {
  const tag = `${href} [${state.primaryKind ?? "no-primary"}${
    state.transferStatus ? ` / ${state.transferStatus}` : ""
  }]`;
  if (problems.length) {
    console.log(`FAIL  ${tag}`);
    for (const p of problems) console.log(`        ${p}`);
  } else {
    console.log(`ok    ${tag}  primary="${state.primaryText}"`);
  }
}

console.log(
  failures === 0
    ? `\nTITLE CONTROLS OK — ${seen.length} titles`
    : `\n${failures} of ${seen.length} titles failed`,
);

await browser.close();
process.exit(failures === 0 ? 0 : 1);
