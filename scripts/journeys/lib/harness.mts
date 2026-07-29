/**
 * Shared harness for the TorrentFlow user-journey suite.
 *
 * WHY THIS FILE EXISTS
 * The 110 unit tests never open the app. This suite does: it boots the real
 * Next server against a *throwaway copy* of the database, drives a real Chromium
 * against the real markup, and measures what a human would see. Every judgement
 * carries the number it measured, so a failure reads "saw 3 loaders at t=1250ms",
 * never "expected true, got false".
 *
 * SAFETY — THE DATABASE
 * A previous harness pointed at `dev.db` and destroyed the owner's real library.
 * `harness-db.mjs` is imported FIRST here: as an import side effect it copies
 * `dev.db` to a temp file and repoints `DATABASE_URL` at the copy, so nothing the
 * spawned server writes can reach the live library. We then assert the resolved
 * URL is not `dev.db` and abort if it is. The dev server runs on a port in
 * 3030-3039 — never 3000, where the owner's production server is actively
 * streaming against the real DB.
 */
// MUST be first — sets process.env.DATABASE_URL to a throwaway copy before
// anything can read it. See harness-db.mjs header for the ordering rule.
import { scratchDb, cleanupScratchDb } from "../../lib/harness-db.mjs";

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// ---------------------------------------------------------------------------
// DB safety guard — refuse to run if we could possibly touch the real library.
// ---------------------------------------------------------------------------
export function assertNotLiveDatabase(): void {
  const url = process.env.DATABASE_URL ?? "";
  const filePart = url.replace(/^file:/, "").split("?")[0];
  const resolved = filePart ? path.resolve(filePart.replace(/\//g, path.sep)) : "";
  const liveDb = path.resolve(repoRoot, "dev.db");
  const prismaDb = path.resolve(repoRoot, "prisma", "dev.db");
  const base = path.basename(resolved).toLowerCase();
  const pointsAtLive =
    resolved === liveDb ||
    resolved === prismaDb ||
    (base === "dev.db" && resolved.startsWith(repoRoot));
  if (!resolved || pointsAtLive) {
    throw new Error(
      `REFUSING TO RUN: DATABASE_URL resolves to the live database (${resolved || url}). ` +
        `The harness must run against a throwaway copy provided by harness-db.mjs.`,
    );
  }
  if (!resolved.startsWith(path.resolve(os.tmpdir()))) {
    // Not fatal on its own, but worth shouting: the scratch DB should live in
    // the OS temp dir, well away from the repo.
    console.warn(`  [guard] scratch DB is outside the temp dir: ${resolved}`);
  }
  console.log(`  [guard] DATABASE_URL -> ${resolved} (safe copy, not dev.db)`);
}
assertNotLiveDatabase();

/**
 * Hard guard for J4, which is the ONE journey that adds a real seeded torrent and
 * therefore writes real bytes to disk. The resolved save directory MUST be a
 * throwaway under the OS temp dir, and MUST NOT be the app's real media root
 * (`<repo>/.e2e-instant-play`, a 7.7 GB library despite the name). Abort loudly
 * rather than "fix" an unsafe path and continue.
 */
export function assertSafeSaveDir(dir: string): string {
  const resolved = path.resolve(dir);
  const forbidden = path.resolve(repoRoot, ".e2e-instant-play");
  const underForbidden = resolved === forbidden || resolved.startsWith(forbidden + path.sep);
  const hasE2eSegment = resolved.split(path.sep).includes(".e2e-instant-play");
  const underTmp = resolved.startsWith(path.resolve(os.tmpdir()) + path.sep);
  if (underForbidden || hasE2eSegment) {
    throw new Error(
      `REFUSING TO DOWNLOAD: save dir resolves into the real media root .e2e-instant-play (${resolved}). ` +
        `Real user data lives there — the fixture must download to a throwaway temp dir.`,
    );
  }
  if (!underTmp) {
    throw new Error(
      `REFUSING TO DOWNLOAD: save dir is not under the OS temp dir (${resolved}). ` +
        `The fixture must download to a throwaway temp dir so nothing can leak into the real library.`,
    );
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Artifacts — gitignored scratch dir (qa-screens/ is already ignored).
// ---------------------------------------------------------------------------
export const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
export const artifactsDir = path.join(repoRoot, "qa-screens", "journeys", RUN_ID);
fs.mkdirSync(artifactsDir, { recursive: true });

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Ports — 3030-3039 only. 3000 is the owner's production server; never touch it.
// ---------------------------------------------------------------------------
const PORT_RANGE = [3030, 3031, 3032, 3033, 3034, 3035, 3036, 3037, 3038, 3039];

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

export async function allocatePort(): Promise<number> {
  for (const port of PORT_RANGE) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`no free port in ${PORT_RANGE[0]}-${PORT_RANGE[PORT_RANGE.length - 1]}`);
}

// ---------------------------------------------------------------------------
// Dev server — a real Next server on the scratch DB.
// ---------------------------------------------------------------------------
export interface DevServer {
  base: string;
  port: number;
  child: ChildProcess;
  /** The scratch download root (DOWNLOAD_DIR) this server writes torrents into. */
  downloadDir: string;
  stop: () => Promise<void>;
}

export async function startDevServer(): Promise<DevServer> {
  const port = await allocatePort();
  const base = `http://127.0.0.1:${port}`;
  const leechDir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-journeys-dl-"));
  const logPath = path.join(repoRoot, "qa-journeys-devserver.log");
  fs.writeFileSync(logPath, "");
  const append = (t: string) => fs.appendFileSync(logPath, t);

  // Next 16 / Turbopack takes a single-instance lock at <distDir>/lock. A prod
  // server (or a sibling agent's dev server) already holds the lock on the real
  // repo's .next, and Next refuses to start a second one for the same project
  // dir. JOURNEY_APP_DIR lets us point the dev server at an isolated copy of the
  // project (a real, separate path => its own .next => its own lock), while this
  // harness and its journey specs still live in the real repo.
  const appDir = process.env.JOURNEY_APP_DIR ? path.resolve(process.env.JOURNEY_APP_DIR) : repoRoot;
  const nextBinInApp = path.join(appDir, "node_modules", "next", "dist", "bin", "next");
  const nextBin = fs.existsSync(nextBinInApp)
    ? nextBinInApp
    : path.join(repoRoot, "node_modules", "next", "dist", "bin", "next");

  const child = spawn(
    process.execPath,
    [nextBin, "dev", "-H", "127.0.0.1", "-p", String(port)],
    {
      cwd: appDir,
      env: {
        ...process.env,
        PORT: String(port),
        NEXT_TELEMETRY_DISABLED: "1",
        NEXT_PRIVATE_DEV_DIR: appDir,
        DOWNLOAD_DIR: leechDir,
        DATABASE_URL: scratchDb.url,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", (b: Buffer) => {
    const t = b.toString();
    append(t);
    if (/ready|error|compiled|Local:/i.test(t)) process.stdout.write(`  [next] ${t.trim().slice(0, 200)}\n`);
  });
  child.stderr?.on("data", (b: Buffer) => append(b.toString()));

  const stop = async () => {
    await new Promise<void>((resolve) => {
      if (child.exitCode != null) return resolve();
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode == null) child.kill("SIGKILL");
        resolve();
      }, 5_000).unref();
    });
    try {
      fs.rmSync(leechDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  };

  // Wait for the server to answer. `next dev` compiles the home route on first
  // hit, so the first 200 can take a while on a cold build.
  const deadline = Date.now() + 300_000;
  let last = "not reached";
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      await stop();
      throw new Error(`next dev exited early with code ${child.exitCode} — see ${logPath}`);
    }
    try {
      const res = await fetch(`${base}/`, { signal: AbortSignal.timeout(30_000) });
      if (res.ok || res.status === 200) return { base, port, child, downloadDir: leechDir, stop };
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await sleep(1_000);
  }
  await stop();
  throw new Error(`dev server never became ready (${last}) — see ${logPath}`);
}

/** Compile every route once so per-journey timing is not polluted by first-hit build cost. */
export async function warmRoutes(base: string, routes: string[]): Promise<void> {
  for (const route of routes) {
    try {
      await fetch(`${base}${route}`, { signal: AbortSignal.timeout(120_000) });
    } catch {
      /* a route that fails to warm will surface in its own journey */
    }
  }
}

export async function launchBrowser(): Promise<Browser> {
  return chromium.launch({ headless: true });
}

// ---------------------------------------------------------------------------
// Assertion helpers — every failure carries the measured value.
// ---------------------------------------------------------------------------

/** A failed measurement: the bug the journey encodes is PRESENT (test goes RED). */
export class MeasuredFailure extends Error {
  measured: string;
  constructor(message: string, measured: string) {
    super(message);
    this.name = "MeasuredFailure";
    this.measured = measured;
  }
}

/** A precondition could not be met, so the journey could not exercise the bug. */
export class Blocked extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Blocked";
  }
}

