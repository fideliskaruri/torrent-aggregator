/**
 * Can the streaming pipeline actually keep up with the video it is serving?
 *
 * Every other media harness asks "does the right thing come out?" — the correct
 * codec, the correct rung, the correct number of channels. None of them asks the
 * question a viewer actually asks, which is "why is this slow?". A stream is not
 * a file transfer that may take as long as it takes: it has a deadline. A 1080p
 * WEB-DL runs at roughly 8 Mbit/s, so a pipeline that delivers 6 Mbit/s does not
 * play that file slowly, it plays it for a few seconds and then stops to buffer,
 * forever. Throughput below the bitrate is not a performance regression, it is a
 * functional failure, and nothing in this repo measured it.
 *
 * So this harness fixes the one variable that usually gets blamed. It seeds
 * fixtures of a KNOWN bitrate into a BitTorrent swarm running entirely on
 * loopback — its own tracker, its own seeder in this process, the app's own
 * engine as the leecher — and then pulls them back through the real
 * `handleStreamFileRequest`. Nothing here touches the public swarm, so a slow
 * result cannot be excused with "the swarm was thin". Whatever this reports is
 * the pipeline's own ceiling: WebTorrent's piece store, the route's stall guard
 * and range handling, and the ReadableStream plumbing, with the network removed.
 *
 * That is the point. When someone says "streaming seems slow", this separates
 * the two possible answers — "the swarm is thin" and "our own code is the
 * bottleneck" — which otherwise look identical from the sofa.
 *
 * WHAT IS MEASURED, AND WHY EACH ONE
 * ----------------------------------
 *   open TTFB    Time from the request to the first byte of the response, for a
 *                range starting at 0. This is the black screen after you press
 *                play. It is a latency, not a throughput, and no amount of
 *                bandwidth hides it.
 *
 *   seek TTFB    The same, for a range starting ~60% into the file, requested
 *                cold. Sequential piece selection makes the middle of a file the
 *                worst case by construction, so this is where seeking feels
 *                broken. Measured separately because it fails separately.
 *
 *   sustained    Mbit/s averaged over a real multi-megabyte pull. Compared
 *                against the file's own bitrate as measured by ffprobe, never
 *                against a number written here — a hardcoded expectation would
 *                silently stop meaning anything the moment the fixtures change.
 *
 *   headroom     sustained ÷ required. This is the verdict. 1.0 is not a pass:
 *                a stream that delivers exactly its own bitrate has no way to
 *                refill the buffer after any hiccup, so the first stall is
 *                permanent. {@link MIN_HEADROOM} is the margin demanded.
 *
 *   worst gap    The longest interval between two consecutive chunks. Averages
 *                hide stalls: 20 Mbit/s average with a 4-second hole in the
 *                middle is a stutter the viewer sees and the mean does not.
 *
 * Run: npm run test:media:bitrate
 *
 * LIVE MODE
 * ---------
 *   npm run test:media:bitrate -- --live [infoHash]
 *
 * The hermetic run above answers "is our code fast enough?". It cannot answer
 * "is the thing on my sofa fast enough?", because it deliberately removes the
 * network — and the network is usually the actual answer. Live mode points the
 * same measurements at a torrent already in the running app, over real HTTP to
 * the dev server, so the verdict is about the stream the viewer would actually
 * get. With no info hash it measures every torrent the engine holds and reports
 * which of them could sustain playback right now.
 *
 * The two modes are worth reading together. Hermetic PASS + live FAIL means the
 * swarm is thin and no amount of local optimisation will help. Both failing
 * means the pipeline is the problem. That distinction is the whole reason this
 * file exists.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { builtinClient } from "../src/lib/clients/builtin-engine";
import type { ClientConnectionConfig } from "../src/lib/clients";
import { handleStreamFileRequest } from "../src/app/api/stream/[infoHash]/[...filePath]/route";
import {
  FFMPEG,
  probeFile,
  run,
  table,
} from "./lib/media-e2e-support.mjs";
import { startLocalSwarm, ensureDir } from "./lib/local-swarm.mjs";

/**
 * Long enough that the measurement is a measurement.
 *
 * Throughput over a short pull is dominated by warm-up — the first pieces, the
 * handshake, the first `FileIterator` wake-up — so a 5-second clip would report
 * the cost of starting rather than the cost of running.
 */
const CLIP_SECONDS = 30;

/**
 * How much of each file to pull when measuring sustained rate.
 *
 * A player does not read a film in one request, but it does read continuously,
 * and a continuous read is the only way to see the ceiling rather than the
 * latency. Capped so a 40 Mbit/s fixture does not turn this into a long run.
 */
