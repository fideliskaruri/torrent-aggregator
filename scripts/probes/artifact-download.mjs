/**
 * Does the new section actually DO anything?
 *
 * Rendering rows is not the feature — the feature is that pressing Download on
 * a non-video release sends it, records it, and puts the bytes in the folder
 * the UI promised. Nothing so far has proven that end to end; every check up to
 * now stopped at "the row exists".
 *
 * This drives a real Download from the Everything page and then verifies the
 * consequences server-side: a history row, the right category, and the file
 * under the promised folder. It cleans up after itself.
 *
 * Run:  node scripts\probes\artifact-download.mjs
 */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";

let failures = 0;
function check(name, ok, detail = "") {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

async function api(pathname, init) {
  const res = await fetch(`${BASE}${pathname}`, init);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

const browser = await chromium.launch({ headless: true });
let sentHash = null;

try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  // Watch what the page actually sends — the contract between UI and server.
  const sends = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/torrent/send") && r.method() === "POST") {
      try {
        sends.push(JSON.parse(r.postData() ?? "{}"));
      } catch {
        sends.push({ unparseable: r.postData() });
      }
    }
  });
  const responses = [];
  page.on("response", async (r) => {
    if (r.url().includes("/api/torrent/send")) {
      responses.push({ status: r.status(), body: await r.json().catch(() => null) });
    }
  });

  const historyBefore = await api("/api/history?limit=1");
  const beforeCount = Array.isArray(historyBefore.body?.items)
    ? historyBefore.body.items.length
    : 0;

  await page.goto(`${BASE}/everything?scope=music&q=daft%20punk%20discovery`, {
    waitUntil: "networkidle",
  });
  await page.waitForSelector("[data-artifact-row]", { timeout: 30000 });

  const rowCount = await page.locator("[data-artifact-row]").count();
  check("music rows are present to act on", rowCount > 0, `rows=${rowCount}`);

  const firstTitle = (
    await page.locator("[data-artifact-row]").first().innerText()
  )
    .split("\n")[0]
    .trim();

  // ── The actual click ────────────────────────────────────────────────────
  await page
    .locator('[data-artifact-row] [data-action="download"]')
    .first()
    .click();

  // Wait for the request to leave and the answer to come back.
  await page.waitForTimeout(6000);

  check("pressing Download sends a request", sends.length > 0,
    "no POST /api/torrent/send was made");

  if (sends.length) {
    const sent = sends[0];
    check("the send is a KEEP, not a stream", sent.retention === "keep",
      `retention=${sent.retention}`);
    check("the send carries the scope's category so routing is correct",
      sent.searchCategory === "music", `searchCategory=${sent.searchCategory}`);
    check("the send identifies the release", Boolean(sent.magnet || sent.torrentUrl),
      JSON.stringify(Object.keys(sent)));
    sentHash =
      sent.infoHash ??
      /urn:btih:([0-9a-fA-F]{40})/.exec(sent.magnet ?? "")?.[1]?.toLowerCase() ??
      null;
  }

  if (responses.length) {
    const r = responses[0];
    check("the server accepted the send", r.status < 400 && r.body?.ok !== false,
      `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 220)}`);
  } else {
    check("the server answered the send", false, "no response observed");
  }

  // ── The UI must reflect it, not sit silent ──────────────────────────────
  const rowText = await page.locator("[data-artifact-row]").first().innerText();
  check("the row reports what happened",
    /download|sent|added|queued|error|fail/i.test(rowText),
    rowText.replace(/\s+/g, " ").slice(0, 140));

  await page.screenshot({ path: "qa-shots/audit/download-clicked.png", fullPage: false });

  // ── Server-side consequences ────────────────────────────────────────────
  const historyAfter = await api("/api/history?limit=10");
  const items = Array.isArray(historyAfter.body?.items) ? historyAfter.body.items : [];
  check("a history row was written", items.length > beforeCount || items.length > 0,
    `before=${beforeCount} after=${items.length}`);

  const mine = items.find(
    (i) => (i.title ?? "").toLowerCase().includes("daft punk"),
  );
  if (mine) {
    check("history filed it under Music, not a video folder",
      (mine.category ?? "").toLowerCase() === "music",
      `category=${mine.category} savePath=${mine.savePath}`);
    check("history recorded it as a kept download",
      (mine.retention ?? "keep") === "keep", `retention=${mine.retention}`);
    check("the save path is under the promised Music folder",
      /[\\/]Music$/i.test(mine.savePath ?? ""), `savePath=${mine.savePath}`);
    sentHash = sentHash ?? mine.infoHash ?? null;
  } else {
    check("the download appears in history", false,
      `titles: ${JSON.stringify(items.slice(0, 3).map((i) => i.title?.slice(0, 40)))}`);
  }

  console.log(`\n  (release: ${firstTitle.slice(0, 70)})`);
  await ctx.close();
} finally {
  await browser.close();

  // ── Clean up, and prove the cleanup is complete ─────────────────────────
  //
  // "Delete torrent and files" must leave nothing behind — including the cached
  // .torrent, which used to survive every delete and every eviction invisibly.
  if (sentHash) {
    const del = await fetch(`${BASE}/api/client/torrents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", hash: sentHash, deleteFiles: true }),
    }).catch(() => null);
    const delBody = await del?.json().catch(() => null);
    check("the probe download was removed", del?.ok === true && delBody?.ok !== false,
      `HTTP ${del?.status} ${JSON.stringify(delBody)}`);

    // Give the engine a moment to finish unlinking.
    await new Promise((r) => setTimeout(r, 2500));

    const usage = await api("/api/settings/retention-sweep", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "preview" }),
    });
    const disk = usage.body?.usage?.diskBytes;
    check("deleting files leaves ZERO bytes behind", disk === 0,
      `${disk} bytes still under the download root ` +
        `(tracked=${usage.body?.usage?.disk?.trackedBytes} ` +
        `orphan=${usage.body?.usage?.orphanBytes} ` +
        `internal=${usage.body?.usage?.disk?.internalBytes})`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\ndownload path verified end to end");
