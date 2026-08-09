/**
 * Playback strategy for files that are already 100% on local disk.
 *
 * ## The problem this exists to solve
 *
 * `session.ts` keys a session by infoHash + filePath + audio track + **seek
 * offset**, and emits `-hls_playlist_type event` — a playlist that grows as
 * ffmpeg produces. That is the only correct design for an *incomplete* torrent,
 * because the future timeline genuinely does not exist yet.
 *
 * It is also the reason seeking stutters: every seek is a new session key, a
 * new ffmpeg with `-ss <offset>`, and a new playlist rebased to media time
 * zero, so hls.js must tear the whole stream down and reload it.
 *
 * For a file that is already complete on disk the entire timeline is known up
 * front, so none of that is necessary. This module holds the pure decisions and
 * arithmetic for two strategies that give instant seeking:
 *
 *   - `whole-file` — one background pass converts the file with ffmpeg's own
 *     HLS muxer in `single_file` + `vod` mode, producing a complete VOD
 *     playlist and one `data.m4s` on disk. Every seek is then a byte-range read
 *     of a timeline the player already knows in full. Used whenever the video
 *     stream can be copied, which is the common MKV case: `remux` and
 *     `transcode-audio`.
 *
 *   - `vod-segments` — a true VOD playlist emitted immediately with no encode
 *     at all, plus stateless per-segment ffmpeg on demand. Used when the video
 *     has to be re-encoded (`transcode-full`), where converting the whole file
 *     up front would take longer than the film.
 *
 * ## Why the two strategies split on "can the video be copied", not on rung
 *
 * Segment boundaries have to be keyframe-aligned or an independently produced
 * segment starts mid-GOP and shows corruption. When ffmpeg re-encodes it can be
 * *made* to put a keyframe exactly on the boundary (`-force_key_frames`), so a
 * fixed grid is safe. When it copies it cannot move keyframes, and measurement
 * on this machine (scripts/_vod-probe2.mts) showed the two containers behave
 * differently:
 *
 *     MP4 source, `-ss 12` → first packet at exactly 12.000 (keyframe)
 *     MKV source, `-ss 12` → first packet at 10.000 — one GOP early
 *
 * Matroska's seek index is per-cluster, so ffmpeg lands on the keyframe before
 * the cluster. `-copyts` keeps the timestamps truthful, so that is overlap
 * rather than drift, but it means a copy-path segment cannot be trusted to
 * start where the playlist says. Converting the file once and seeking natively
 * sidesteps the whole problem, is cheaper (no per-seek work at all), and is
 * what Jellyfin/Plex do for "direct stream" content. Hence: copy → whole file,
 * encode → segments.
 */
import type { PlaybackPlan } from "./decide";
import { SEGMENT_SECONDS } from "./session";

/** Segment length for the VOD ladder. Same grid as the session path. */
export const VOD_SEGMENT_SECONDS = SEGMENT_SECONDS;

/**
 * A trailing segment shorter than this is folded into its predecessor.
 * A 30 ms segment is a rounding artefact, not a segment, and some players
 * stall trying to fetch one.
 */
export const MIN_TAIL_SECONDS = 0.5;

export type VodSegment = {
  index: number;
  /** Start on the *source* timeline, seconds. */
  start: number;
  /** Duration in seconds. */
  duration: number;
};

// ── Strategy selection ──

export type VodStrategy = "session" | "whole-file" | "vod-segments";

export type StrategyInput = {
  /** Is the file 100% downloaded and present on local disk? */
  complete: boolean;
  plan: PlaybackPlan;
  /** Known source duration in seconds, from the cached probe. */
  duration: number | null;
};

export type StrategyDecision = { strategy: VodStrategy; reason: string };

/**
 * Choose how to serve a request.
 *
 * The `session` answer is the existing behaviour and must stay reachable for
 * every case the new strategies cannot serve — an incomplete torrent, a file
 * whose duration is unknown (the playlist maths need it), or a plan with no
 * video stream at all.
 */
