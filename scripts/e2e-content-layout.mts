/**
 * End-to-end check that the release-root rewrite puts real bytes in the right
 * place. This is not a mock: it builds actual torrents from actual nested
 * folders, seeds them from one WebTorrent client, downloads them over a real
 * socket into a second client, and then looks at the filesystem.
 *
 * Run: npm run test:torrent
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import WebTorrent from "webtorrent";
import type { Torrent } from "webtorrent";
import { patchWebTorrentContentLayout } from "../src/lib/clients/content-layout";

const EMBER_OUTER = "Solo Leveling 1080p Dual Audio BDRip 10 bits DD+ x265-EMBER";
const EMBER_INNER = "Solo Leveling S01 1080p Dual Audio BDRip 10 bits DD+ x265-EMBER";
const YTS = "Dune Part Two (2024) [2160p] [4K] [WEB] [5.1] [YTS.MX]";

type Scenario = {
  label: string;
  /** Folder to seed, relative to the seed root. */
  root: string;
  /** Files inside that folder, with their relative paths. */
  files: string[];
  /** Where the download is told to go — our smart path. */
  dest: string[];
  /** What must exist under dest afterwards. */
  expect: string[];
};

const SCENARIOS: Scenario[] = [
  {
    label: "EMBER anime pack (release name nested twice)",
    root: EMBER_OUTER,
    files: [
      `${EMBER_INNER}/Solo Leveling S01E01.mkv`,
      `${EMBER_INNER}/Solo Leveling S01E02.mkv`,
      `${EMBER_INNER}/Subs/S01E01.eng.srt`,
    ],
    dest: ["Anime", "Solo Leveling", "Season 01"],
    expect: [
      "Solo Leveling S01E01.mkv",
      "Solo Leveling S01E02.mkv",
      "Subs/S01E01.eng.srt",
    ],
  },
  {
    label: "YTS movie (single release root)",
    root: YTS,
    files: ["Dune.Part.Two.2024.2160p.mp4", "www.YTS.MX.jpg"],
    dest: ["Movies", "Dune Part Two"],
    expect: ["Dune.Part.Two.2024.2160p.mp4", "www.YTS.MX.jpg"],
  },
  {
    // Being an only child is not a reason to drop a folder: players look for
    // VIDEO_TS by name, so the container root goes and the structure stays.
    label: "DVD rip (VIDEO_TS must survive)",
    root: "Some.Film.2001.DVDRip.XviD-GROUP",
    files: ["VIDEO_TS/VIDEO_TS.IFO", "VIDEO_TS/VTS_01_1.VOB"],
    dest: ["Movies", "Some Film"],
    expect: ["VIDEO_TS/VIDEO_TS.IFO", "VIDEO_TS/VTS_01_1.VOB"],
  },
];

/** Deterministic filler so we can compare what came out with what went in. */
function fill(seed: string, bytes: number): Buffer {
  const out = Buffer.alloc(bytes);
  let block = createHash("sha256").update(seed).digest();
  for (let i = 0; i < bytes; i += block.length) {
    block.copy(out, i);
    block = createHash("sha256").update(block).digest();
  }
  return out;
}

function sha(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function walk(dir: string, base = dir): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory()
      ? walk(full, base)
      : [path.relative(base, full).split(path.sep).join("/")];
  });
}

function timeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms),
    ),
  ]);
}

