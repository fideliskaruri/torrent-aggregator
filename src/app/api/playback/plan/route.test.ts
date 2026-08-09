import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  buildProbeCacheData,
  cacheProbe as cacheProbeFn,
  parsePlaybackPlanAudioStreamIndex,
  parsePlaybackPlanCodecEntry,
  parsePlaybackPlanWarm,
  probeFromCacheRow,
  PROBE_CACHE_VERSION,
} from "./route";
import { probeBitrateBps } from "@/lib/media/probe";

async function main() {
  assert.deepEqual(parsePlaybackPlanAudioStreamIndex(new Map<string, unknown>([["audioStreamIndex", null]])), {
    ok: true,
    value: null,
  });

  assert.deepEqual(parsePlaybackPlanAudioStreamIndex(new Map<string, unknown>()), {
    ok: true,
    value: undefined,
  });

  assert.deepEqual(parsePlaybackPlanAudioStreamIndex(new Map<string, unknown>([["audioStreamIndex", 2]])), {
    ok: true,
    value: 2,
  });

  assert.deepEqual(parsePlaybackPlanAudioStreamIndex(new Map<string, unknown>([["audioStreamIndex", "2"]])), {
    ok: false,
    status: 400,
    error: "audioStreamIndex must be a finite number",
    field: "audioStreamIndex",
  });

  assert.deepEqual(parsePlaybackPlanCodecEntry(new Map<string, unknown>([["mime", "video/mp4"], ["canPlay", ""]])), {
    ok: true,
    value: { mime: "video/mp4", canPlay: "" },
  });
  assert.deepEqual(parsePlaybackPlanCodecEntry(new Map<string, unknown>([["mime", "video/mp4"], ["canPlay", "maybe"]])), {
    ok: true,
    value: { mime: "video/mp4", canPlay: "maybe" },
  });
  assert.deepEqual(parsePlaybackPlanCodecEntry(new Map<string, unknown>([["mime", "video/mp4"], ["canPlay", "probably"]])), {
    ok: true,
    value: { mime: "video/mp4", canPlay: "probably" },
  });
  assert.deepEqual(parsePlaybackPlanCodecEntry(new Map<string, unknown>([["mime", "video/mp4"], ["canPlay", "likely"]])), {
    ok: false,
    status: 400,
    error: 'canPlay must be one of: "", "maybe", "probably"',
    field: "canPlay",
  });
  assert.deepEqual(parsePlaybackPlanCodecEntry(new Map<string, unknown>([["mime", "video/mp4"], ["canPlay", 2]])), {
    ok: false,
    status: 400,
    error: "canPlay must be a string",
    field: "canPlay",
  });
  assert.deepEqual(parsePlaybackPlanCodecEntry(new Map<string, unknown>([["mime", ""], ["canPlay", ""]])), {
    ok: false,
    status: 400,
    error: "mime is required",
    field: "mime",
  });

  const routeSource = fs.readFileSync(path.join(process.cwd(), "src/app/api/playback/plan/route.ts"), "utf8");

  // ── Warm mode: additive parsing, and a strictly local, session-free path ──

  assert.deepEqual(parsePlaybackPlanWarm(new Map<string, unknown>()), {
    ok: true,
    value: undefined,
  });
  assert.deepEqual(parsePlaybackPlanWarm(new Map<string, unknown>([["warm", true]])), {
    ok: true,
    value: true,
  });
  assert.deepEqual(parsePlaybackPlanWarm(new Map<string, unknown>([["warm", false]])), {
    ok: true,
    value: false,
  });
  assert.deepEqual(parsePlaybackPlanWarm(new Map<string, unknown>([["warm", "yes"]])), {
    ok: false,
    status: 400,
    error: "warm must be a boolean",
    field: "warm",
  });

  const warmBranch =
    /if \(warm\) \{[\s\S]*?\n  \}/.exec(routeSource)?.[0] ?? "";
  assert.ok(warmBranch.length > 0, "the route has a warm branch");
  assert.match(
    warmBranch,
    /resolvePersistedLocalFile\(/,
    "warm locality is resolved from the database only, never through the engine resolver",
  );
  assert.ok(
    !/resolveCompleteLocalFile|probeUrl|getOrCreateSession|prepareVod|chooseStrategy/.test(warmBranch),
    "warm mode never wakes WebTorrent, spawns ffmpeg or creates a playback session",
  );
  assert.match(
    warmBranch,
    /warm: true, ready: false, reason: "not-local"/,
    "non-local media is a successful no-op, not an error",
  );
  assert.match(warmBranch, /probeFile\(warmLocal\.absolutePath\)/, "warm probes the proven local file");
  assert.match(warmBranch, /getCachedProbe\(infoHash, filePath, observer\)/, "warm reads the existing probe cache");
  assert.match(warmBranch, /cacheProbe\(infoHash, filePath, probed\.result, observer\)/, "warm writes the existing probe cache");
  assert.match(warmBranch, /runWarmProbe\(\s*warmProbeKey\(infoHash, filePath\)/, "concurrent warms of one file are deduplicated");
  assert.match(
    routeSource,
    /if \(!warm\) installSessionCleanup\(\);/,
    "a warm request installs no session cleanup because it creates no session",
  );
  assert.ok(
    routeSource.indexOf("if (warm) {") < routeSource.indexOf("local = await resolveCompleteLocalFile"),
    "warm answers before the engine-backed local resolver can run",
  );

  const localResolution = routeSource.indexOf(
    "local = await resolveCompleteLocalFile({ config, infoHash, filePath })",
  );
  const cacheProbe = routeSource.indexOf(
    "let probeResult = await getCachedProbe(infoHash, filePath, observer)",
  );
  assert.ok(localResolution >= 0, "playback plan resolves complete local media");
  assert.ok(
    localResolution < cacheProbe,
    "complete local media is resolved before a cache miss can probe through the torrent route",
  );
  assert.match(
    routeSource,
    /local\.ok\s*\?\s*await probeFile\(local\.absolutePath\)\s*:\s*await probeUrl\(url\)/,
    "an uncached verified local file is probed directly from disk",
  );

  assert.match(
    routeSource,
    /bitrate: probeBitrateBps\(probeResult!\)/,
    "the plan response reports a measured bitrate from the probe",
  );
  assert.match(
    routeSource,
    /probeBitrateBps,/,
    "the bitrate comes from the shared probe helper, not a local re-derivation",
  );
  // ── The probe cache actually persists the normalized bitrate ──

  const probeOf = (bitRate: number | string | null, streamBitRate?: number) => ({
    container: "matroska",
    duration: 5400,
    bitRate,
    streams: [
      { index: 0, codecType: "video" as const, codec: "hevc", width: 3840, height: 2160, ...(streamBitRate === undefined ? {} : { bitRate: streamBitRate }) },
      { index: 1, codecType: "audio" as const, codec: "eac3", channels: 6 },
    ],
  });

  const writes: { create: Record<string, unknown>; update: Record<string, unknown> }[] = [];
  const writer = {
    upsert: async (args: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
      writes.push({ create: args.create, update: args.update });
      return null;
    },
  };
  const observerStub = { degraded: () => {} };

  // Run the real writer with an injected Prisma slice: both halves of the
  // upsert must carry the same normalized bitrate and the current cache
  // version, so a refresh can never quietly drop what a create stored.
  assert.equal(
    await cacheProbeFn("hash", "a.mkv", probeOf(42_000_000) as never, observerStub, writer),
    true,
  );
  assert.equal(writes[0]!.create.bitRateBps, 42_000_000);
  assert.equal(writes[0]!.update.bitRateBps, 42_000_000);
  assert.equal(writes[0]!.create.probeVersion, PROBE_CACHE_VERSION);
  assert.equal(writes[0]!.update.probeVersion, PROBE_CACHE_VERSION);
  assert.equal(writes[0]!.create.infoHash, "hash");
  assert.equal(writes[0]!.create.filePath, "a.mkv");

  // ffprobe strings are parsed; garbage and non-positive values become null.
  assert.equal(buildProbeCacheData(probeOf("42000000") as never).bitRateBps, 42_000_000);
  for (const bad of ["N/A", "", "abc", 0, -1, Number.NaN, null] as (string | number | null)[]) {
    const data = buildProbeCacheData(probeOf(bad as never) as never);
    assert.equal(data.bitRateBps, null, `invalid probe bitrate ${String(bad)} must persist as null`);
    assert.equal(data.probeVersion, PROBE_CACHE_VERSION);
  }

  // A per-stream rate is what gets stored when present.
  assert.equal(buildProbeCacheData(probeOf(42_000_000, 38_000_000) as never).bitRateBps, 38_000_000);

  // A write failure is reported, not swallowed.
  let degraded = 0;
  assert.equal(
    await cacheProbeFn("hash", "a.mkv", probeOf(1) as never, { degraded: () => { degraded += 1; } }, {
      upsert: async () => { throw new Error("db down"); },
    }),
    false,
  );
  assert.equal(degraded, 1);

  // ── Cached plans keep a real bitrate; unknown stays unknown ──

  const streamsJson = JSON.stringify([
    { index: 0, codecType: "video", codec: "hevc", width: 3840, height: 2160 },
    { index: 1, codecType: "audio", codec: "eac3", channels: 6 },
  ]);
  const row = (bitRateBps: number | null | undefined) => ({
    container: "matroska",
    durationSec: 5400,
    ...(bitRateBps === undefined ? {} : { bitRateBps }),
    probeVersion: PROBE_CACHE_VERSION,
    streamsJson,
  });

  // ── Legacy rows re-probe exactly once, fresh unknowns never do ──

  // A row from before the bitrate column: rejected, so the caller cold-probes
  // and rewrites it instead of serving a bitrate-less plan forever.
  assert.equal(
    probeFromCacheRow({ container: "matroska", durationSec: 5400, streamsJson }),
    null,
    "a row from an older cache generation is a cache miss",
  );
  assert.equal(probeFromCacheRow({ ...row(null), probeVersion: 0 }), null);

  // The rewrite that follows is stamped current, so even when ffprobe honestly
  // found no bitrate the next play is a cache hit — no re-probe loop.
  const rewritten = buildProbeCacheData(probeOf(null) as never);
  const rehit = probeFromCacheRow({
    container: rewritten.container,
    durationSec: rewritten.durationSec,
    bitRateBps: rewritten.bitRateBps,
    probeVersion: rewritten.probeVersion,
    streamsJson: rewritten.streamsJson,
  });
  assert.ok(rehit, "a freshly written row with unknown bitrate is served from cache");
  assert.equal(rehit!.bitRate, null);

  // The MKV case the fix targets: bitrate lives only on the container, so before
  // caching it the second play silently lost bitrate-aware buffer sizing.
  const cachedContainerOnly = probeFromCacheRow(row(42_000_000));
  assert.equal(cachedContainerOnly?.bitRate, 42_000_000);
  assert.equal(
    probeBitrateBps(cachedContainerOnly!),
    42_000_000,
    "a cache hit reports the same container bitrate as the cold probe",
  );

  // A current row whose ffprobe found no bitrate: unknown, never invented.
  const legacy = probeFromCacheRow(row(undefined));
  assert.equal(legacy?.bitRate, null);
  assert.equal(probeBitrateBps(legacy!), null);

  assert.equal(probeFromCacheRow(row(null))?.bitRate, null);
  for (const bad of [0, -1, Number.NaN]) {
    assert.equal(probeFromCacheRow(row(bad))?.bitRate, null, `invalid cached bitrate ${bad} must be null`);
  }

  // A per-stream rate still wins over the cached container rate, and survives
  // on its own when the column is empty.
  const perStreamJson = JSON.stringify([
    { index: 0, codecType: "video", codec: "hevc", bitRate: 38_000_000 },
  ]);
  assert.equal(
    probeBitrateBps(probeFromCacheRow({ ...row(42_000_000), streamsJson: perStreamJson })!),
    38_000_000,
  );
  assert.equal(
    probeBitrateBps(probeFromCacheRow({ ...row(null), streamsJson: perStreamJson })!),
    38_000_000,
  );

  assert.equal(probeFromCacheRow(null), null);
  assert.equal(probeFromCacheRow({ ...row(42_000_000), streamsJson: null }), null);

  console.log("route.test.ts: all assertions passed");
}

void main();
