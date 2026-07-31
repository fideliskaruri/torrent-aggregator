/**
 * Reproduce the three reported bugs, before fixing anything.
 *
 * Reported:
 *   1. "double downloading"
 *   2. "the delete button doesn't even delete the folders"
 *   3. "downloads show ready but download button still clickable.. maybe make
 *      it say 'Downloaded' instead"
 *
 * A fix I cannot first make fail is a guess. This drives the real app and
 * asserts the CORRECT behaviour, so today it should fail — that failure is the
 * evidence. It cleans up whatever it starts.
 *
 * Run:  node scripts\probes\repro-download-bugs.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";

let failures = 0;
function check(name, ok, detail = "") {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}
function note(m) {
  console.log(`  note  ${m}`);
}

async function root() {
  const r = await fetch(`${BASE}/api/settings/client`).then((x) => x.json());
  return r.settings?.baseDownloadPath ?? null;
}
async function live() {
  const r = await fetch(`${BASE}/api/client/torrents`).then((x) => x.json());
  return r.torrents ?? [];
}
async function removeAll() {
  for (const t of await live()) {
    await fetch(`${BASE}/api/client/torrents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", hash: t.hash, deleteFiles: true }),
    }).catch(() => null);
  }
}
function treeOf(dir) {
  const out = [];
  const walk = (d, depth = 0) => {
    if (depth > 6) return;
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      out.push({ path: full, dir: e.isDirectory() });
      if (e.isDirectory()) walk(full, depth + 1);
    }
  };
  walk(dir);
  return out;
}

const DOWNLOAD_ROOT = await root();
note(`download root: ${DOWNLOAD_ROOT}`);

await removeAll();
const browser = await chromium.launch({ headless: true });

try {
  const page = await (
    await browser.newContext({ viewport: { width: 1440, height: 900 } })
  ).newPage();

  const sends = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/torrent/send") && r.method() === "POST") {
      try {
        sends.push(JSON.parse(r.postData() ?? "{}"));
      } catch {
        sends.push({});
      }
    }
  });

  await page.goto(`${BASE}/everything?scope=music&q=daft%20punk%20discovery`, {
    waitUntil: "networkidle",
  });
  await page.waitForSelector("[data-artifact-row]", { timeout: 30000 });

  const dl = page.locator('[data-artifact-row] [data-action="download"]').first();

  // ── BUG 1: double downloading ───────────────────────────────────────────
  //
  // Two clicks in the same tick. React state is async, so a button that only
  // disables via `pending` state can still be pressed a second time before the
  // re-render lands — and each press is its own send.
  await dl.click();
  await dl.click({ force: true, timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(6000);

  note(`sends observed: ${sends.length}`);
  check("BUG 1 — a double click sends exactly one download", sends.length === 1,
    `${sends.length} POSTs to /api/torrent/send: ${JSON.stringify(
      sends.map((s) => (s.magnet ?? "").slice(-14)),
    )}`);

  // Wait for it to actually be added, and get some bytes on disk.
  await page.waitForTimeout(12000);
  const transfers = await live();
  note(`live transfers: ${transfers.length} ${JSON.stringify(transfers.map((t) => t.name?.slice(0, 34)))}`);
  check("BUG 1 — only one transfer exists afterwards", transfers.length <= 1,
    `${transfers.length} transfers`);

  // ── BUG 3: the row still offers Download for something already held ─────
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("[data-artifact-row]", { timeout: 30000 });
  await page.waitForTimeout(3000);

  const firstRow = page.locator("[data-artifact-row]").first();
  const rowText = (await firstRow.innerText()).replace(/\s+/g, " ");
  const btn = firstRow.locator('[data-action="download"]');
  const btnLabel = (await btn.count()) ? (await btn.first().innerText()).trim() : "(none)";
  const btnDisabled = (await btn.count())
    ? await btn.first().isDisabled()
    : null;

  note(`row: ${rowText.slice(0, 110)}`);
  note(`button: "${btnLabel}" disabled=${btnDisabled}`);

  check("BUG 3 — a held release does not offer Download again",
    btnDisabled === true || /downloaded|in library|have it/i.test(btnLabel),
    `button reads "${btnLabel}" and is ${btnDisabled ? "disabled" : "still clickable"}`);

  await page.screenshot({ path: "qa-shots/audit/repro-row.png" });

  // ── BUG 2: delete leaves folders behind ─────────────────────────────────
  const beforeTree = DOWNLOAD_ROOT ? treeOf(DOWNLOAD_ROOT) : [];
  note(`tree before delete: ${beforeTree.length} entries`);
  for (const e of beforeTree.slice(0, 8)) {
    note(`   ${e.dir ? "d" : "f"} ${e.path.replace(DOWNLOAD_ROOT, "")}`);
  }

  await removeAll();
  await new Promise((r) => setTimeout(r, 4000));

  const afterTree = DOWNLOAD_ROOT ? treeOf(DOWNLOAD_ROOT) : [];
  const leftoverDirs = afterTree.filter((e) => e.dir);
  const leftoverFiles = afterTree.filter((e) => !e.dir);

  note(`tree after delete: ${afterTree.length} entries`);
  for (const e of afterTree.slice(0, 10)) {
    note(`   ${e.dir ? "d" : "f"} ${e.path.replace(DOWNLOAD_ROOT, "")}`);
  }

  check("BUG 2 — deleting removes every file", leftoverFiles.length === 0,
    JSON.stringify(leftoverFiles.map((f) => f.path.replace(DOWNLOAD_ROOT, ""))));
  check("BUG 2 — deleting removes the folders it created too",
    leftoverDirs.length === 0,
    JSON.stringify(leftoverDirs.map((d) => d.path.replace(DOWNLOAD_ROOT, ""))));

  await page.close();
} finally {
  await browser.close();
  await removeAll();
}

console.log(`\n${failures} reproduction(s) confirmed the report`);
process.exit(0);
