import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { access, copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createClient } from "@libsql/client";
import { createCases } from "./cases.mjs";
import { compare, markdown } from "./diff.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
const bases = { next: "http://127.0.0.1:3110", dotnet: "http://127.0.0.1:5110" };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function parseOptions(args) {
  const { values } = parseArgs({ args, options: {
    "no-next-build": { type: "boolean", default: false },
    only: { type: "string" }, db: { type: "string", default: "D:\\code\\torrent-aggregator\\dev.db" },
    help: { type: "boolean", default: false },
  } });
  return { ...values, filter: values.only ? new RegExp(values.only, "i") : null };
}

async function available(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", () => reject(new Error(`Port ${port} is occupied; refusing to touch its owner.`)));
    server.listen(port, "127.0.0.1", resolve);
  });
  await new Promise((resolve) => server.close(resolve));
}

function launch(command, args, env, logPath) {
  const log = createWriteStream(logPath);
  const child = spawn(command, args, { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  let launchError;
  const done = new Promise((resolve) => {
    child.once("error", (error) => { launchError = error.message; log.end(); resolve({ error: error.message }); });
    child.once("close", (code) => { log.end(); resolve({ code }); });
  });
  return { child, done, logPath, get error() { return launchError; } };
}

async function checked(command, args, env, logPath) {
  const proc = launch(command, args, env, logPath);
  const result = await proc.done;
  if (result.error || result.code !== 0)
    throw new Error(`${command} failed (${result.error ?? result.code}). See ${logPath}`);
}

async function stop(proc) {
  if (!proc?.child.pid || proc.child.exitCode !== null) return;
  if (process.platform === "win32") {
    // Stop only descendants of the child we own, never another development host.
    const script = `$ErrorActionPreference='Stop'; function Stop-Tree([int]$processId) { Get-CimInstance Win32_Process -Filter "ParentProcessId=$processId" | ForEach-Object { Stop-Tree $_.ProcessId }; Get-Process -Id $processId -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue }; Stop-Tree ${proc.child.pid}`;
    const killer = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, stdio: "ignore" });
    const [code] = await once(killer, "exit");
    if (code !== 0) throw new Error(`Could not stop owned process tree ${proc.child.pid}`);
  } else {
    proc.child.kill("SIGTERM");
  }
  await Promise.race([proc.done, sleep(10_000).then(() => { throw new Error(`Process ${proc.child.pid} did not exit`); })]);
}

async function ready(base, proc) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (proc.error || proc.child.exitCode !== null) throw new Error(`Host exited before ready: ${proc.error ?? proc.logPath}`);
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok && (await response.json()).ready === true) return;
    } catch { /* The host is still building/starting. */ }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${base}/api/health; see ${proc.logPath}`);
}

export async function snapshot(source, nextDb, dotnetDb, dataDir) {
  if ((await stat(source)).size < 512) throw new Error(`Source database is empty or invalid: ${source}`);
  const client = createClient({ url: pathToFileURL(source).href });
  try {
    // SQLite takes a consistent snapshot including committed WAL pages, unlike copyFile(source).
    await client.execute(`VACUUM INTO '${nextDb.replaceAll("'", "''")}'`);
  } finally { client.close(); }
  const db = createClient({ url: pathToFileURL(nextDb).href });
  try {
    const tables = new Set((await db.execute("SELECT name FROM sqlite_master WHERE type='table'")).rows.map((r) => r.name));
    for (const required of ["EngineTorrent", "ClientSettings", "Work", "WatchListItem"])
      if (!tables.has(required)) throw new Error(`Source is not a migrated TorrentFlow DB: missing ${required}`);
    async function update(table, values) {
      if (!tables.has(table)) return;
      const columns = new Set((await db.execute(`PRAGMA table_info("${table}")`)).rows.map((r) => r.name));
      const entries = Object.entries(values).filter(([key]) => columns.has(key));
      if (entries.length) await db.execute({
        sql: `UPDATE "${table}" SET ${entries.map(([key]) => `"${key}" = ?`).join(", ")}`,
        args: entries.map(([, value]) => value),
      });
    }
    await db.execute("UPDATE EngineTorrent SET status = 'paused' WHERE lower(status) NOT IN ('downloaded', 'finished', 'completed')");
    // Pausing alone does not protect external clients, retention sweeps, or engine
    // metadata rehydration. These changes apply identically to BOTH copies only.
    await update("ClientSettings", {
      clientType: "builtin", externalClientType: null, host: "http://127.0.0.1:1",
      username: null, password: null, automationIntervalMinutes: 0, preProbeScope: "off",
      savePath: dataDir, baseDownloadPath: dataDir, pathRules: "{}", maxStorageBytes: 0,
      storageCapConfigured: 0,
    });
    await update("EngineTorrent", {
      magnet: null, torrentUrl: null, savePath: dataDir, verifiedFilesJson: null,
      verifiedBitfield: null, verifiedAt: null, origin: "user", forcedAt: null,
      evictLease: null, evictFrom: null,
    });
    await update("AutoRule", { enabled: 0 });
    for (const table of ["GrabJob", "DownloadHistory"]) await update(table, { savePath: dataDir });
    await db.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally { db.close(); }
  await copyFile(nextDb, dotnetDb);
}