export function expectAtMost(actual: number, max: number, context: string): void {
  if (actual > max) {
    throw new MeasuredFailure(`${context}: expected <= ${max}, saw ${actual}`, String(actual));
  }
}

export function expectAtLeast(actual: number, min: number, context: string): void {
  if (actual < min) {
    throw new MeasuredFailure(`${context}: expected >= ${min}, saw ${actual}`, String(actual));
  }
}

export function expectTrue(cond: boolean, context: string, measured: string): void {
  if (!cond) throw new MeasuredFailure(context, measured);
}

// ---------------------------------------------------------------------------
// Journey runner.
// ---------------------------------------------------------------------------
export type Outcome = "RED" | "GREEN" | "BLOCKED" | "ERROR";

export interface JourneyResult {
  name: string;
  bug: string;
  outcome: Outcome;
  measured: string;
  detail: string;
  screenshot?: string;
  ms: number;
}

export interface JourneyContext {
  browser: Browser;
  base: string;
  artifactsDir: string;
  /** The scratch download root (DOWNLOAD_DIR) the server writes torrents into. */
  downloadDir: string;
  /** Convenience: a fresh context+page at a given viewport. Auto-closed. */
  withPage: <T>(opts: { viewport?: { width: number; height: number } }, fn: (page: Page) => Promise<T>) => Promise<T>;
  log: (msg: string) => void;
}