async function main() {
  // Ownership is what stops two releases writing over each other; the real
  // engine persists it to a sidecar, here an in-process map is enough.
  const owners = new Map<string, string>();
  const key = (dest: string, rel: string) => `${path.resolve(dest)}\u0000${rel}`;

  const patched = await patchWebTorrentContentLayout(
    (dest, rel) => {
      try {
        const st = fs.lstatSync(path.join(dest, rel));
        return {
          size: st.size,
          owner: owners.get(key(dest, rel)) ?? null,
          isDirectory: st.isDirectory(),
        };
      } catch {
        return null;
      }
    },
    (infoHash, dest, paths) => {
      for (const rel of paths) owners.set(key(dest, rel), infoHash.toLowerCase());
      return true;
    },
  );
  assert.equal(patched, true, "the WebTorrent prototype patch must apply");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tf-e2e-"));
  const seedRoot = path.join(tmp, "seed");
  const downloadRoot = path.join(tmp, "downloads");

  // Real clients on real sockets. No trackers, no DHT — the leecher is told
  // about the seeder directly, so the test never touches the network.
  const seeder = new WebTorrent({ dht: false, lsd: false, tracker: false });
  const leecher = new WebTorrent({ dht: false, lsd: false, tracker: false });

  let failures = 0;

  try {
    for (const scenario of SCENARIOS) {
      console.log(`\n${scenario.label}`);

      const source = path.join(seedRoot, scenario.root);
      const expectedHashes = new Map<string, string>();
      scenario.files.forEach((rel, i) => {
        const full = path.join(source, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, fill(rel, 512 * 1024));
        expectedHashes.set(scenario.expect[i], sha(full));
      });

      const seeded = await timeout(
        new Promise<Torrent>((resolve) => {
          seeder.seed(source, { announce: [] }, resolve);
        }),
        60_000,
        "seed",
      );

      const published = seeded.files ?? [];
      console.log(`  torrent name: ${seeded.name}`);
      console.log(`  torrent paths as published:`);
      for (const f of published) console.log(`    ${f.path}`);
      assert.ok(published.length > 0, "the seeder must expose its files");
      assert.ok(
        published.every((f) => f.path.replace(/\\/g, "/").includes("/")),
        "the seeder must publish the nested layout unchanged",
      );

      const dest = path.join(downloadRoot, ...scenario.dest);
      const got = leecher.add(seeded.torrentFile, { path: dest });
      got.on("metadata", () => {
        console.log(`  paths after the rewrite:`);
        for (const f of got.files ?? []) console.log(`    ${f.path}`);
      });
      got.once("infoHash", () => {
        got.addPeer(`127.0.0.1:${seeder.torrentPort}`);
      });

      await timeout(
        new Promise<void>((resolve, reject) => {
          got.once("done", () => resolve());
          got.once("error", (err) =>
            reject(err instanceof Error ? err : new Error(String(err))),
          );
        }),
        120_000,
        "download",
      );

      const onDisk = walk(dest).sort();
      console.log(`  on disk under ${scenario.dest.join("/")}:`);
      for (const f of onDisk) console.log(`    ${f}`);

      try {
        assert.deepEqual(
          onDisk,
          [...scenario.expect].sort(),
          "files must land directly under the smart path",
        );
        for (const [rel, hash] of expectedHashes) {
          assert.equal(sha(path.join(dest, rel)), hash, `${rel} content`);
        }
        assert.ok(
          !fs.existsSync(path.join(dest, scenario.root)),
          "the release root folder must not exist",
        );
        console.log("  ✓ flat, and every byte matches the source");
      } catch (err) {
        failures += 1;
        console.error(`  ✗ ${(err as Error).message}`);
      }
    }

    // --- Two releases, one destination, identically sized colliding files ---
    //
    // This is the case where "same size means it is mine" corrupts data: both
    // episodes ship `Screens/s1.png`, same length, different bytes. The first
    // torrent flattens and claims the path; the second must notice the claim
    // and keep its own release folder instead of verifying over it.
    console.log("\nTwo releases colliding in one season folder");
    const dest = path.join(downloadRoot, "TV", "Show", "Season 03");
    const collided: { root: string; file: string; screen: Buffer }[] = [
      {
        root: "Show.S03E01.1080p.WEB",
        file: "episode01.mkv",
        screen: fill("e01-screen", 256 * 1024),
      },
      {
        root: "Show.S03E02.1080p.WEB",
        file: "episode02.mkv",
        screen: fill("e02-screen", 256 * 1024),
      },
    ];

    for (const rel of collided) {
      const source = path.join(seedRoot, rel.root);
      fs.mkdirSync(path.join(source, "Screens"), { recursive: true });
      fs.writeFileSync(path.join(source, rel.file), fill(rel.file, 512 * 1024));
      fs.writeFileSync(path.join(source, "Screens", "s1.png"), rel.screen);

      const seeded = await timeout(
        new Promise<Torrent>((resolve) => {
          seeder.seed(source, { announce: [] }, resolve);
        }),
        60_000,
        "seed",
      );
      const got = leecher.add(seeded.torrentFile, { path: dest });
      got.once("infoHash", () => {
        got.addPeer(`127.0.0.1:${seeder.torrentPort}`);
      });
      await timeout(
        new Promise<void>((resolve, reject) => {
          got.once("done", () => resolve());
          got.once("error", (err) =>
            reject(err instanceof Error ? err : new Error(String(err))),
          );
        }),
        120_000,
        "download",
      );
    }

    const onDisk = walk(dest).sort();
    console.log(`  on disk under TV/Show/Season 03:`);
    for (const f of onDisk) console.log(`    ${f}`);

    try {
      assert.deepEqual(
        onDisk,
        [
          "Show.S03E02.1080p.WEB/Screens/s1.png",
          "Show.S03E02.1080p.WEB/episode02.mkv",
          "Screens/s1.png",
          "episode01.mkv",
        ].sort(),
        "the first release flattens, the second keeps its folder",
      );
      assert.equal(
        sha(path.join(dest, "Screens", "s1.png")),
        createHash("sha256").update(collided[0].screen).digest("hex"),
        "episode one's screenshot must not be overwritten",
      );
      assert.equal(
        sha(path.join(dest, collided[1].root, "Screens", "s1.png")),
        createHash("sha256").update(collided[1].screen).digest("hex"),
        "episode two's screenshot must be its own bytes",
      );
      console.log("  ✓ neither release overwrote the other");
    } catch (err) {
      failures += 1;
      console.error(`  ✗ ${(err as Error).message}`);
    }
  } finally {
    await new Promise<void>((r) => seeder.destroy(() => r()));
    await new Promise<void>((r) => leecher.destroy(() => r()));
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`\n${failures} scenario(s) failed.`);
    process.exit(1);
  }
  console.log("\ne2e-content-layout: real torrents landed where they should.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
