/**
 * Shared support for the real-media playback harnesses.
 *
 * Every one of these scripts needs the same three things: the empirically
 * measured Edge capability profile, a way to synthesise a codec fixture with
 * the bundled ffmpeg, and a way to re-probe what came out the other end. They
 * live here so the browser, torrent and UI harnesses assert against exactly the
 * same ground truth as the ladder harness — a capability profile that drifted
 * between scripts would make the rung assertions meaningless.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { parseProbeOutput, type ProbeResult } from "../../src/lib/media/probe-shape.js";
import { DEFAULT_CAPABILITIES, type ClientCapabilities } from "../../src/lib/media/capabilities";

const require = createRequire(import.meta.url);

export const FFMPEG: string = require("ffmpeg-static");
export const FFPROBE: string = (require("ffprobe-static") as { path: string }).path;

/**
 * Measured on the owner's machine with scripts/probe-codecs.mjs. The single
 * most important fact is that `video/x-matroska` is NOT supported under
 * MediaSource — that is what forces the remux rung for the majority of
 * x265/Bluray releases.
 */
export const EDGE_MIMES: Array<[string, boolean]> = [
  ['video/mp4; codecs="avc1.640028"', true],
  ['video/mp4; codecs="avc1.42E01E"', true],
  ['video/mp4; codecs="hvc1.1.6.L93.B0"', true],
  ['video/mp4; codecs="hvc1.2.4.L120.B0"', true],
  ['video/mp4; codecs="hev1.1.6.L93.B0"', true],
  ['video/mp4; codecs="av01.0.08M.08"', true],
  ['video/mp4; codecs="vp09.00.10.08"', true],
  ['video/mp4; codecs="mp4a.40.2"', true],
  ['video/mp4; codecs="mp4a.40.5"', true],
  ['video/mp4; codecs="ac-3"', true],
  ['video/mp4; codecs="ec-3"', true],
  ['video/mp4; codecs="fLaC"', true],
  // Not supported — the real blockers.
  ["video/x-matroska", false],
  ['video/x-matroska; codecs="avc1.640028,mp4a.40.2"', false],
  ['video/mp4; codecs="dtsc"', false],
  ['video/mp4; codecs="mlpa"', false],
  ['video/mp4; codecs="mp2v.61"', false],
  ['video/mp4; codecs="vc-1"', false],
  ['video/mp4; codecs="wmv3"', false],
  ['audio/mp4; codecs="wmav2"', false],
];

export const EDGE_CAPS: ClientCapabilities = {
  ...DEFAULT_CAPABILITIES,
  ua: "e2e-edge-chromium",
  mseSupported: true,
  codecs: EDGE_MIMES.map(([mime, ok]) => ({
    mime,
    canPlay: ok ? "probably" : "",
    mse: ok,
  })),
};

export function run(bin: string, args: string[], timeoutMs = 300_000) {
  const res = spawnSync(bin, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

export function probeFile(file: string): ProbeResult | null {
  const res = run(FFPROBE, [
    "-v", "quiet",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    file,
  ]);
  if (res.code !== 0) return null;
  const outcome = parseProbeOutput(res.stdout);
  return outcome.ok ? outcome.result : null;
}

/**
 * fMP4 segments are not standalone files — the moov lives in `init.mp4`. To
 * probe the output the way a player consumes it, concatenate the init segment
 * with the first media segment and probe the result.
 */
export function probeHlsOutput(outputDir: string): ProbeResult | null {
  const init = path.join(outputDir, "init.mp4");
  if (!fs.existsSync(init)) return null;
  const segs = fs.readdirSync(outputDir).filter((f) => f.endsWith(".m4s")).sort();
  if (segs.length === 0) return null;
  const joined = path.join(outputDir, "_joined.mp4");
  fs.writeFileSync(
    joined,
    Buffer.concat([fs.readFileSync(init), fs.readFileSync(path.join(outputDir, segs[0]))]),
  );
  const result = probeFile(joined);
  fs.rmSync(joined, { force: true });
  return result;
}

export type Fixture = {
  name: string;
  file: string;
  /** ffmpeg args after the shared `testsrc2`/`sine` inputs. */
  encode: string[];
  expectRung: "direct" | "remux" | "transcode-audio" | "transcode-full";
  /** Channels the pipeline must preserve end to end. */
  expectChannels: number | null;
};

/** Colour bars + a tone, the synthetic stand-in for a real release. */
export function inputArgs(seconds: number, channels: number): string[] {
  const dur = String(seconds);
  const args = ["-f", "lavfi", "-i", `testsrc2=size=640x360:rate=24:duration=${dur}`];
  if (channels > 0) {
    args.push("-f", "lavfi", "-i", `sine=frequency=440:duration=${dur}:sample_rate=48000`);
  }
  return args;
}

/**
 * The two fixtures that matter for a torrent-sourced run: a pure remux of
 * HEVC + Dolby 5.1 (the dominant Bluray shape) and a DTS 5.1 file that must be
 * re-encoded to E-AC-3 without losing a channel.
 */
export function torrentFixtures(seconds: number): Fixture[] {
  return [
    {
      name: "HEVC + AC-3 5.1 / MKV",
      file: "hevc_ac3_51.mkv",
      encode: [
        ...inputArgs(seconds, 6),
        "-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "log-level=none",
        "-pix_fmt", "yuv420p", "-g", "24",
        "-c:a", "ac3", "-ac", "6",
        "-shortest",
      ],
      expectRung: "remux",
      expectChannels: 6,
    },
    {
      name: "H.264 + DTS 5.1 / MKV",
      file: "h264_dts51.mkv",
      encode: [
        ...inputArgs(seconds, 6),
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "24",
        "-c:a", "dca", "-strict", "-2", "-ac", "6",
        "-shortest",
      ],
      expectRung: "transcode-audio",
      expectChannels: 6,
    },
  ];
}

/**
 * A single multi-audio fixture: English AC-3 5.1 first, Japanese AAC stereo
 * second. This is what the audio-track picker is driven against, and the
 * channel count is what proves switching a track does not silently downmix.
 */
export function multiAudioFixture(seconds: number): Fixture {
  return {
    name: "Multi-audio eng AC-3 5.1 + jpn AAC 2.0 / MKV",
    file: "multi_audio.mkv",
    encode: [
      ...inputArgs(seconds, 6),
      "-f", "lavfi", "-i", `sine=frequency=660:duration=${seconds}:sample_rate=48000`,
      "-map", "0:v:0", "-map", "1:a:0", "-map", "2:a:0",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "24",
      "-c:a:0", "ac3", "-ac:a:0", "6",
      "-metadata:s:a:0", "language=eng", "-metadata:s:a:0", "title=English 5.1",
      "-c:a:1", "aac", "-ac:a:1", "2",
      "-metadata:s:a:1", "language=jpn", "-metadata:s:a:1", "title=Japanese",
      "-shortest",
    ],
    expectRung: "remux",
    expectChannels: 6,
  };
}

export function generateFixture(fixture: Fixture, dir: string): string {
  const out = path.join(dir, fixture.file);
  const res = run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...fixture.encode, out]);
  if (res.code !== 0 || !fs.existsSync(out)) {
    const tail = res.stderr.trim().split("\n").slice(-3).join(" | ");
    throw new Error(`failed to generate ${fixture.file}: ${tail}`);
  }
  return out;
}

export function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const line = (cells: string[]) => cells.map((c, i) => pad(c ?? "", widths[i])).join("  ");
  return [line(headers), widths.map((w) => "─".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}