export async function request(base, c) {
  try {
    const response = await fetch(base + c.path, {
      method: c.method, redirect: "manual", signal: AbortSignal.timeout(45_000),
      headers: { accept: "application/json", ...(c.body !== undefined ? { "content-type": "application/json", origin: base } : {}) },
      ...(c.body !== undefined ? { body: JSON.stringify(c.body) } : {}),
    });
    const chunks = [];
    let size = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 8 * 1024 * 1024) throw new Error("Response exceeds parity harness 8 MiB limit");
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
    }
    const text = Buffer.concat(chunks).toString("utf8");
    const contentType = response.headers.get("content-type");
    let body = text;
    if (contentType?.includes("json") && text) body = JSON.parse(text);
    return { status: response.status, headers: {
      "content-type": contentType, "cache-control": response.headers.get("cache-control"),
    }, body };
  } catch (error) { return { error: error.message }; }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    console.log("node scripts/parity/run.mjs [--no-next-build] [--only <regex>] [--db <SQLite path>]");
    return;
  }
  await Promise.all([available(3110), available(5110), access(nextBin)]);
  const id = new Date().toISOString().replaceAll(/[:.]/g, "-") + `-${process.pid}`;
  const scratch = path.join("D:\\code\\memtest\\parity", id);
  const reportDir = path.join(root, "scripts", "parity", "reports", id);
  const nextDb = path.join(scratch, "next.db"), dotnetDb = path.join(scratch, "dotnet.db");
  const dataDir = path.join(scratch, "data");
  await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(reportDir, { recursive: true })]);
  const env = {
    ...process.env, NEXT_DIST_DIR: ".next-parity", DATABASE_URL: pathToFileURL(nextDb).href,
    CATALOG_TIMER: "0", NEXT_TELEMETRY_DISABLED: "1",
    PNPM_CONFIG_REGISTRY: "http://127.0.0.1:4873", PNPM_CONFIG_STORE_DIR: "D:\\code\\memtest\\pnpm-store",
    TorrentFlow__DatabasePath: dotnetDb, TorrentFlow__DataDirectory: dataDir,
  };
  const children = [];
  let cleaning;
  let restoreBuildConfig;
  const cleanup = () => cleaning ??= (async () => {
    await Promise.all(children.map(stop));
    await restoreBuildConfig?.();
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  })();
  const interrupt = () => { cleanup().then(() => process.exit(130), (error) => { console.error(error); process.exit(2); }); };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    await snapshot(path.resolve(options.db), nextDb, dotnetDb, dataDir);
    const db = createClient({ url: pathToFileURL(nextDb).href });
    let suite;
    try { suite = await createCases(root, db, { folder: dataDir, replacements: [[dataDir, "<isolated-data>"]] }); }
    finally { db.close(); }
    const cases = suite.cases.filter((c) => !options.filter || options.filter.test(`${c.method} ${c.route} ${c.path} ${c.label}`));
    if (!cases.length) throw new Error(`No cases match --only ${options.only}`);
    if (!options["no-next-build"]) {
      const tsconfig = path.join(root, "tsconfig.json");
      const original = await readFile(tsconfig, "utf8");
      await checked("git", ["diff", "--exit-code", "HEAD", "--", "tsconfig.json"], env, path.join(reportDir, "tsconfig-check.log"));
      let restored;
      restoreBuildConfig = () => restored ??= (async () => {
        await checked("git", ["checkout", "--", "tsconfig.json"], env, path.join(reportDir, "tsconfig-restore.log"));
        if (await readFile(tsconfig, "utf8") !== original) throw new Error("tsconfig.json restoration mismatch");
      })();
      try {
        console.log("Building Next in .next-parity...");
        const build = launch(process.execPath, [nextBin, "build"], env, path.join(reportDir, "next-build.log"));
        children.push(build);
        const result = await build.done;
        if (result.error || result.code !== 0) throw new Error(`Next build failed; see ${build.logPath}`);
      } finally {
        await restoreBuildConfig();
      }
    }
    await access(path.join(root, ".next-parity", "BUILD_ID"));
    await Promise.all([available(3110), available(5110)]);
    const next = launch(process.execPath, [nextBin, "start", "-H", "127.0.0.1", "-p", "3110"], env, path.join(reportDir, "next.log"));
    const dotnet = launch("dotnet", ["run", "-c", "Release", "--project", path.join("server", "TorrentFlow.Api"),
      "-p:SkipWebBuild=true", "--no-launch-profile", "--urls", bases.dotnet], env, path.join(reportDir, "dotnet.log"));
    children.push(next, dotnet);
    await Promise.all([ready(bases.next, next), ready(bases.dotnet, dotnet)]);
    const report = { generatedAt: new Date().toISOString(), routes: suite.routes, fixtures: suite.fixtures, results: [] };
    for (const c of cases) {
      const [left, right] = await Promise.all([request(bases.next, c), request(bases.dotnet, c)]);
      const result = { method: c.method, route: c.route, path: c.path, label: c.label, body: c.body, ...compare(c, left, right) };
      report.results.push(result);
      console.log(`${result.outcome.padEnd(10)} ${c.method} ${c.path}`);
      // Validation probes must never silently become successful mutations.
      if (c.method === "POST" && [left, right].some((r) => r.status >= 200 && r.status < 300))
        throw new Error(`Unsafe validation probe unexpectedly succeeded: ${c.path}`);
    }
    await writeFile(path.join(reportDir, "report.json"), JSON.stringify(report, null, 2));
    await writeFile(path.join(reportDir, "report.md"), markdown(report));
    console.log(`\nReport: ${path.join(reportDir, "report.md")}`);
    console.log(markdown(report).split("## Details")[0]);
    process.exitCode = report.results.some((r) => ["fail", "error"].includes(r.outcome)) ? 1 : 0;
  } catch (error) {
    await writeFile(path.join(reportDir, "failure.json"), JSON.stringify({ error: error.message }, null, 2));
    throw error;
  } finally {
    await cleanup();
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => { console.error(error); process.exitCode = 2; });