export function chooseStrategy(input: StrategyInput): StrategyDecision {
  const { complete, plan, duration } = input;

  if (plan.rung === "direct") {
    return { strategy: "session", reason: "direct play needs no ffmpeg" };
  }
  if (!complete) {
    return { strategy: "session", reason: "file is not fully downloaded yet" };
  }
  if (duration === null || !Number.isFinite(duration) || duration <= 0) {
    return { strategy: "session", reason: "source duration is unknown" };
  }
  if (!plan.video) {
    return { strategy: "session", reason: "no video stream to segment" };
  }
  if (plan.video.action === "copy") {
    return {
      strategy: "whole-file",
      reason: "video can be copied — one conversion gives native seeking",
    };
  }
  return {
    strategy: "vod-segments",
    reason: "video must be re-encoded — segment on demand from a VOD playlist",
  };
}

// ── Playlist arithmetic ──

/**
 * Even grid of `segmentSeconds` starting at zero, with the remainder as a
 * final short segment. Correct only when ffmpeg is re-encoding, because only
 * then can a keyframe be forced onto every boundary.
 */
export function fixedGridSegments(
  duration: number,
  segmentSeconds: number = VOD_SEGMENT_SECONDS,
): VodSegment[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  if (!Number.isFinite(segmentSeconds) || segmentSeconds <= 0) return [];

  const count = Math.ceil(round3(duration / segmentSeconds));
  const segments: VodSegment[] = [];
  for (let i = 0; i < count; i += 1) {
    const start = i * segmentSeconds;
    segments.push({
      index: i,
      start,
      duration: round3(Math.min(segmentSeconds, duration - start)),
    });
  }
  return mergeShortTail(segments);
}

/**
 * Boundaries taken from the source's real keyframe positions: the first
 * keyframe at or after `start + targetSeconds` ends each segment.
 *
 * This is what a copy path would need. It is exported and tested because the
 * arithmetic is the same shape as the fixed grid and getting it wrong is
 * silent, but note the module header: the shipped copy path converts the whole
 * file instead, precisely because MKV cannot be relied on to seek to the
 * boundary the grid names.
 */
export function keyframeAlignedSegments(
  keyframeTimes: number[],
  duration: number,
  targetSeconds: number = VOD_SEGMENT_SECONDS,
): VodSegment[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  if (!Number.isFinite(targetSeconds) || targetSeconds <= 0) return [];

  const keys = keyframeTimes
    .filter((t) => Number.isFinite(t) && t >= 0 && t < duration)
    .sort((a, b) => a - b);
  if (keys.length === 0) return fixedGridSegments(duration, targetSeconds);

  // A source whose first keyframe is not at zero cannot be cut at zero either;
  // start where the decodable data actually starts.
  const boundaries: number[] = [keys[0]];
  let cursor = 0;
  for (;;) {
    const target = boundaries[boundaries.length - 1] + targetSeconds;
    while (cursor < keys.length && keys[cursor] < target) cursor += 1;
    if (cursor >= keys.length) break;
    boundaries.push(keys[cursor]);
  }

  const segments: VodSegment[] = boundaries.map((start, i) => ({
    index: i,
    start: round3(start),
    duration: round3((i + 1 < boundaries.length ? boundaries[i + 1] : duration) - start),
  }));
  return mergeShortTail(segments);
}

function mergeShortTail(segments: VodSegment[]): VodSegment[] {
  if (segments.length < 2) return segments;
  const last = segments[segments.length - 1];
  if (last.duration >= MIN_TAIL_SECONDS) return segments;
  const head = segments.slice(0, -1);
  const prev = head[head.length - 1];
  head[head.length - 1] = { ...prev, duration: round3(prev.duration + last.duration) };
  return head;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export type PlaylistOptions = {
  /** URI of the shared fMP4 initialisation segment. */
  initUri: string;
  /** URI for segment `index`. */
  segmentUri: (index: number) => string;
};

/**
 * A complete VOD playlist — every segment, and `#EXT-X-ENDLIST`.
 *
 * This is the whole point of the strategy: the player learns the full timeline
 * at t=0, so a seek is a segment fetch instead of a session restart.
 */
export function buildVodPlaylist(segments: VodSegment[], options: PlaylistOptions): string {
  const target = segments.reduce((max, s) => Math.max(max, s.duration), 0);
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(target))}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    "#EXT-X-INDEPENDENT-SEGMENTS",
    `#EXT-X-MAP:URI="${options.initUri}"`,
  ];
  for (const segment of segments) {
    lines.push(`#EXTINF:${segment.duration.toFixed(6)},`);
    lines.push(options.segmentUri(segment.index));
  }
  lines.push("#EXT-X-ENDLIST");
  return lines.join("\n") + "\n";
}

