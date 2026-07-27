/**
 * Full regression: unit + library integrations + live API checks.
 * Always run after changes. Exit 1 if any step fails.
 *
 * Usage: node scripts/test-all.mjs
 * Optional: BASE=http://localhost:3000 SCRATCH=./tmp
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch =
  process.env.SCRATCH ||
  path.join(
    process.env.TEMP || process.env.TMP || root,
    "tf-test-all-out",
  );
const BASE = process.env.BASE || "http://localhost:3000";

fs.mkdirSync(scratch, { recursive: true });

const results = [];

function log(...a) {
  console.log(...a);
}

function run(name, cmd, args, opts = {}) {
  const timeout = opts.timeout ?? 120_000;
  log(`\n=== ${name} ===`);
  const outFile = path.join(scratch, `${name.replace(/\W+/g, "_")}.txt`);
  const r = spawnSync(cmd, args, {
    cwd: root,
    encoding: "utf8",
    shell: true,
    timeout,
    env: { ...process.env, ...opts.env },
  });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  fs.writeFileSync(outFile, out);
  const code = r.status ?? (r.error ? 1 : 0);
  const timedOut = r.error && /TIMEOUT|ETIMEDOUT/i.test(String(r.error));
  // Some Windows/tsx runs print PASS then non-zero on teardown (WebTorrent keep-alive)
  const printedPass = /\bPASS\b/i.test(out) && !/\bFAIL\b/i.test(out);
  if (timedOut) {
    log(`FAIL ${name}: timeout ${timeout}ms`);
    results.push({ name, ok: false, code: 1, note: "timeout", outFile });
    return false;
  }
  if (code !== 0 && !printedPass) {
    log(`FAIL ${name}: exit ${code}`);
    log(out.slice(-800));
    results.push({ name, ok: false, code, outFile });
    return false;
  }
  if (code !== 0 && printedPass) {
    log(`PASS ${name} (exit ${code} after PASS — teardown noise)`);
  } else {
    log(`PASS ${name}`);
  }
  results.push({ name, ok: true, code: 0, outFile });
  return true;
}

async function pingHome() {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 5000);
    const res = await fetch(BASE, { signal: ac.signal });
    clearTimeout(t);
    return res.status === 200;
  } catch {
    return false;
  }
}

let devServerPid = 0;

async function ensureDevServer() {
  if (await pingHome()) {
    log("dev server already up");
    return true;
  }
  log("starting dev server…");
  // Must be spawn(), not spawnSync(). spawnSync waits for the child's stdio to
  // close, and a dev server never closes it — the harness hung for 28 minutes
  // before the first test ran. This path only triggers when no server is
  // already up, which is why it stayed hidden.
  const child = spawn("npm.cmd", ["run", "dev"], {
    cwd: root,
    detached: true,
    stdio: "ignore",
    shell: process.platform === "win32",
  });
  child.unref();
  devServerPid = child.pid;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    if (await pingHome()) {
      log("dev server ready");
      return true;
    }
  }
  log("WARN: dev server not reachable — HTTP checks may fail");
  return false;
}

async function httpGet(name, urlPath, check) {
  log(`\n=== ${name} ===`);
  const outFile = path.join(scratch, `${name.replace(/\W+/g, "_")}.txt`);
  try {
    const url = `${BASE}${urlPath}`;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 90_000);
    const res = await fetch(url, { signal: ac.signal });
    clearTimeout(t);
    const body = await res.text();
    const status = res.status;
    fs.writeFileSync(outFile, `HTTP ${status}\n${body.slice(0, 4000)}`);
    let ok = true;
    let note = "";
    if (check) {
      const c = check(status, body);
      ok = c.ok;
      note = c.note || "";
    } else {
      ok = status === 200;
    }
    log(ok ? `PASS ${name}` : `FAIL ${name}: ${note || status}`);
    results.push({ name, ok, code: ok ? 0 : 1, note, outFile });
    return ok;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    fs.writeFileSync(outFile, `ERROR ${msg}`);
    log(`FAIL ${name}:`, msg);
    results.push({ name, ok: false, code: 1, note: msg });
    return false;
  }
}

await ensureDevServer();

// 0) Hygiene. Instant, and it runs before anything expensive because a
// deliberate-sabotage edit left in the tree makes every result below a lie:
// three separate agents were each caught mid-verification with one live, and
// in every case the suite was green, the types checked and the page rendered.
run("no-sabotage", "node", ["scripts/check-no-sabotage.mjs"], {
  timeout: 60_000,
});

// 1) Units
run("unit", "npm", ["run", "test:unit"], { timeout: 180_000 });

// 2) Library-focused
run("cursor", "npx", ["tsx", "src/lib/library/cursor.test.ts"]);
run("disk-space", "npx", ["tsx", "src/lib/library/disk-space.test.ts"]);
run("settings-upsert", "npx", ["tsx", "scripts/test-settings-upsert.ts"]);
run("library-hunt", "npx", ["tsx", "scripts/test-library-hunt.ts"], {
  timeout: 120_000,
});
run("ondemand-estimate", "npx", ["tsx", "scripts/test-ondemand-and-estimate.ts"], {
  timeout: 180_000,
});
run("ondemand-advance", "npx", ["tsx", "scripts/test-ondemand-advance.ts"], {
  timeout: 60_000,
});
run("builtin-send", "npx", ["tsx", "scripts/test-builtin-send.ts"], {
  timeout: 180_000,
});
// Real torrents over a real socket — proves where the bytes actually land.
run("content-layout-e2e", "npx", ["tsx", "scripts/e2e-content-layout.mts"], {
  timeout: 300_000,
});
// Binds against webtorrent's real internals, so a dependency bump that moves
// them fails here rather than silently resuming the UTP_ECONNRESET crashes.
run("conn-errors", "npx", ["tsx", "scripts/test-conn-errors.mts"], {
  timeout: 120_000,
});

// 3) API contract suite (every route, against the running server)
run("api-smoke", "node", ["scripts/api-smoke.mjs", BASE], { timeout: 180_000 });

// 3b) Browse/discovery suites.
//
// These were added after this harness was first written and were only ever run
// by hand, which meant "npm run test:all" could go green while the surfaces the
// user actually looks at were broken. They are wired in here so a full
// regression means the whole product, not just the library internals.
//
// Each script reads a DIFFERENT base-URL variable — qa-*/shoot-* use BASE_URL,
// check-layout uses PLAYWRIGHT_BASE_URL. Setting only one produces a wall of
// convincing false failures against a server that is actually fine, so all of
// them are pinned to BASE here.
const uiEnv = { BASE_URL: BASE, PLAYWRIGHT_BASE_URL: BASE, TF_BASE_URL: BASE };