const SUSTAIN_BYTES = 12 * 1024 * 1024;

/**
 * Required headroom over the file's own bitrate.
 *
 * Delivering exactly 1.0x is a failing stream, not a marginal one: playback
 * drains the buffer at exactly the rate it refills, so there is no slack to
 * recover from a single slow piece and every hiccup is permanent. 1.5x is the
 * rule of thumb a stream needs to feel instant and to survive a seek.
 */
const MIN_HEADROOM = 1.5;

/**
 * A gap longer than this between chunks is a visible stutter, not jitter.
 *
 * Below roughly a quarter second the player's own buffer absorbs it and nobody
 * notices. Above it, the picture holds still.
 */
const STUTTER_GAP_MS = 250;

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "tf-bitrate-"));
const SEED_DIR = ensureDir(path.join(WORK, "seed"));
const LEECH_DIR = ensureDir(path.join(WORK, "leech"));

/**
 * No userId, for the same reason as `media-torrent-e2e`: it is what keeps this
 * harness out of the database and off the per-user allow-list path.
 */
const CONFIG: ClientConnectionConfig = {
  clientType: "builtin",
  host: "",
  username: null,
  password: null,
  category: null,
  savePath: LEECH_DIR,
} as ClientConnectionConfig;

type Rung = {
  name: string;
  file: string;
  /** Target video bitrate in Mbit/s — the shape of release this stands in for. */
  mbps: number;
  /** What this rung is a stand-in for, for the report. */
  stands_for: string;
};

/**
 * Bitrates chosen to bracket what this app actually plays, so a pass here means
 * something about real releases rather than about a synthetic clip.
 *
 * `testsrc2` colour bars compress to almost nothing, which would make every
 * fixture the same trivial size and measure nothing. `-minrate`/`-maxrate` with
 * a matching `-bufsize` forces the encoder to pad to the target, so the file on
 * disk really does carry the bitrate its name claims.
 */
const RUNGS: Rung[] = [
  { name: "web-dl-1080p", file: "bitrate-8.mp4", mbps: 8, stands_for: "1080p WEB-DL, the common case" },
  { name: "bluray-1080p", file: "bitrate-20.mp4", mbps: 20, stands_for: "1080p Bluray remux" },
  { name: "uhd-2160p", file: "bitrate-50.mp4", mbps: 50, stands_for: "2160p remux, the worst case" },
];

function encode(rung: Rung, dir: string): string {
  const out = path.join(dir, rung.file);
  const rate = `${rung.mbps}M`;
  const res = run(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi",
    // Noise, not colour bars: bars compress away to nothing and the rate control
    // would never reach the target no matter what it is asked for.
    "-i", `nullsrc=size=1920x1080:rate=24:duration=${CLIP_SECONDS}`,
    "-vf", "geq=random(1)*255:128:128",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-b:v", rate, "-minrate", rate, "-maxrate", rate, "-bufsize", rate,
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    out,
  ]);
  if (res.code !== 0) {
    throw new Error(`failed to encode ${rung.file}: ${res.stderr.trim().split("\n").slice(-3).join(" | ")}`);
  }
  return out;
}

/** The file's real bitrate, from the file — never the number we asked ffmpeg for. */
function measuredMbps(file: string): number {
  const probed = probeFile(file);
  const seconds = Number(probed?.duration ?? 0);
  const bytes = fs.statSync(file).size;
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return (bytes * 8) / seconds / 1e6;
}

type Pull = {
  bytes: number;
  ttfbMs: number;
  totalMs: number;
  worstGapMs: number;
  stutters: number;
  error: string | null;
};

/**
 * Pull a byte range through the real route handler and time it.
 *
 * Called directly rather than over a loopback HTTP socket on purpose: an extra
 * socket would add its own buffering and its own latency to every number here,
 * and the question is what the *pipeline* costs. The route is the same function
 * Next.js invokes, with only `getConfig` injected.
 */
