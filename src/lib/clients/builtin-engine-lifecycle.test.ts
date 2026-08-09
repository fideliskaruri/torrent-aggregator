import assert from "node:assert/strict";
import {
  persistedTorrentDisplayState,
  persistedTorrentHasInvalidMedia,
  persistedTorrentIsDownloaded,
  shouldRehydrateTorrent,
} from "./builtin-engine-lifecycle";

const source = { magnet: "magnet:?xt=urn:btih:abc", torrentUrl: null };
const verifiedVideo = JSON.stringify([
  { path: "D:\\Media\\Episode.mkv", size: 100, mtimeMs: 1 },
]);

for (const [name, row, expected] of [
  ["active download", { ...source, status: "downloading", progress: 0.42 }, true],
  ["paused partial", { ...source, status: "paused", progress: 0.42 }, true],
  ["downloaded", { ...source, status: "downloaded", progress: 1, verifiedBitfield: "AQ==", verifiedFilesJson: verifiedVideo }, false],
  ["legacy seeding", { ...source, status: "seeding", progress: 1, verifiedBitfield: "AQ==", verifiedFilesJson: verifiedVideo }, false],
  ["legacy uploading", { ...source, status: "uploading", progress: 1, verifiedBitfield: "AQ==", verifiedFilesJson: verifiedVideo }, false],
  ["complete progress wins", { ...source, status: "downloading", progress: 1, verifiedBitfield: "AQ==", verifiedFilesJson: verifiedVideo }, false],
  ["invalid completed media", { ...source, status: "downloaded", progress: 1, verifiedBitfield: "AQ==", verifiedFilesJson: '[{"path":"D:\\\\Media\\\\Episode.scr"}]' }, false],
  ["parked", { ...source, status: "parked", progress: 0.42 }, false],
  ["removed", { ...source, status: "removed", progress: 0.42 }, false],
  ["error", { ...source, status: "error", progress: 0.42 }, false],
  ["no source", { status: "downloading", progress: 0.42, magnet: null, torrentUrl: null }, false],
] as const) {
  assert.equal(shouldRehydrateTorrent(row), expected, name);
}

for (const status of ["downloaded", "downloading", "paused", "unknown"]) {
  assert.equal(
    persistedTorrentIsDownloaded({
      status,
      progress: 1,
      verifiedBitfield: "AQ==",
      verifiedFilesJson: verifiedVideo,
    }),
    true,
    `verified completion does not depend on the persisted status ${status}`,
  );
}

assert.equal(
  persistedTorrentDisplayState({
    status: "seeding",
    progress: 1,
    verifiedBitfield: "AQ==",
    verifiedFilesJson: verifiedVideo,
  }),
  "downloaded",
);
const invalidMedia = {
  status: "downloaded",
  progress: 1,
  verifiedBitfield: "AQ==",
  verifiedFilesJson: '[{"path":"D:\\\\Media\\\\Episode.scr"}]',
};
assert.equal(persistedTorrentHasInvalidMedia(invalidMedia), true);
assert.equal(persistedTorrentIsDownloaded(invalidMedia), false);
assert.equal(persistedTorrentDisplayState(invalidMedia), "error");
assert.equal(shouldRehydrateTorrent({ ...source, ...invalidMedia }), false);
const mixedUnsafeMedia = {
  status: "downloaded",
  progress: 1,
  verifiedBitfield: "AQ==",
  verifiedFilesJson:
    '[{"path":"D:\\\\Media\\\\Episode.mkv"},{"path":"D:\\\\Media\\\\setup.exe"}]',
};
assert.equal(persistedTorrentHasInvalidMedia(mixedUnsafeMedia), false);
assert.equal(persistedTorrentIsDownloaded(mixedUnsafeMedia), true);
assert.equal(persistedTorrentDisplayState(mixedUnsafeMedia), "downloaded");
assert.equal(shouldRehydrateTorrent({ ...source, ...mixedUnsafeMedia }), false);
assert.equal(
  persistedTorrentDisplayState({ status: "paused", progress: 0.4 }),
  "paused",
);
assert.equal(
  persistedTorrentDisplayState({ status: "downloading", progress: 0.4 }),
  "downloading",
);
assert.equal(
  persistedTorrentDisplayState({ status: "downloading", progress: 0 }),
  "metaDL",
);
