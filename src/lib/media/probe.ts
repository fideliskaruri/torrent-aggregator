// Server-only: this module owns ffprobe subprocess launch, so pure helpers live in ./probe-shape.
/**
 * Media probe — run ffprobe against a torrent file's stream endpoint and cache
 * the result in the MediaProbe Prisma model.
 *
 * Probing goes through the app's own HTTP stream route so ffprobe reads via the
 * torrent engine's byte-range support. This avoids needing direct filesystem
 * access to partially-downloaded torrent data.
 */
import { execFile } from "node:child_process";
import { resolveFfprobePath } from "./ff-binaries";
import { parseProbeOutput, type ProbeOutcome } from "./probe-shape";

export * from "./probe-shape";


/** Deps injectable for testing. */
export type ProbeDeps = {
  ffprobePath?: string;
  timeoutMs?: number;
  analyzeDuration?: number;
  probeSize?: number;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_ANALYZE_DURATION = 5_000_000; // 5s in microseconds
const DEFAULT_PROBE_SIZE = 10_000_000; // 10MB

/**
 * Resolved lazily, not at module load. `ffprobe-static` resolves a per-platform
 * binary that a partial or pruned install can be missing; doing this at import
 * time takes the whole server down with an opaque MODULE_NOT_FOUND before any
 * route can answer. Playback is the only feature that needs it, so only
 * playback should fail — and it should say what to do about it.
 *
 * Re-exported so existing importers of `@/lib/media/probe` keep working; the
 * resolution logic lives in ./ff-binaries because ffmpeg needs it identically.
 */
export { FfBinaryMissingError, resolveFfprobePath } from "./ff-binaries";

export function buildProbeArgs(
  input: string,
  options: {
    timeoutMs?: number;
    analyzeDuration?: number;
    probeSize?: number;
    networkSource?: boolean;
  } = {},
): string[] {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const args = [
    "-v", "quiet",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    "-analyzeduration", String(options.analyzeDuration ?? DEFAULT_ANALYZE_DURATION),
    "-probesize", String(options.probeSize ?? DEFAULT_PROBE_SIZE),
  ];
  if (options.networkSource) {
    args.push("-rw_timeout", String(Math.max(1_000_000, timeoutMs * 1000)));
  }
  args.push(input);
  return args;
}

async function probeInput(
  input: string,
  networkSource: boolean,
  deps: ProbeDeps,
): Promise<ProbeOutcome> {
  let ffprobe: string;
  try {
    ffprobe = deps.ffprobePath ?? resolveFfprobePath();
  } catch (err) {
    return {
      ok: false,
      error: {
        error: "probe_failed",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const args = buildProbeArgs(input, {
    timeoutMs,
    analyzeDuration: deps.analyzeDuration,
    probeSize: deps.probeSize,
    networkSource,
  });

  return new Promise<ProbeOutcome>((resolve) => {
    const child = execFile(
      ffprobe,
      args,
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        clearTimeout(hardKill);
        if (err) {
          const isTimeout =
            ("killed" in err && err.killed) || err.message.includes("ETIMEDOUT");
          resolve({
            ok: false,
            error: {
              error: isTimeout ? "timeout" : "probe_failed",
              message: err.message,
            },
          });
          return;
        }
        try {
          resolve(parseProbeOutput(stdout));
        } catch (e) {
          resolve({
            ok: false,
            error: {
              error: "probe_failed",
              message: e instanceof Error ? e.message : String(e),
            },
          });
        }
      },
    );
    const hardKill = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
    }, timeoutMs + 2000);
    hardKill.unref?.();
  });
}

/**
 * Run ffprobe against an HTTP URL and return parsed stream info.
 * The URL should point at the app's own stream endpoint.
 */
export async function probeUrl(
  url: string,
  deps: ProbeDeps = {},
): Promise<ProbeOutcome> {
  return probeInput(url, true, deps);
}

/** Probe a completed local file without applying HTTP-only ffprobe options. */
export async function probeFile(
  filePath: string,
  deps: ProbeDeps = {},
): Promise<ProbeOutcome> {
  return probeInput(filePath, false, deps);
}

// ── Prisma cache layer ──


/**
 * Build the stream URL that ffprobe/ffmpeg will read from.
 *
 * The origin is passed in rather than assumed: the dev server is regularly on a
 * port other than 3000, and a hardcoded loopback origin makes every probe fail
 * with a connection refused that looks like a cold torrent.
 */
export function streamUrl(infoHash: string, filePath: string, origin: string): string {
  const segments = filePath
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  const base = origin.replace(/\/+$/, "");
  return `${base}/api/stream/${encodeURIComponent(infoHash)}/${segments}`;
}

/**
 * Derive the origin the server is actually reachable at from the incoming
 * request. Loopback self-requests must hit the port this process is really
 * listening on, and only the request knows that.
 */
export function requestOrigin(request: { url: string; headers: Headers }): string {
  const headers = request.headers;
  const forwardedHost = headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || headers.get("host")?.trim();
  const forwardedProto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim();

  if (host) {
    // A bare Host header carries no scheme; anything not explicitly forwarded as
    // https is http, which is what a localhost-bound dev/prod server serves.
    const proto = forwardedProto || (host.endsWith(":443") ? "https" : "http");
    return `${proto}://${host}`;
  }

  try {
    return new URL(request.url).origin;
  } catch {
    return "http://127.0.0.1:3000";
  }
}