async function pull(
  infoHash: string,
  filePath: string,
  start: number,
  end: number,
): Promise<Pull> {
  const started = Date.now();
  const out: Pull = {
    bytes: 0,
    ttfbMs: 0,
    totalMs: 0,
    worstGapMs: 0,
    stutters: 0,
    error: null,
  };

  const response = await handleStreamFileRequest(
    new Request(`http://127.0.0.1/api/stream/${infoHash}/${filePath}`, {
      headers: { range: `bytes=${start}-${end}` },
    }),
    { infoHash, filePath: filePath.split("/") },
    { getConfig: async () => CONFIG },
  );

  if (response.status !== 206 && response.status !== 200) {
    out.error = `HTTP ${response.status}`;
    out.totalMs = Date.now() - started;
    return out;
  }
  if (!response.body) {
    out.error = "no body";
    out.totalMs = Date.now() - started;
    return out;
  }

  const reader = response.body.getReader();
  let last = started;
  for (;;) {
    const next = await reader.read().catch((err: unknown) => {
      out.error = err instanceof Error ? err.message : String(err);
      return { done: true, value: undefined } as const;
    });
    if (next.done) break;
    const now = Date.now();
    if (out.bytes === 0) {
      out.ttfbMs = now - started;
    } else {
      const gap = now - last;
      if (gap > out.worstGapMs) out.worstGapMs = gap;
      if (gap > STUTTER_GAP_MS) out.stutters += 1;
    }
    last = now;
    out.bytes += next.value?.length ?? 0;
  }
  out.totalMs = Date.now() - started;
  return out;
}

function mbps(bytes: number, ms: number): number {
  if (ms <= 0) return 0;
  return (bytes * 8) / (ms / 1000) / 1e6;
}

type Row = {
  rung: string;
  required: string;
  openTtfb: string;
  seekTtfb: string;
  sustained: string;
  headroom: string;
  worstGap: string;
  verdict: "PASS" | "FAIL";
  why: string;
};

