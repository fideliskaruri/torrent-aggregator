/**
 * A complete BitTorrent swarm on loopback, with no public network involved.
 *
 * The playback pipeline had never once read a byte through WebTorrent — every
 * harness so far served fixtures over plain HTTP, which skips the whole reason
 * `api/stream/[infoHash]/[...filePath]/route.ts` is as careful as it is
 * (parked `FileIterator` wake-ups, `end: 0` widening to the whole file, the
 * stall guard on *every* read). Depending on the real swarm to test that would
 * be both slow and flaky, so instead we run the tracker and the seeder in this
 * process and let the app's own engine be the leecher.
 *
 * The magnet deliberately carries a `tr=` for the local tracker: the engine's
 * `withPublicTrackers` only injects public trackers into a *bare* magnet, so a
 * tracker URL here is what guarantees the test never announces to the internet.
 *
 * Neither `bittorrent-tracker` nor `webtorrent` ships types. `webtorrent` is
 * declared app-wide in `src/types/webtorrent.d.ts`; the tracker is declared in
 * `bittorrent-tracker.d.ts` beside this file. Both reach the program through
 * the tsconfig include glob — a triple-slash reference would bind them to this
 * file directly, but eslint's `triple-slash-reference` rule forbids it, so this
 * file only typechecks as part of the project (which is the repo's gate).
 */
import { mkdirSync } from "node:fs";
import { Server as TrackerServer } from "bittorrent-tracker";
import WebTorrent from "webtorrent";

export type SeededTorrent = {
  infoHash: string;
  magnetURI: string;
  /** Path inside the torrent, as the stream route addresses it. */
  filePath: string;
  length: number;
};

export type LocalSwarm = {
  trackerUrl: string;
  seed: (filePath: string) => Promise<SeededTorrent>;
  close: () => Promise<void>;
};

export async function startLocalSwarm(): Promise<LocalSwarm> {
  const tracker = new TrackerServer({ udp: false, ws: false, stats: false, http: true });
  // A tracker that throws on a stray announce would take the harness with it.
  tracker.on("error", () => undefined);
  tracker.on("warning", () => undefined);

  const trackerUrl = await new Promise<string>((resolve, reject) => {
    tracker.listen(0, "127.0.0.1", () => {
      const addr = tracker.http?.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("local tracker did not report a port"));
        return;
      }
      resolve(`http://127.0.0.1:${addr.port}/announce`);
    });
  });

  const seeder = new WebTorrent({ dht: false, utp: false });

  return {
    trackerUrl,
    seed(filePath: string) {
      return new Promise<SeededTorrent>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out seeding fixture")), 60_000);
        // The seed callback fires once the torrent is ready, but `files` is still
        // populated asynchronously by WebTorrent, so it can legitimately be
        // absent here. A missing file must fail loudly — a silently `undefined`
        // path would make a torrent that never seeded look like a passing test.
        seeder.seed(filePath, { announce: [trackerUrl] }, (torrent) => {
          clearTimeout(timer);
          const file = torrent.files?.[0];
          const name = file?.path ?? file?.name;
          const magnetURI = torrent.magnetURI;
          if (!file || !name || !magnetURI) {
            reject(
              new Error(
                `seeding ${filePath} produced no usable torrent: ` +
                  `files=${torrent.files?.length ?? "undefined"}, ` +
                  `name=${name ?? "undefined"}, magnet=${magnetURI ? "ok" : "missing"}`,
              ),
            );
            return;
          }
          resolve({
            infoHash: torrent.infoHash,
            magnetURI,
            filePath: name.replace(/\\/g, "/"),
            length: file.length,
          });
        });
      });
    },
    async close() {
      await new Promise<void>((resolve) => {
        try {
          seeder.destroy(() => resolve());
        } catch {
          resolve();
        }
      });
      await new Promise<void>((resolve) => {
        try {
          tracker.close(() => resolve());
        } catch {
          resolve();
        }
        setTimeout(resolve, 2_000).unref();
      });
    },
  };
}

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}
