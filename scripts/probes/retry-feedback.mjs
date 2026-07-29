/**
 * Reproduces the owner's exact complaint: press "Try again" on the failed
 * Family Guy S01E02 row and record what the UI tells them.
 *
 * The static probe found zero error/status nodes on a fresh load, but that
 * proves nothing on its own — an error surface that only mounts after a failed
 * action would be invisible to it. The only honest way to know whether the app
 * reports the failure is to perform the failure.
 *
 * Safety: this presses a button the owner has already pressed three times. The
 * grab returns zero results and writes one `skipped` GrabJob row — the same
 * outcome as their own click. It adds no torrent and downloads no bytes.
 *
 * Usage: node scripts/probes/retry-feedback.mjs [baseUrl] [slug] [episodeLabel]
 */
import { chromium } from "playwright";

const BASE = process.argv[2] || "http://127.0.0.1:3000";
const SLUG = process.argv[3] || "family-guy";
const EPISODE = process.argv[4] || "S01E02";
const WAIT_MS = 45_000;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text().slice(0, 160));
});

// Snapshot every candidate "the app is telling me something" surface.
const snapshot = () =>
  page.evaluate(() => {
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) !== 0;
    };
    const sel =
      '[role="alert"], [role="status"], [data-error], [data-status-message], .text-destructive, [aria-live]';
    const nodes = Array.from(document.querySelectorAll(sel)).filter(isVisible);
    return {
      count: nodes.length,
      items: nodes.map((n) => ({
        role: n.getAttribute("role") || n.getAttribute("aria-live") || "class",
        text: (n.textContent || "").trim().slice(0, 120),
      })),
      // Any visible text anywhere that reads like a failure, even if it carries
      // no semantic role — a plain <p> is still a message to a human.
      failureText: Array.from(document.querySelectorAll("body *"))
        .filter(isVisible)
        .filter((el) => !Array.from(el.children).some((c) => isVisible(c)))
        .map((el) => (el.textContent || "").trim())
        .filter((t) => t && /fail|error|could ?n.t|unable|no .*found|try again|problem|sorry/i.test(t))
        .slice(0, 10),
    };
  });

let exitCode = 1;
let placementRecords = [];

