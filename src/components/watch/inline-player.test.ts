import {
  bufferingLabel,
  encodeStreamFilePath,
  findSidecarSubtitle,
  infoHashFromMagnet,
  selectVideoFiles,
  streamPath,
  streamStatusMessage,
  type StreamFile,
} from "./inline-player";

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

console.log(
  failures === 0
    ? "\nPASS inline-player"
    : `\nFAIL inline-player (${failures})`,
);
process.exit(failures === 0 ? 0 : 1);