// ── Playlist trimming ──

export type TrimmedPlaylist = {
  text: string;
  /** Source-timeline position the trimmed playlist now starts at. */
  offsetSeconds: number;
};

/**
 * Drop every segment that ends before `fromSeconds`, keeping the header.
 *
 * This exists for one specific moment: a viewer is part way through a file on
 * the session path, the background conversion finishes, and they seek. The
 * answer to that seek should be the VOD playlist — but the player always
 * attaches hls.js at position zero, so handing it the full playlist would
 * silently throw the seek away and restart the film. Trimming makes media time
 * zero *be* the seek target, and because everything after it is still listed
 * with an `#EXT-X-ENDLIST`, every later seek is instant.
 *
 * Only whole `#EXTINF` groups are removed, so the returned offset is the start
 * of the segment containing the target rather than the target itself — cutting
 * inside a segment would mean re-muxing it.
 */
export function trimVodPlaylist(playlist: string, fromSeconds: number): TrimmedPlaylist {
  if (!Number.isFinite(fromSeconds) || fromSeconds <= 0) {
    return { text: playlist, offsetSeconds: 0 };
  }

  const lines = playlist.split(/\r?\n/);
  const header: string[] = [];
  const groups: Array<{ start: number; duration: number; lines: string[] }> = [];
  let current: string[] | null = null;
  let duration = 0;
  let cursor = 0;
  let trailer = "";

  for (const line of lines) {
    if (line.startsWith("#EXTINF:")) {
      current = [line];
      duration = Number(line.slice("#EXTINF:".length).split(",")[0]);
      if (!Number.isFinite(duration)) duration = 0;
      continue;
    }
    if (line === "#EXT-X-ENDLIST") {
      trailer = line;
      continue;
    }
    if (current === null) {
      if (line.trim()) header.push(line);
      continue;
    }
    current.push(line);
    if (!line.startsWith("#") && line.trim()) {
      groups.push({ start: cursor, duration, lines: current });
      cursor = Math.round((cursor + duration) * 1000) / 1000;
      current = null;
    }
  }

  if (groups.length === 0) return { text: playlist, offsetSeconds: 0 };

  let firstIndex = groups.findIndex((group) => group.start + group.duration > fromSeconds);
  if (firstIndex < 0) firstIndex = groups.length - 1;
  const kept = groups.slice(firstIndex);

  const rewrittenHeader = header.map((line) =>
    line.startsWith("#EXT-X-MEDIA-SEQUENCE:") ? `#EXT-X-MEDIA-SEQUENCE:${firstIndex}` : line,
  );
  const text = [
    ...rewrittenHeader,
    ...kept.flatMap((group) => group.lines),
    trailer || "#EXT-X-ENDLIST",
  ].join("\n");

  return { text: text + "\n", offsetSeconds: kept[0].start };
}

// ── ffprobe keyframe index ──

/**
 * Parse `ffprobe -show_packets -show_entries packet=pts_time,flags -of csv=p=0`.
 *
 * ffprobe 4.0.2 (the bundled build — note it is older than the bundled ffmpeg
 * 6.1.1) emits `12.000000,K_` per packet, and `N/A` for packets with no
 * timestamp. Only keyframes are interesting, and they must come out sorted and
 * deduplicated because a container with a broken index can repeat them.
 */
export function parseKeyframeTimes(csv: string): number[] {
  const seen = new Set<number>();
  for (const line of csv.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [rawTime, rawFlags] = trimmed.split(",");
    if (!rawFlags || !rawFlags.includes("K")) continue;
    const time = Number(rawTime);
    if (!Number.isFinite(time) || time < 0) continue;
    seen.add(round3(time));
  }
  return Array.from(seen).sort((a, b) => a - b);
}

// ── fMP4 box splitting ──

export type SplitFragment = { init: Buffer; media: Buffer } | null;

/**
 * Split a self-contained fragmented MP4 into its initialisation part
 * (`ftyp` + `moov`) and its media part (`moof` onwards).
 *
 * Each segment is produced by an independent ffmpeg, so each output carries its
 * own `moov`. HLS wants one shared `#EXT-X-MAP` init segment and bare
 * `moof`+`mdat` media segments, and since every segment is produced with
 * identical codec arguments the `moov` is byte-identical across them — so the
 * first one produced can serve as the init for all of them.
 *
 * Returns null if the buffer is not a well-formed box sequence containing a
 * `moof`, which is the honest answer for a truncated or failed ffmpeg run.
 */