try {
  await page.goto(`${BASE}/title/${SLUG}`, { waitUntil: "networkidle", timeout: 45_000 });
  await page.waitForTimeout(1500);

  const before = await snapshot();
  console.log(`BEFORE click — status/alert nodes: ${before.count}`);
  for (const i of before.items) console.log(`   [${i.role}] ${i.text}`);
  console.log(`BEFORE click — failure-shaped text: ${before.failureText.length}`);
  for (const t of before.failureText) console.log(`   "${t.slice(0, 100)}"`);

  // Find the row for the episode, then the action inside it.
  const row = page.locator(`text=${EPISODE}`).first();
  if ((await row.count()) === 0) {
    console.log(`\n! episode ${EPISODE} not found on the page`);
    process.exit(2);
  }
  const rowBox = await row.boundingBox();
  console.log(`\nepisode ${EPISODE} row at y=${Math.round(rowBox?.y ?? -1)}`);

  // The actionable control in that row: "Try again", else "Play".
  const container = row.locator("xpath=ancestor::*[self::li or self::div][1]");
  let btn = container.locator("button", { hasText: /try again/i }).first();
  let label = "Try again";
  if ((await btn.count()) === 0) {
    btn = container.locator("button", { hasText: /^play/i }).first();
    label = "Play";
  }
  if ((await btn.count()) === 0) {
    console.log("! no Try again / Play control inside that row");
    process.exit(2);
  }

  console.log(`clicking "${label}" …`);
  const btnBox = await btn.boundingBox();
  const t0 = Date.now();
  await btn.click();
  // Poll for any new message for the full window, so a late error still counts.
  let firstMessageMs = null;
  let last = before;
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    await page.waitForTimeout(500);
    const now = await snapshot();
    const grewNodes = now.count > before.count;
    const grewText = now.failureText.length > before.failureText.length;
    if ((grewNodes || grewText) && firstMessageMs === null) {
      firstMessageMs = Date.now() - t0;
      last = now;
      break;
    }
    last = now;
  }

  console.log(`\nAFTER click (${Math.round((Date.now() - t0) / 1000)}s observed)`);
  console.log(`  status/alert nodes: ${last.count}  (was ${before.count})`);
  for (const i of last.items) console.log(`   [${i.role}] ${i.text}`);
  console.log(`  failure-shaped text: ${last.failureText.length}  (was ${before.failureText.length})`);
  for (const t of last.failureText) console.log(`   "${t.slice(0, 100)}"`);
  console.log(`  first new message at: ${firstMessageMs === null ? "NEVER" : firstMessageMs + "ms"}`);

  // WHERE the message landed matters as much as whether it exists. "No error
  // messages here" is most often "the message rendered, but not where I was
  // looking" — so measure its distance from the control that was pressed, and
  // whether it is inside the viewport at all without scrolling.
  if (firstMessageMs !== null && btnBox) {
    const placement = await page.evaluate((clicked) => {      const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const cs = getComputedStyle(el);
        return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) !== 0;
      };
      const sel =
        '[role="alert"], [role="status"], [data-error], [data-status-message], .text-destructive, [aria-live]';
      const nodes = Array.from(document.querySelectorAll(sel)).filter(isVisible);
      return nodes.map((n) => {
        const r = n.getBoundingClientRect();
        return {
          text: (n.textContent || "").trim().slice(0, 80),
          y: Math.round(r.top),
          x: Math.round(r.left),
          dyFromClicked: Math.round(r.top - clicked.y),
          dxFromClicked: Math.round(r.left - clicked.x),
          inViewport: r.top >= 0 && r.bottom <= window.innerHeight,
          fontSize: getComputedStyle(n).fontSize,
          color: getComputedStyle(n).color,
        };
      });
    }, { x: btnBox.x, y: btnBox.y });

    console.log(`\n  WHERE the message rendered (clicked control was at x=${Math.round(btnBox.x)}, y=${Math.round(btnBox.y)}):`);
    placementRecords = placement;
    for (const p of placement) {
      console.log(
        `   "${p.text}"\n      at (${p.x},${p.y})  dx=${p.dxFromClicked}px dy=${p.dyFromClicked}px  inViewport=${p.inViewport}  ${p.fontSize} ${p.color}`,
      );
    }
  }
  console.log(`  console errors: ${consoleErrors.length}`);
  for (const e of consoleErrors.slice(0, 5)) console.log(`   ${e}`);

  /*
   * Press it a SECOND time. The owner's actual complaint was not "there is no
   * message" - it was "this outright fails each time.. it means we're not
   * picking another torrent for it if it fails?". So the product requirement is
   * that a retry does something DIFFERENT, and the only way to establish that
   * from outside is to retry and compare.
   *
   * Note deliberately what this does NOT accept: "the text changed" is too weak,
   * because appending a timestamp or a counter satisfies it while the app tries
   * the identical dead release again. What matters is whether the stated REASON
   * moved. So compare the message with digits, times and counters stripped.
   */
  const firstReason = last.failureText.join(" | ");
  let secondReason = null;
  let secondPressed = false;
  const retry = container.locator("button", { hasText: /try again|retry/i }).first();
  if (await retry.count()) {
    console.log(`\nsecond press of "Try again" — does the app try something different?`);
    await retry.click().catch(() => {});
    secondPressed = true;
    const deadline2 = Date.now() + Math.min(WAIT_MS, 25000);
    while (Date.now() < deadline2) {
      await page.waitForTimeout(500);
      const now = await snapshot();
      if (now.failureText.join(" | ") !== firstReason) { secondReason = now.failureText.join(" | "); break; }
      secondReason = now.failureText.join(" | ");
    }
    console.log(`  reason after 1st press: "${firstReason.slice(0, 120)}"`);
    console.log(`  reason after 2nd press: "${(secondReason ?? "").slice(0, 120)}"`);
  } else {
    console.log(`\n! no "Try again" control to press a second time — the user's only recourse is unavailable`);
  }

  // Strip volatile noise so a timestamp or attempt counter cannot masquerade as
  // a genuinely different outcome.
  const normalise = (s) => (s ?? "").toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
  const reasonChanged = secondPressed && normalise(secondReason) !== normalise(firstReason);

  const near = placementRecords.filter((p) => Math.abs(p.dyFromClicked) <= 120 && p.inViewport);
  const readable = placementRecords.filter((p) => parseFloat(p.fontSize) >= 13);

  console.log(`\n--- acceptance ---`);
  const checks = [
    ["the app says something when the action fails", firstMessageMs !== null],
    ["the message is within 120px of the control that failed, without scrolling", near.length > 0],
    ["the message is at least 13px (a failure is not fine print)", readable.length > 0],
    ["a Try again control exists", secondPressed],
    ["retrying changes the stated reason (not just the digits)", reasonChanged],
  ];
  for (const [name, ok] of checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);

  const ok = checks.every(([, v]) => v);
  console.log(
    `\nVERDICT: ${ok ? "PASS" : "FAIL"} — ${
      firstMessageMs === null
        ? "SILENT FAILURE — the user pressed the button and the app said nothing new."
        : "the app reported something after " + firstMessageMs + "ms"
    }`,
  );
  exitCode = ok ? 0 : 1;
} finally {
  await ctx.close();
  await browser.close();
}
process.exit(exitCode);
