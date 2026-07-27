import fs from "node:fs";
import path from "node:path";

/**
 * Thrown when a bundled ff* binary cannot be located. Carries the remedy rather
 * than an opaque MODULE_NOT_FOUND, because the person who hits this is usually
 * looking at a failed play button, not a stack trace.
 */
export class FfBinaryMissingError extends Error {
  constructor(binary: "ffprobe" | "ffmpeg", pkg: string, cause: unknown) {
    super(
      `${binary} is unavailable — the bundled "${pkg}" binary could not be resolved. ` +
        `Playback probing/transcoding is disabled until it is restored (run "npm install ${pkg}"). ` +
        `Underlying error: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "FfBinaryMissingError";
  }
}

/**
 * Both `ffmpeg-static` and `ffprobe-static` build their binary path from
 * `__dirname`. Next's server compiler rewrites `__dirname` to a synthetic root,
 * so inside a route handler those packages hand back paths like
 * `/ROOT/node_modules/ffprobe-static/bin/win32/x64/ffprobe.exe` — which exist
 * nowhere. Outside the bundler (unit tests, scripts) the same call is correct,
 * which is exactly why this only ever fails in the running app.
 *
 * So never trust the returned path: treat it as a *shape* and re-root it
 * against the real project. Exported for tests; pure and filesystem-injectable.
 */
export function rerootBundledBinary(
  rawPath: string,
  cwd: string,
  exists: (p: string) => boolean,
): string | null {
  if (!rawPath) return null;
  if (exists(rawPath)) return rawPath;

  // Normalise separators first: the synthetic path uses POSIX slashes even on
  // Windows, so a naive path.join would produce a single unusable segment.
  const normalized = rawPath.replace(/[\\/]+/g, path.sep);
  const marker = `node_modules${path.sep}`;
  // Scan right-to-left for a marker that starts a path segment: a nested install
  // (a/node_modules/b/node_modules/c) must re-root to the innermost package.
  let at = -1;
  for (let i = normalized.lastIndexOf(marker); i > -1; i = normalized.lastIndexOf(marker, i - 1)) {
    if (i === 0 || normalized[i - 1] === path.sep) {
      at = i;
      break;
    }
    if (i === 0) break;
  }
  if (at === -1) return null;

  const tail = normalized.slice(at + marker.length);
  const candidate = path.join(cwd, "node_modules", tail);
  return exists(candidate) ? candidate : null;
}

type BinarySpec = {
  binary: "ffprobe" | "ffmpeg";
  pkg: string;
  /** Env var checked first, so an operator can point at a system build. */
  envVar: string;
  /** Reads the path the package advertises. Kept lazy — see resolveBinary. */
  read: () => string | null;
};

/**
 * Resolved lazily, never at module load: a pruned or partial install would
 * otherwise take the whole server down at import time with an opaque error,
 * killing search, automation and the library for a feature the user may never
 * touch. Playback alone should fail, and it should say what to run.
 */
function resolveBinary(spec: BinarySpec, cache: { value: string | null }): string {
  if (cache.value) return cache.value;
  try {
    const override = process.env[spec.envVar];
    if (override) {
      if (!fs.existsSync(override)) {
        throw new Error(`${spec.envVar}="${override}" does not exist on disk`);
      }
      cache.value = override;
      return override;
    }

    const raw = spec.read();
    if (!raw) throw new Error(`"${spec.pkg}" exported no path`);
    const resolved = rerootBundledBinary(raw, process.cwd(), (p) => fs.existsSync(p));
    if (!resolved) {
      throw new Error(
        `resolved to "${raw}", which does not exist on disk and could not be re-rooted ` +
          `under "${path.join(process.cwd(), "node_modules")}"`,
      );
    }
    cache.value = resolved;
    return resolved;
  } catch (err) {
    if (err instanceof FfBinaryMissingError) throw err;
    throw new FfBinaryMissingError(spec.binary, spec.pkg, err);
  }
}

const ffprobeCache: { value: string | null } = { value: null };
const ffmpegCache: { value: string | null } = { value: null };

/** Resolve the bundled ffprobe binary, throwing an actionable error if absent. */
export function resolveFfprobePath(): string {
  return resolveBinary(
    {
      binary: "ffprobe",
      pkg: "ffprobe-static",
      envVar: "FFPROBE_PATH",
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      read: () => (require("ffprobe-static") as { path: string }).path,
    },
    ffprobeCache,
  );
}

/** Resolve the bundled ffmpeg binary, throwing an actionable error if absent. */
export function resolveFfmpegPath(): string {
  return resolveBinary(
    {
      binary: "ffmpeg",
      pkg: "ffmpeg-static",
      envVar: "FFMPEG_PATH",
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      read: () => require("ffmpeg-static") as string | null,
    },
    ffmpegCache,
  );
}
