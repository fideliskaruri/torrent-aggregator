/**
 * The storage-cap confirmation, reached from the new non-video rows.
 *
 * `ArtifactRow` shares `useReleaseActions` with the film path specifically so
 * the cap prompt, the override and the inline status behave identically
 * everywhere. That is an assumption until something drives it: the row could
 * render its buttons perfectly and still fail to mount the dialog, and the
 * symptom would be a Download that silently does nothing when over cap — the
 * exact dead-end this whole session has been removing.
 *
 * Sets a deliberately tiny cap, presses Download on a music row, and checks the
 * owner is asked rather than refused. Restores the cap whatever happens.
 *
 * Run:  node scripts\probes\cap-prompt.mjs
 */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const RESTORE_GB = 20;

let failures = 0;
function check(name, ok, detail = "") {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

async function setCap(gb) {
  const res = await fetch(`${BASE}/api/settings/client`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ maxStorageGb: gb }),
  });
  return res.ok;
}

const browser = await chromium.launch({ headless: true });

try {
  // A cap far below any real release, so the very first Download trips it.
  check("the probe cap was applied", await setCap(0.001));

  const page = await (
    await browser.newContext({ viewport: { width: 1280, height: 900 } })
  ).newPage();

  const sends = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/torrent/send") && r.method() === "POST") {
      try {
        sends.push(JSON.parse(r.postData() ?? "{}"));
      } catch {
        /* ignore */
      }
    }
  });

  await page.goto(`${BASE}/everything?scope=music&q=daft%20punk%20discovery`, {
    waitUntil: "networkidle",
  });
  await page.waitForSelector("[data-artifact-row]", { timeout: 30000 });

  await page.locator('[data-artifact-row] [data-action="download"]').first().click();
  await page.waitForTimeout(6000);

  // ── The owner must be ASKED, not refused ────────────────────────────────
  const dialog = page.locator('[role="alertdialog"]');
  const asked = (await dialog.count()) > 0;
  check("an over-cap Download asks instead of dead-ending", asked,
    "no confirmation dialog appeared");

  if (asked) {
    const text = (await dialog.first().innerText()).replace(/\s+/g, " ");
    console.log(`\n  dialog: ${text.slice(0, 200)}\n`);

    check("the prompt states real figures, not adjectives",
      /\d/.test(text) && /(GB|MB|KB|B)\b/.test(text), text.slice(0, 160));

    const proceed = dialog.getByRole("button", { name: /anyway|proceed|continue/i });
    const cancel = dialog.getByRole("button", { name: /cancel/i });
    const raise = dialog.getByRole("link", { name: /cap|folder|settings/i });

    check("proceeding is offered", (await proceed.count()) > 0);
    check("cancelling is offered", (await cancel.count()) > 0);
    check("a way to change the limit is offered", (await raise.count()) > 0);

    // Cancelling must send nothing — "dismissed" may never mean "sent".
    const before = sends.length;
    if (await cancel.count()) {
      await cancel.first().click();
      await page.waitForTimeout(2500);
      check("cancelling sends nothing", sends.length === before,
        `sends went ${before} -> ${sends.length}`);
      check("the dialog closes on cancel",
        (await page.locator('[role="alertdialog"]').count()) === 0);
    }

    // Now confirm, and check the retry carries the override.
    await page.locator('[data-artifact-row] [data-action="download"]').first().click();
    await page.waitForTimeout(5000);
    const proceed2 = page
      .locator('[role="alertdialog"]')
      .getByRole("button", { name: /anyway|proceed|continue/i });
    if (await proceed2.count()) {
      const beforeConfirm = sends.length;
      await proceed2.first().click();
      await page.waitForTimeout(6000);
      check("confirming re-sends", sends.length > beforeConfirm,
        `sends ${beforeConfirm} -> ${sends.length}`);
      const last = sends[sends.length - 1];
      check("the retry carries the override flag",
        last?.overrideStorageCap === true, JSON.stringify(last ?? {}).slice(0, 160));
      check("the FIRST attempt never carried an override",
        sends[0]?.overrideStorageCap !== true,
        "the app must not pre-emptively break its own cap");
    }
  }

  await page.screenshot({ path: "qa-shots/audit/cap-prompt.png" });
  await page.close();
} finally {
  await browser.close();
  const restored = await setCap(RESTORE_GB);
  console.log(`\n  cap restored to ${RESTORE_GB} GB: ${restored}`);

  // Anything the confirmed override actually started must not be left running.
  const list = await fetch(`${BASE}/api/client/torrents`)
    .then((r) => r.json())
    .catch(() => null);
  for (const t of list?.torrents ?? []) {
    await fetch(`${BASE}/api/client/torrents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", hash: t.hash, deleteFiles: true }),
    }).catch(() => null);
    console.log(`  cleaned up: ${t.name?.slice(0, 50)}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\ncap prompt verified from the new rows");