export function splitFragmentedMp4(buffer: Buffer): SplitFragment {
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    if (type === "moof") {
      if (offset === 0) return null; // no init part at all
      return { init: buffer.subarray(0, offset), media: buffer.subarray(offset) };
    }
    // `size === 1` means a 64-bit largesize follows; `size === 0` means "to end
    // of file". Neither can precede the first moof in ffmpeg's output, and
    // guessing would silently corrupt the split.
    if (size < 8 || offset + size > buffer.length) return null;
    offset += size;
  }
  return null;
}

// ── ffmpeg argument construction ──

/**
 * Bounded input options. A local file cannot stall the way a torrent can, but a
 * malformed one can still make ffprobe/ffmpeg read forever looking for streams.
 */
const ANALYZE_ARGS = ["-analyzeduration", "10000000", "-probesize", "10000000"];

export type VodSegmentArgsInput = {
  /** Absolute path of the completed file on disk. */
  sourcePath: string;
  plan: PlaybackPlan;
  segment: VodSegment;
  /**
   * Accepted for call-site symmetry with {@link planVodSegments}; the segment's
   * own `start`/`duration` fully determine the arguments, so the grid size is
   * deliberately not used here.
   */
  segmentSeconds?: number;
  /** Use the deterministic software encoder for the VOD rendition. */
  forceSoftware?: boolean;
};

/**
 * ffmpeg arguments producing exactly one self-contained fMP4 segment.
 *
 * Two things here are load-bearing and were established by measurement:
 *
 *  - `-ss` goes **before** `-i` (input seeking). Output seeking decodes and
 *    discards everything before the target, which turns a seek to 55 minutes
 *    into 55 minutes of work. `session.test.ts` asserts the same rule.
 *  - `-copyts` keeps source timestamps, so the fragment's
 *    `baseMediaDecodeTime` is its true position on the timeline. Without it
 *    every independently produced segment would claim to start at zero and the
 *    player would stack them all on top of each other.
 */
export function buildVodSegmentArgs(input: VodSegmentArgsInput): string[] {
  const { sourcePath, plan, segment, forceSoftware = false } = input;
  const end = round3(segment.start + segment.duration);

  const args = ["-hide_banner", "-loglevel", "error", ...ANALYZE_ARGS, "-copyts"];
  if (segment.start > 0) args.push("-ss", String(segment.start));
  args.push("-i", sourcePath, "-to", String(end));

  if (plan.video) args.push("-map", `0:${plan.video.streamIndex}`);
  const audio = plan.audio.find((a) => a.streamIndex === plan.selectedAudioIndex);
  if (audio) args.push("-map", `0:${audio.streamIndex}`);

  if (plan.video) {
    if (plan.video.action === "copy") {
      args.push("-c:v", "copy");
      if (plan.video.codec === "hevc") args.push("-tag:v", "hvc1");
    } else {
      const softwareEncoder =
        plan.video.targetCodec === "hevc" || plan.video.targetCodec === "libx265"
          ? "libx265"
          : "libx264";
      const encoder =
        !forceSoftware && plan.video.hwAccel ? plan.video.hwAccel : softwareEncoder;
      args.push("-c:v", encoder);
      if (encoder === "libx264" || encoder === "libx265") {
        args.push("-preset", "veryfast", "-crf", "23");
      }
      // Each invocation produces exactly ONE segment, so the only keyframe that
      // matters is the one at this segment's own start. This must be the
      // *timestamp-list* form, not an expression: under `-copyts` `t` is the
      // absolute source time, so `expr:gte(t,start)` is true for every frame in
      // the segment and ffmpeg forces an IDR on all of them — spiking bitrate
      // and encode latency, which is the post-seek jitter. A bare timestamp
      // list forces exactly one keyframe at that absolute time.
      args.push(
        "-force_key_frames",
        String(segment.start),
        "-sc_threshold",
        "0",
        "-pix_fmt",
        "yuv420p",
      );
    }
  }

  if (audio) {
    if (audio.action === "copy") {
      args.push("-c:a", "copy");
    } else {
      // Never downmix. The owner's rule: 5.1 in, 5.1 out.
      args.push("-c:a", audio.targetCodec ?? "eac3", "-ac", String(audio.channels));
    }
  }

  args.push(
    "-sn",
    "-dn",
    "-map_chapters",
    "-1",
    "-avoid_negative_ts",
    "disabled",
    "-movflags",
    // `delay_moov` is required: ffmpeg cannot write the moov before it has seen
    // an AC-3 packet ("codec frame size is not set"), and without it every
    // Dolby segment fails to open at all.
    "frag_keyframe+empty_moov+default_base_moof+delay_moov",
    "-f",
    "mp4",
  );
  return args;
}