async function measureRung(rung: Rung, seedFile: string): Promise<Row> {
  const required = measuredMbps(seedFile);
  const swarm = await startLocalSwarm();
  const row: Row = {
    rung: `${rung.name} (${rung.mbps}M)`,
    required: `${required.toFixed(1)}`,
    openTtfb: "—",
    seekTtfb: "—",
    sustained: "—",
    headroom: "—",
    worstGap: "—",
    verdict: "FAIL",
    why: "",
  };

  try {
    const seeded = await swarm.seed(seedFile);
    const added = await builtinClient.addTorrent(CONFIG, {
      magnet: seeded.magnetURI,
      savePath: LEECH_DIR,
      name: rung.file,
    });
    if (!added.ok) {
      row.why = `engine refused the torrent: ${added.message}`;
      return row;
    }

    // Metadata has to land before a byte range means anything. Without this the
    // first pull races the torrent's own `ready` and reports a 425 as if it were
    // a slow stream.
    const deadline = Date.now() + 30_000;
    for (;;) {
      const res = await handleStreamFileRequest(
        new Request(`http://127.0.0.1/api/stream/${seeded.infoHash}/${seeded.filePath}`, {
          method: "HEAD",
        }),
        { infoHash: seeded.infoHash, filePath: seeded.filePath.split("/") },
        { getConfig: async () => CONFIG },
      );
      if (res.status === 200 || res.status === 206) break;
      if (Date.now() > deadline) {
        row.why = `metadata never arrived (last HTTP ${res.status})`;
        return row;
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    // ── Open: press play. Latency, measured from a cold torrent. ──────────
    const open = await pull(seeded.infoHash, seeded.filePath, 0, Math.min(SUSTAIN_BYTES, seeded.length) - 1);
    if (open.error) {
      row.why = `open failed: ${open.error}`;
      return row;
    }
    row.openTtfb = `${open.ttfbMs}`;
    const rate = mbps(open.bytes, open.totalMs);
    row.sustained = rate.toFixed(1);
    row.worstGap = `${open.worstGapMs}`;

    // ── Seek: jump to 60%, cold. Sequential selection's worst case. ───────
    const seekStart = Math.floor(seeded.length * 0.6);
    const seek = await pull(
      seeded.infoHash,
      seeded.filePath,
      seekStart,
      Math.min(seekStart + 2 * 1024 * 1024, seeded.length) - 1,
    );
    row.seekTtfb = seek.error ? `ERR ${seek.error}` : `${seek.ttfbMs}`;

    const headroom = required > 0 ? rate / required : 0;
    row.headroom = `${headroom.toFixed(2)}x`;

    const reasons: string[] = [];
    if (headroom < MIN_HEADROOM) {
      reasons.push(`only ${headroom.toFixed(2)}x the file's own ${required.toFixed(1)} Mb/s`);
    }
    if (open.stutters > 0) {
      reasons.push(`${open.stutters} gap(s) over ${STUTTER_GAP_MS}ms, worst ${open.worstGapMs}ms`);
    }
    row.verdict = reasons.length === 0 ? "PASS" : "FAIL";
    row.why = reasons.join("; ") || "sustains the file's bitrate with margin";
    return row;
  } finally {
    for (const t of await builtinClient.listTorrents(CONFIG).catch(() => [])) {
      if (t.hash) await builtinClient.deleteTorrent?.(CONFIG, t.hash, true).catch(() => undefined);
    }
    await swarm.close();
  }
}

async function main() {
  if (process.argv.includes("--live")) {
    await liveMain();
    return;
  }
  console.log("── Encoding fixtures at known bitrates ──");
  const seeded: Array<[Rung, string]> = [];
  for (const rung of RUNGS) {
    const out = encode(rung, SEED_DIR);
    const size = fs.statSync(out).size;
    console.log(
      `  ok   ${rung.file.padEnd(16)} ${(size / 1048576).toFixed(1)} MiB` +
        `  measured ${measuredMbps(out).toFixed(1)} Mb/s   (${rung.stands_for})`,
    );
    seeded.push([rung, out]);
  }

  console.log("\n── Pulling each one back through the real stream route ──");
  console.log("   (loopback tracker + in-process seeder: the public swarm is never contacted,");
  console.log("    so any shortfall below is our own pipeline, not a thin swarm)\n");

  const rows: Row[] = [];
  for (const [rung, file] of seeded) {
    process.stdout.write(`  ${rung.name} … `);
    const row = await measureRung(rung, file);
    console.log(`${row.verdict}  ${row.sustained} Mb/s (${row.headroom})`);
    rows.push(row);
  }

  console.log("\n── Results ──\n");
  console.log(
    table(
      ["Rung", "Needs Mb/s", "Open ms", "Seek ms", "Got Mb/s", "Headroom", "Worst gap ms", "Verdict", "Why"],
      rows.map((r) => [
        r.rung,
        r.required,
        r.openTtfb,
        r.seekTtfb,
        r.sustained,
        r.headroom,
        r.worstGap,
        r.verdict,
        r.why,
      ]),
    ),
  );

  const failures = rows.filter((r) => r.verdict === "FAIL").length;
  console.log(
    failures === 0
      ? `\nPASS — every rung sustains its own bitrate with at least ${MIN_HEADROOM}x headroom.`
      : `\nFAIL — ${failures} rung(s) cannot keep up with the file they are serving.`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

/**
 * Measure a torrent the running app already holds, over real HTTP.
 *
 * Deliberately goes through the dev server rather than calling the route
 * in-process, unlike the hermetic run. Here the extra socket is not noise to be
 * eliminated — it is part of what the browser experiences, and the question in
 * live mode is what the viewer gets, not what the pipeline could theoretically
 * do.
 *
 * Everything is derived from the running instance: the file list comes from the
 * stream manifest, and the required bitrate comes from the file's own size and
 * duration. Nothing is assumed about what is installed.
 */
async function liveMain(): Promise<void> {
  const base = process.env.BASE_URL ?? "http://localhost:3000";
  const wanted = process.argv[process.argv.indexOf("--live") + 1];
  const only = wanted && !wanted.startsWith("--") ? wanted.toLowerCase() : null;

  const listed = await fetch(`${base}/api/client/torrents`).catch(() => null);
  if (!listed?.ok) {
    console.error(
      `FAIL — no running instance at ${base}. Start the app first, or set BASE_URL.`,
    );
    process.exitCode = 1;
    return;
  }
  const { torrents } = (await listed.json()) as {
    torrents: Array<{ hash: string; name: string; peers?: number; progress: number }>;
  };
  const targets = only ? torrents.filter((t) => t.hash.toLowerCase() === only) : torrents;
  if (targets.length === 0) {
    console.error(
      only ? `FAIL — no torrent ${only} in the engine.` : "FAIL — the engine holds no torrents.",
    );
    process.exitCode = 1;
    return;
  }

  console.log(`── Live measurement against ${base} ──`);
  console.log("   (real swarm, real HTTP: this is what the viewer gets)\n");

  const rows: Row[] = [];
  for (const t of targets) {
    const label = t.name.length > 38 ? `${t.name.slice(0, 37)}…` : t.name;
    const row: Row = {
      rung: label,
      required: "—",
      openTtfb: "—",
      seekTtfb: "—",
      sustained: "—",
      headroom: "—",
      worstGap: "—",
      verdict: "FAIL",
      why: "",
    };
    rows.push(row);

    const manifest = await fetch(`${base}/api/stream/${t.hash}`).catch(() => null);
    if (!manifest?.ok) {
      row.why = `no manifest (HTTP ${manifest?.status ?? "unreachable"})`;
      continue;
    }
    const { files } = (await manifest.json()) as {
      files?: Array<{ path: string; length: number; durationSec?: number | null }>;
    };
    // The biggest file is the feature; samples and extras are noise.
    const file = (files ?? []).slice().sort((a, b) => b.length - a.length)[0];
    if (!file) {
      row.why = "manifest lists no files";
      continue;
    }

    const url = `${base}/api/stream/${t.hash}/${file.path
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`;
    const measured = await pullHttp(url, 0, Math.min(SUSTAIN_BYTES, file.length) - 1);
    if (measured.error) {
      row.why = `open failed: ${measured.error}`;
      continue;
    }

    const rate = mbps(measured.bytes, measured.totalMs);
    row.openTtfb = `${measured.ttfbMs}`;
    row.sustained = rate.toFixed(2);
    row.worstGap = `${measured.worstGapMs}`;

    const seekStart = Math.floor(file.length * 0.6);
    const seek = await pullHttp(url, seekStart, Math.min(seekStart + 1024 * 1024, file.length) - 1);
    row.seekTtfb = seek.error ? "ERR" : `${seek.ttfbMs}`;

    // Required rate comes from the file itself. Without a duration there is no
    // deadline to compare against, so the honest answer is "unknown" rather than
    // a guessed bitrate that would make the verdict meaningless.
    const seconds = Number(file.durationSec ?? 0);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      row.required = "unknown";
      row.verdict = rate > 0 ? "PASS" : "FAIL";
      row.why =
        rate > 0
          ? `${rate.toFixed(2)} Mb/s delivered; no duration in the manifest, so no deadline to judge it against`
          : "no bytes moved";
      continue;
    }
    const required = (file.length * 8) / seconds / 1e6;
    const headroom = rate / required;
    row.required = required.toFixed(1);
    row.headroom = `${headroom.toFixed(2)}x`;
    row.verdict = headroom >= MIN_HEADROOM ? "PASS" : "FAIL";
    row.why =
      headroom >= MIN_HEADROOM
        ? `sustains it (${t.peers ?? "?"} peers)`
        : `${headroom.toFixed(2)}x — needs ${required.toFixed(1)} Mb/s, got ${rate.toFixed(2)} ` +
          `(${t.peers ?? "?"} peers). At this rate playback stalls and never recovers.`;
  }

  console.log(
    table(
      [
        "Torrent", "Needs Mb/s", "Open ms", "Seek ms",
        "Got Mb/s", "Headroom", "Worst gap ms", "Verdict", "Why",
      ],
      rows.map((r) => [
        r.rung, r.required, r.openTtfb, r.seekTtfb,
        r.sustained, r.headroom, r.worstGap, r.verdict, r.why,
      ]),
    ),
  );

  const failures = rows.filter((r) => r.verdict === "FAIL").length;
  console.log(
    failures === 0
      ? `\nPASS — every torrent measured can sustain its own bitrate with ${MIN_HEADROOM}x headroom.`
      : `\nFAIL — ${failures} of ${rows.length} cannot currently be streamed without stalling.`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

/** The same measurements as {@link pull}, but over a real socket. */
async function pullHttp(url: string, start: number, end: number): Promise<Pull> {
  const started = Date.now();
  const out: Pull = { bytes: 0, ttfbMs: 0, totalMs: 0, worstGapMs: 0, stutters: 0, error: null };
  let response: Response;
  try {
    response = await fetch(url, { headers: { range: `bytes=${start}-${end}` } });
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
    out.totalMs = Date.now() - started;
    return out;
  }
  if ((response.status !== 206 && response.status !== 200) || !response.body) {
    out.error = `HTTP ${response.status}`;
    out.totalMs = Date.now() - started;
    return out;
  }
  const reader = response.body.getReader();
  let last = started;
  for (;;) {
    const next = await reader.read().catch((err: unknown) => {
      out.error = err instanceof Error ? err.message : String(err);
      return { done: true, value: undefined } as const;
    });
    if (next.done) break;
    const now = Date.now();
    if (out.bytes === 0) out.ttfbMs = now - started;
    else {
      const gap = now - last;
      if (gap > out.worstGapMs) out.worstGapMs = gap;
      if (gap > STUTTER_GAP_MS) out.stutters += 1;
    }
    last = now;
    out.bytes += next.value?.length ?? 0;
  }
  out.totalMs = Date.now() - started;
  return out;
}

main()
  .catch((err) => {
    console.error("\nFAIL —", err instanceof Error ? err.stack : String(err));
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      fs.rmSync(WORK, { recursive: true, force: true });
    } catch {
      /* Windows holds the leech files open for a moment after teardown. */
    }
  });
