/**
 * In-pack next-episode resolution tests.
 *
 * The behaviour under test is the one that makes "Next episode" instant when
 * the successor is already inside the season pack on screen: the file is named
 * from the pack's own verified files, as a torrent-relative path, with no
 * indexer search and no acquisition.
 *
 * Run: npx tsx src/lib/prewarm/next-episode-file.test.ts
 */
import assert from "node:assert/strict";
import path from "node:path";
import { episodeFileInTorrent, torrentRelativeFilePath } from "./next-episode-file";

let failures = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
  }
}

const ROOT = path.resolve("D:", "Downloads");
const packDir = (name: string) => path.join(ROOT, "Severance.S02.1080p", name);

function verified(names: string[], size = 4_000_000_000): string {
  return JSON.stringify(
    names.map((name) => ({ path: packDir(name), size, mtimeMs: 1 })),
  );
}

const pack = {
  savePath: ROOT,
  verifiedFilesJson: verified([
    "Severance.S02E01.1080p.mkv",
    "Severance.S02E02.1080p.mkv",
    "Severance.S02E03.1080p.mkv",
  ]),
};

check("given a season pack, when the next episode is inside it, the exact torrent-relative file is returned", () => {
  assert.equal(
    episodeFileInTorrent(pack, 2, 2),
    "Severance.S02.1080p/Severance.S02E02.1080p.mkv",
  );
});

check("given a season pack, when the episode is not in it, no file is invented", () => {
  assert.equal(episodeFileInTorrent(pack, 2, 9), null);
});

check("given a season pack, when a different season is asked for, no file is returned", () => {
  assert.equal(episodeFileInTorrent(pack, 3, 1), null);
});

check("given a missing season or episode number, the lookup returns null", () => {
  assert.equal(episodeFileInTorrent(pack, null, 1), null);
  assert.equal(episodeFileInTorrent(pack, 2, null), null);
});

check("given no verified files, the lookup returns null", () => {
  assert.equal(episodeFileInTorrent({ savePath: ROOT, verifiedFilesJson: null }, 2, 1), null);
  assert.equal(episodeFileInTorrent({ savePath: ROOT, verifiedFilesJson: "[]" }, 2, 1), null);
  assert.equal(episodeFileInTorrent({ savePath: ROOT, verifiedFilesJson: "not json" }, 2, 1), null);
});

check("given no recorded save root, no path is guessed", () => {
  assert.equal(episodeFileInTorrent({ savePath: null, verifiedFilesJson: pack.verifiedFilesJson }, 2, 2), null);
});

check("given a featurette that parses as an episode, it never maps onto a real one", () => {
  const withExtras = {
    savePath: ROOT,
    verifiedFilesJson: verified([
      "Featurettes/Severance.S02E02.Behind.mkv",
    ]),
  };
  assert.equal(episodeFileInTorrent(withExtras, 2, 2), null);
});

check("given a non-video file for the episode, it is not offered as playable media", () => {
  const subsOnly = {
    savePath: ROOT,
    verifiedFilesJson: verified(["Severance.S02E02.1080p.srt"]),
  };
  assert.equal(episodeFileInTorrent(subsOnly, 2, 2), null);
});

check("given two files for one episode, the larger is chosen", () => {
  const both = {
    savePath: ROOT,
    verifiedFilesJson: JSON.stringify([
      { path: packDir("Severance.S02E02.720p.mkv"), size: 1_000, mtimeMs: 1 },
      { path: packDir("Severance.S02E02.2160p.mkv"), size: 9_000, mtimeMs: 1 },
    ]),
  };
  assert.equal(episodeFileInTorrent(both, 2, 2), "Severance.S02.1080p/Severance.S02E02.2160p.mkv");
});

check("given a file outside the save root, no path escapes the torrent", () => {
  assert.equal(
    torrentRelativeFilePath(ROOT, path.resolve("D:", "Elsewhere", "x.mkv")),
    null,
  );
});

check("given a relative recorded path, nothing is resolved from it", () => {
  assert.equal(torrentRelativeFilePath(ROOT, "x.mkv"), null);
});

check("given a nested file, the returned path uses forward slashes", () => {
  assert.equal(
    torrentRelativeFilePath(ROOT, path.join(ROOT, "Pack", "Season 2", "e02.mkv")),
    "Pack/Season 2/e02.mkv",
  );
});

console.log(
  `\n${failures === 0 ? "next-episode-file: all tests passed" : `next-episode-file: ${failures} failing`}`,
);
process.exit(failures === 0 ? 0 : 1);