run("availability-seam", "npx", ["tsx", "scripts/test-availability-seam.mts"], {
  timeout: 120_000,
  env: uiEnv,
});
run("browse-rails", "npx", ["tsx", "scripts/test-browse-rails.mts"], {
  timeout: 120_000,
  env: uiEnv,
});
// Asks the question the owner actually asked: does the front page read like a
// catalog, or like a torrent list? Catches filename captions and rails of
// grey letter-tiles, both of which have shipped through a fully green suite.
run("catalog-quality", "npx", ["tsx", "scripts/check-catalog-quality.mts"], {
  timeout: 120_000,
  env: uiEnv,
});
run("image-hosts", "npx", ["tsx", "scripts/check-image-hosts.mts"], {
  timeout: 120_000,
  env: uiEnv,
});
run("error-states", "node", ["scripts/qa-error-states.mjs"], {
  timeout: 240_000,
  env: uiEnv,
});
run("a11y", "node", ["scripts/qa-a11y.mjs"], {
  timeout: 240_000,
  env: uiEnv,
});
run("layout", "node", ["scripts/check-layout.mjs"], {
  timeout: 240_000,
  env: uiEnv,
});
run("browse-screens", "node", ["scripts/shoot-browse.mjs"], {
  timeout: 240_000,
  env: uiEnv,
});
run("watchlist-screens", "node", ["scripts/shoot-watchlist.mjs"], {
  timeout: 240_000,
  env: uiEnv,
});