export interface JourneySpec {
  name: string;
  bug: string;
  /** Returns a measured value string on GREEN; throws MeasuredFailure (RED) or Blocked. */
  run: (ctx: JourneyContext) => Promise<string>;
}

export class Suite {
  private specs: JourneySpec[] = [];
  constructor(
    private browser: Browser,
    private base: string,
    private downloadDir: string,
  ) {}

  add(spec: JourneySpec): void {
    this.specs.push(spec);
  }

  async run(): Promise<JourneyResult[]> {
    const results: JourneyResult[] = [];
    // JOURNEY_ONLY=J4,J8 runs just the matching specs (name substring, case-insensitive)
    // for fast iteration. Unset ⇒ the whole suite.
    const only = (process.env.JOURNEY_ONLY ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const specs = only.length ? this.specs.filter((s) => only.some((f) => s.name.toLowerCase().includes(f))) : this.specs;
    for (const spec of specs) {
      const started = Date.now();
      let capturedPage: Page | null = null;
      const contexts: BrowserContext[] = [];
      const ctx: JourneyContext = {
        browser: this.browser,
        base: this.base,
        artifactsDir,
        downloadDir: this.downloadDir,
        log: (m) => process.stdout.write(`      ${m}\n`),
        withPage: async (opts, fn) => {
          const c = await this.browser.newContext({ viewport: opts.viewport ?? { width: 1440, height: 900 } });
          contexts.push(c);
          // tsx/esbuild transpiles page.evaluate callbacks with keepNames, emitting bare
          // `__name(fn, "name")` wrappers that are undefined in the browser realm. Shim it
          // (identity) on every document before any injected script runs, or evaluates throw
          // "ReferenceError: __name is not defined".
          await c.addInitScript(() => {
            const g = globalThis as unknown as Record<string, unknown>;
            if (typeof g.__name !== "function") g.__name = (fn: unknown) => fn;
          });
          const page = await c.newPage();
          capturedPage = page;
          return fn(page);
        },
      };
      process.stdout.write(`\n> ${spec.name}\n`);
      let result: JourneyResult;
      try {
        const measured = await spec.run(ctx);
        result = { name: spec.name, bug: spec.bug, outcome: "GREEN", measured, detail: "assertion held", ms: Date.now() - started };
        process.stdout.write(`  GREEN  ${spec.name} — ${measured}\n`);
      } catch (err) {
        const shot = await this.snap(capturedPage, spec.name).catch(() => undefined);
        if (err instanceof MeasuredFailure) {
          result = { name: spec.name, bug: spec.bug, outcome: "RED", measured: err.measured, detail: err.message, screenshot: shot, ms: Date.now() - started };
          process.stdout.write(`  RED    ${spec.name} — ${err.message}\n`);
        } else if (err instanceof Blocked) {
          result = { name: spec.name, bug: spec.bug, outcome: "BLOCKED", measured: "-", detail: err.message, screenshot: shot, ms: Date.now() - started };
          process.stdout.write(`  BLOCK  ${spec.name} — ${err.message}\n`);
        } else {
          const msg = err instanceof Error ? `${err.message}` : String(err);
          result = { name: spec.name, bug: spec.bug, outcome: "ERROR", measured: "-", detail: msg, screenshot: shot, ms: Date.now() - started };
          process.stdout.write(`  ERROR  ${spec.name} — ${msg}\n`);
        }
      } finally {
        for (const c of contexts) await c.close().catch(() => {});
      }
      results.push(result);
    }
    return results;
  }

  private async snap(page: Page | null, name: string): Promise<string | undefined> {
    if (!page) return undefined;
    const file = path.join(artifactsDir, `${name.replace(/[^a-z0-9]+/gi, "-")}.png`);
    await page.screenshot({ path: file, fullPage: false });
    return file;
  }
}

export { cleanupScratchDb };
