/**
 * The single place a test is allowed to create a directory.
 *
 * WHY THIS EXISTS
 * ---------------
 * The owner runs this suite on the same machine that holds their media library,
 * and that library is already well over its storage cap. Tests that mint their
 * own scratch roots — `os.tmpdir()`, `mkdtemp(process.cwd() + ".test-…")`, a
 * per-test folder somewhere else on the volume — spread throwaway bytes across
 * the disk, survive crashed runs, and are invisible to the very storage
 * accounting this suite exists to verify. A run that is meant to *prove* the
 * app does not leak storage must not itself leak storage.
 *
 * THE RULE
 * --------
 * Every test directory lives under one clearly-named folder inside the app's
 * own download root, and is removed in a `finally`. A crashed run therefore
 * leaves at most one named folder in a place the owner already looks, not a
 * random tree under `%TEMP%` that nobody will ever find.
 *
 * The `.`-prefix on {@link SCRATCH_DIRNAME} is load-bearing: `disk-inventory`
 * classifies dot-prefixed top-level entries as app-internal rather than as
 * orphaned media, so a scratch folder can never be presented to the owner as
 * something of theirs to reclaim.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Folder that holds every test scratch directory, relative to the download root. */
export const SCRATCH_DIRNAME = ".tf-test";

/**
 * Download root used by tests, relative to the repository root.
 *
 * This is the folder the running app is configured to download into. Reusing it
 * is deliberate: it is the only directory on the machine the owner has already
 * accepted as "where this app puts bytes".
 */
export const TEST_DOWNLOAD_ROOT_RELATIVE = path.join(
  ".e2e-instant-play",
  "plhokoij",
  "leech",
);

/** Env override so a different checkout or CI box can point somewhere valid. */
export const SCRATCH_ROOT_ENV = "TORRENTFLOW_TEST_SCRATCH_ROOT";

function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i += 1) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/** Absolute path of the folder every test scratch directory is created inside. */
export function scratchRoot(): string {
  const override = process.env[SCRATCH_ROOT_ENV]?.trim();
  const base = override
    ? path.resolve(override)
    : path.join(repoRoot(), TEST_DOWNLOAD_ROOT_RELATIVE);
  return path.join(base, SCRATCH_DIRNAME);
}

let seq = 0;

function scratchPath(label: string): string {
  const safe =
    label
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "scratch";
  seq += 1;
  return path.join(scratchRoot(), `${safe}-${process.pid}-${seq}`);
}

/**
 * Create an empty scratch directory. Callers are responsible for removing it —
 * prefer {@link withScratchDir}, which cannot forget.
 */
export function makeScratchDir(label: string): string {
  const dir = scratchPath(label);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Remove a scratch directory. Never throws, and refuses to escape the root. */
export function removeScratchDir(dir: string | null | undefined): void {
  if (!dir) return;
  const resolved = path.resolve(dir);
  const root = path.resolve(scratchRoot());
  // A bug in a test must not turn cleanup into a delete of the owner's media.
  if (resolved === root) return;
  if (!resolved.startsWith(root + path.sep)) return;
  try {
    fs.rmSync(resolved, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

/** Run `fn` with a fresh scratch directory, removing it whatever happens. */
export async function withScratchDir<T>(
  label: string,
  fn: (dir: string) => Promise<T> | T,
): Promise<T> {
  const dir = makeScratchDir(label);
  try {
    return await fn(dir);
  } finally {
    removeScratchDir(dir);
  }
}

/** Synchronous variant, for tests that do no async work. */
export function withScratchDirSync<T>(label: string, fn: (dir: string) => T): T {
  const dir = makeScratchDir(label);
  try {
    return fn(dir);
  } finally {
    removeScratchDir(dir);
  }
}

/**
 * Delete every leftover scratch directory.
 *
 * Only ever touches children of {@link scratchRoot}, so it cannot reach the
 * owner's media even if the download root is misconfigured.
 */
export async function purgeScratchRoot(): Promise<number> {
  const root = scratchRoot();
  let removed = 0;
  let entries: string[];
  try {
    entries = await fsp.readdir(root);
  } catch {
    return 0;
  }
  for (const name of entries) {
    try {
      await fsp.rm(path.join(root, name), { recursive: true, force: true });
      removed += 1;
    } catch {
      /* best-effort */
    }
  }
  return removed;
}