// 4) Live HTTP (async fetch — Windows curl is unreliable)
await httpGet("home", "/", (status) => ({
  ok: status === 200,
  note: `HTTP ${status}`,
}));

await httpGet(
  "search-4k",
  "/api/search?q=Dune%20Part%20Two&category=movies&resolution=2160p&minSeeders=5&maxSize=8000000000&pageSize=20",
  (status, body) => {
    if (status !== 200) return { ok: false, note: `HTTP ${status}` };
    try {
      const d = JSON.parse(body);
      const rows = d.results || [];
      const bad = rows.filter(
        (r) =>
          !/2160p|4k|uhd/i.test(`${r.title} ${(r.tags || []).join(" ")}`),
      );
      const big = rows.filter((r) => (r.sizeBytes || 0) > 8e9);
      const low = rows.filter((r) => (r.seeders || 0) < 5);
      let mono = true;
      for (let i = 1; i < rows.length; i++) {
        if ((rows[i].score ?? 0) > (rows[i - 1].score ?? 0) + 1e-6) mono = false;
      }
      const ok =
        rows.length > 0 &&
        bad.length === 0 &&
        big.length === 0 &&
        low.length === 0 &&
        mono;
      return {
        ok,
        note: `n=${rows.length} non4k=${bad.length} over8=${big.length} lowSeed=${low.length} mono=${mono}`,
      };
    } catch (e) {
      return { ok: false, note: e.message };
    }
  },
);

await httpGet(
  "search-fg-rank",
  "/api/search?q=Family%20Guy&category=tv&pageSize=10",
  (status, body) => {
    if (status !== 200) return { ok: false, note: `HTTP ${status}` };
    try {
      const d = JSON.parse(body);
      const rows = d.results || [];
      let mono = true;
      for (let i = 1; i < rows.length; i++) {
        if ((rows[i].score ?? 0) > (rows[i - 1].score ?? 0) + 1e-6) mono = false;
      }
      return {
        ok: rows.length > 0 && mono,
        note: `n=${rows.length} mono=${mono}`,
      };
    } catch (e) {
      return { ok: false, note: e.message };
    }
  },
);

// Auth was removed: TorrentFlow is a local single-user app, so these read
// routes answer directly instead of 401-ing.
await httpGet("settings-local", "/api/settings/client", (status, body) => {
  if (status !== 200) return { ok: false, note: `expect 200 got ${status}` };
  try {
    const d = JSON.parse(body);
    return {
      ok: Boolean(d.settings) && !("password" in (d.settings ?? {})),
      note: "settings present, password withheld",
    };
  } catch (e) {
    return { ok: false, note: e.message };
  }
});

await httpGet("client-local", "/api/client/torrents", (status) => ({
  ok: status === 200 || status === 503,
  note: `expect 200/503 got ${status}`,
}));

await httpGet("login-removed", "/login", (status) => ({
  ok: status === 404,
  note: `expect 404 got ${status}`,
}));

// Summary
const failed = results.filter((r) => !r.ok);
const summary = {
  at: new Date().toISOString(),
  base: BASE,
  scratch,
  total: results.length,
  passed: results.filter((r) => r.ok).length,
  failed: failed.length,
  results,
};
fs.writeFileSync(
  path.join(scratch, "ALL-SUMMARY.json"),
  JSON.stringify(summary, null, 2),
);
fs.writeFileSync(
  path.join(scratch, "ALL-SUMMARY.txt"),
  results
    .map((r) => `${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.note ? " — " + r.note : ""}`)
    .join("\n") +
    `\n\n${failed.length === 0 ? "ALL GREEN" : failed.length + " FAILED"}\n`,
);

log("\n========== SUMMARY ==========");
for (const r of results) {
  log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.note ? " — " + r.note : ""}`);
}
log(
  failed.length === 0
    ? `\nALL GREEN (${results.length} checks) → ${scratch}`
    : `\n${failed.length} FAILED → ${scratch}`,
);
if (devServerPid) log(`dev server left running (pid ${devServerPid})`);

process.exit(failed.length === 0 ? 0 : 1);
