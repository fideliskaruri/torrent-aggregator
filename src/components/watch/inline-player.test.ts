import {
  bufferedAheadOf,
  bufferedSourceRanges,
  bufferingLabel,
  encodeStreamFilePath,
  findSidecarSubtitle,
  infoHashFromMagnet,
  selectVideoFiles,
  streamPath,
  streamStatusMessage,
  type StreamFile,
} from "./inline-player";
import { peerText, rateText, swarmHealth, swarmSummary } from "./swarm-chip";

let failures = 0;

function assert(name: string, cond: boolean, detail = "") {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const files: StreamFile[] = [
  { path: "Show/Season 01/Show S01E01.mkv", length: 1_500_000_000, index: 0 },
  { path: "Show/Season 01/Show S01E01.srt", length: 42_000, index: 1 },
  { path: "Show/Season 01/Show S01E02.mp4", length: 1_200_000_000, index: 2 },
  { path: "Show/Season 01/poster.jpg", length: 90_000, index: 3 },
  { path: "Extras\\Interview.webm", length: 300_000_000, index: 4 },
];

const videos = selectVideoFiles(files);
assert("selects video files only", videos.length === 3, `${videos.length}`);
assert(
  "finds a same-basename sidecar subtitle",
  findSidecarSubtitle(files, "Show/Season 01/Show S01E01.mkv")?.path.endsWith(
    ".srt",
  ) === true,
);
assert(
  "does not attach unrelated subtitle files",
  findSidecarSubtitle(files, "Show/Season 01/Show S01E02.mp4") === undefined,
);

assert(
  "encodes each stream path segment without flattening folders",
  encodeStreamFilePath("Show Name/Season 01/Ep 01 [1080p].mkv") ===
    "Show%20Name/Season%2001/Ep%2001%20%5B1080p%5D.mkv",
);
assert(
  "builds the frozen stream URL",
  streamPath("abcdef", "A/B C.mkv") === "/api/stream/abcdef/A/B%20C.mkv",
);

assert(
  "extracts a hex btih magnet",
  infoHashFromMagnet(
    "magnet:?xt=urn:btih:0123456789ABCDEF0123456789ABCDEF01234567&dn=x",
  ) === "0123456789abcdef0123456789abcdef01234567",
);
assert(
  "extracts a base32 btih magnet",
  infoHashFromMagnet("magnet:?xt=urn:btih:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA") ===
    "0000000000000000000000000000000000000000",
);

const statuses: [number, string][] = [
  [409, "built-in engine"],
  [425, "still resolving"],
  [503, "No peers"],
  [404, "download it first"],
  [416, "byte range"],
];
for (const [status, expected] of statuses) {
  assert(
    `maps ${status} to human text`,
    streamStatusMessage(status).message.includes(expected),
    streamStatusMessage(status).message,
  );
}

assert(
  "buffering label uses real transfer numbers",
  bufferingLabel({ totalBytes: 30 * 1024 ** 2, progress: 0.4, peers: 4 }) ===
    "buffering — 12 MB / 30 MB · 4 peers",
);
assert(
  "buffering label degrades when only peer data exists",
  bufferingLabel({ peers: 1 }) === "buffering — waiting for torrent pieces · 1 peer",
);

// ── Buffered band ──
//
// The band is only honest if it is drawn in the coordinate space the viewer is
// looking at. In HLS mode the media element's timeline restarts at 0 for every
// ffmpeg session, so a band drawn from raw `video.buffered` would sit at the
// far left of the bar while the viewer watches at 1:50 — a confident lie about
// what is safe to watch. These cases pin the mapping.

/** Minimal stand-in for the DOM's TimeRanges. */
function timeRanges(pairs: Array<[number, number]>): TimeRanges {
  return {
    length: pairs.length,
    start: (i: number) => pairs[i][0],
    end: (i: number) => pairs[i][1],
  } as TimeRanges;
}

assert(
  "buffered ranges are offset into the source timeline",
  JSON.stringify(bufferedSourceRanges(timeRanges([[0, 12]]), 90, 150)) ===
    JSON.stringify([{ start: 90, end: 102 }]),
  JSON.stringify(bufferedSourceRanges(timeRanges([[0, 12]]), 90, 150)),
);
assert(
  "a session that starts at 0 needs no offset",
  bufferedSourceRanges(timeRanges([[0, 8]]), 0, 150)[0].end === 8,
);
assert(
  "several ranges all move together",
  bufferedSourceRanges(timeRanges([[0, 4], [10, 20]]), 30, 150).length === 2 &&
    bufferedSourceRanges(timeRanges([[0, 4], [10, 20]]), 30, 150)[1].start === 40,
);
assert(
  "ranges are clamped to the source duration, never drawn past the bar",
  bufferedSourceRanges(timeRanges([[0, 400]]), 100, 150)[0].end === 150,
);
assert(
  "nothing is claimed when the duration is unknown",
  bufferedSourceRanges(timeRanges([[0, 10]]), 0, null).length === 0,
);
assert(
  "nothing is claimed when there is no buffer",
  bufferedSourceRanges(timeRanges([]), 0, 150).length === 0 &&
    bufferedSourceRanges(null, 0, 150).length === 0,
);
assert(
  "an infinite range is dropped rather than painted",
  bufferedSourceRanges(timeRanges([[0, Number.POSITIVE_INFINITY]]), 0, 150).length === 0,
);
assert(
  "a zero-width range is dropped",
  bufferedSourceRanges(timeRanges([[5, 5]]), 0, 150).length === 0,
);

assert(
  "buffer ahead is measured from the playhead inside its own range",
  bufferedAheadOf([{ start: 90, end: 102 }], 95) === 7,
);
assert(
  "a range the playhead is not inside buys nothing",
  bufferedAheadOf([{ start: 120, end: 140 }], 95) === 0,
);
assert(
  "with no buffer there is nothing ahead",
  bufferedAheadOf([], 95) === 0,
);

// ── Swarm health ──
//
// The chip must never invent a healthy state. "No data" and "no peers" are
// different answers and the viewer needs to be able to tell them apart.

assert("no sample at all is unknown, not zero", swarmHealth(null) === "unknown");
assert(
  "null peers and null rate is unknown",
  swarmHealth({ peers: null, downloadSpeedBps: null, progress: null, observedAt: 0 }) ===
    "unknown",
);
assert(
  "zero peers is stalled",
  swarmHealth({ peers: 0, downloadSpeedBps: 0, progress: 0, observedAt: 0 }) === "stalled",
);
assert(
  "peers with no bytes yet is thin, not stalled",
  swarmHealth({ peers: 3, downloadSpeedBps: 0, progress: 0, observedAt: 0 }) === "thin",
);
assert(
  "peers and bytes is live",
  swarmHealth({ peers: 3, downloadSpeedBps: 250_000, progress: 0.2, observedAt: 0 }) ===
    "live",
);
assert(
  "a finished torrent is live even with no peers and no rate — it plays off disk",
  swarmHealth({ peers: 0, downloadSpeedBps: 0, progress: 1, observedAt: 0 }) === "live",
);
assert(
  "a finished torrent still says so when the peer count is unknown",
  swarmHealth({ peers: null, downloadSpeedBps: 0, progress: 1, observedAt: 0 }) === "live",
);
assert(
  "completion does not paper over a total absence of data",
  swarmHealth({ peers: null, downloadSpeedBps: null, progress: 1, observedAt: 0 }) ===
    "unknown",
);
assert(
  "a finished torrent's summary says it is playing from disk",
  /disk/i.test(swarmSummary({ peers: 0, downloadSpeedBps: 0, progress: 1, observedAt: 0 })),
  swarmSummary({ peers: 0, downloadSpeedBps: 0, progress: 1, observedAt: 0 }),
);
assert(
  "an unknown peer count says so instead of showing 0",
  peerText(null) === "peers unknown" && peerText(0) === "0 peers" && peerText(1) === "1 peer",
  `${peerText(null)} / ${peerText(0)} / ${peerText(1)}`,
);
assert(
  "an unknown rate says so instead of showing 0 B/s",
  rateText(null) === "rate unknown" && rateText(0).startsWith("0"),
  `${rateText(null)} / ${rateText(0)}`,
);
assert(
  "the spoken summary never claims seeders",
  !/seed/i.test(
    swarmSummary({ peers: 4, downloadSpeedBps: 100, progress: 0.1, observedAt: 0 }),
  ),
  swarmSummary({ peers: 4, downloadSpeedBps: 100, progress: 0.1, observedAt: 0 }),
);
assert(
  "the spoken summary admits ignorance",
  /unknown/i.test(swarmSummary(null)),
  swarmSummary(null),
);

console.log(
  failures === 0
    ? "\nPASS inline-player"
    : `\nFAIL inline-player (${failures})`,
);
process.exit(failures === 0 ? 0 : 1);