/** Names ffmpeg writes into a whole-file conversion directory. */
export const WHOLE_FILE_PLAYLIST = "playlist.m3u8";
export const WHOLE_FILE_DATA = "data.m4s";

export type WholeFileArgsInput = {
  sourcePath: string;
  plan: PlaybackPlan;
  segmentSeconds?: number;
};

/**
 * ffmpeg arguments for the one-shot whole-file conversion.
 *
 * This is ffmpeg's own HLS muxer in `single_file` + `vod` mode, which is worth
 * spelling out because it does three things by itself that hand-rolling would
 * get wrong:
 *
 *  - it cuts on real keyframes, so with `-c:v copy` every segment boundary is
 *    guaranteed decodable — the hazard that rules out producing copy segments
 *    independently (see the module header);
 *  - it writes the true `#EXTINF` for each cut, so the timeline is exact rather
 *    than a nominal grid;
 *  - `single_file` emits one `data.m4s` plus a playlist of `#EXT-X-BYTERANGE`
 *    entries, so a 2-hour film is one file on disk instead of ~1800, and a seek
 *    is a byte-range read.
 *
 * `temp_file` is deliberately **not** in the flags. Measured: with `single_file`
 * ffmpeg leaves the temporary name in the playlist (`data.m4s.tmp`) after
 * renaming the file on disk, so every URI in the manifest 404s.
 *
 * Filenames are relative because ffmpeg resolves HLS outputs against its
 * working directory, not against the playlist path — the same rule the session
 * path is bound by.
 */
export function buildWholeFileHlsArgs(input: WholeFileArgsInput): string[] {
  const { sourcePath, plan } = input;
  const segmentSeconds = input.segmentSeconds ?? VOD_SEGMENT_SECONDS;
  const args = ["-hide_banner", "-loglevel", "error", "-y", ...ANALYZE_ARGS, "-i", sourcePath];

  if (plan.video) args.push("-map", `0:${plan.video.streamIndex}`);
  const audio = plan.audio.find((a) => a.streamIndex === plan.selectedAudioIndex);
  if (audio) args.push("-map", `0:${audio.streamIndex}`);

  if (plan.video) {
    args.push("-c:v", "copy");
    if (plan.video.codec === "hevc") args.push("-tag:v", "hvc1");
  }
  if (audio) {
    if (audio.action === "copy") {
      args.push("-c:a", "copy");
    } else {
      // Never downmix. The owner's rule: 5.1 in, 5.1 out.
      args.push("-c:a", audio.targetCodec ?? "eac3", "-ac", String(audio.channels));
    }
  }

  args.push(
    "-sn",
    "-dn",
    "-map_chapters",
    "-1",
    "-f",
    "hls",
    "-hls_time",
    String(segmentSeconds),
    "-hls_list_size",
    "0",
    "-hls_playlist_type",
    "vod",
    "-hls_segment_type",
    "fmp4",
    "-hls_flags",
    "single_file+independent_segments",
    "-hls_segment_filename",
    WHOLE_FILE_DATA,
    WHOLE_FILE_PLAYLIST,
  );
  return args;
}

/**
 * ffprobe arguments for the keyframe index of a local file.
 *
 * `-show_packets` rather than `-show_frames`: packets carry the keyframe flag
 * without decoding, so this is an index read rather than a decode of the whole
 * file. ffprobe 4.0.2 supports both, but `-show_frames` on a 2-hour 4K file
 * takes minutes.
 */
export function buildKeyframeProbeArgs(sourcePath: string): string[] {
  return [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_packets",
    "-show_entries",
    "packet=pts_time,flags",
    "-of",
    "csv=p=0",
    sourcePath,
  ];
}
