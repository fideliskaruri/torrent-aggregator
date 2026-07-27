// Diagnostic: run the same magnet the app is running, in a clean process, and
// report peers/speed under different client options. Answers "is the engine
// slow, or is the swarm dead?"
import WebTorrent from "webtorrent";
import { builtinAddOptions, PUBLIC_TRACKERS } from "../src/lib/clients/builtin-engine.js";
import { patchWebTorrentPieceRace, swallowedPieceRaces } from "../src/lib/clients/webtorrent-piece-race.js";
import { patchWebTorrentConnErrors } from "../src/lib/clients/webtorrent-conn-errors.js";

await patchWebTorrentPieceRace();
await patchWebTorrentConnErrors();

const hash = process.argv[2];
const label = process.argv[3] ?? "default";
const optsArg = process.argv[4] ? JSON.parse(process.argv[4]) : {};
const SECONDS = Number(process.argv[5] ?? 60);
const DEST = process.argv[6] ?? process.env.TEMP + "\\tf-probe-" + label;

const magnet =
  `magnet:?xt=urn:btih:${hash}` +
  PUBLIC_TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join("");

const client = new WebTorrent(optsArg) as unknown as {
  add: (u: string, o: object) => Record<string, unknown>;
  destroy: (cb: () => void) => void;
};

console.log(`[${label}] opts=${JSON.stringify(optsArg)}`);

const t = client.add(magnet, { ...builtinAddOptions, path: DEST });

(t as { on: (e: string, f: () => void) => void }).on("ready", () => {
  const g = t as unknown as { progress: number; length: number };
  console.log(
    `[${label}] READY after ${Date.now() - started}ms — verification recovered ` +
      `${((g.progress || 0) * 100).toFixed(2)}% of ${((g.length || 0) / 1e9).toFixed(2)}GB`,
  );
});

let gotMetadata = 0;
const started = Date.now();
(t as { on: (e: string, f: () => void) => void }).on("metadata", () => {
  gotMetadata = Date.now() - started;
  console.log(`[${label}] metadata after ${gotMetadata}ms`);
});

let peak = 0;
const timer = setInterval(() => {
  const g = t as unknown as {
    numPeers: number;
    downloadSpeed: number;
    progress: number;
    pieces?: Array<unknown>;
    bitfield?: { get: (i: number) => boolean };
    pieceLength?: number;
    length?: number;
    _peersLength?: number;
    wires?: unknown[];
  };
  const speed = g.downloadSpeed || 0;
  if (speed > peak) peak = speed;
  const secs = Math.round((Date.now() - started) / 1000);

  // Ground truth, computed from the bitfield only — never touches a nulled
  // piece, so it cannot throw and cannot be frozen by the getter guard.
  let verified = 0;
  const n = g.pieces?.length ?? 0;
  if (g.bitfield) for (let i = 0; i < n; i++) if (g.bitfield.get(i)) verified++;
  const truth = n ? ((verified / n) * 100).toFixed(2) : "?";

  console.log(
    `[${label}] t=${secs}s peers=${g.numPeers} wires=${g.wires?.length ?? "?"} ` +
      `speed=${(speed / 1024).toFixed(1)}KB/s reported=${((g.progress || 0) * 100).toFixed(2)}% ` +
      `truth=${truth}% swallowed=${swallowedPieceRaces()}`,
  );
}, 5000);

setTimeout(() => {
  clearInterval(timer);
  console.log(
    `[${label}] RESULT metadata=${gotMetadata || "never"}ms peak=${(peak / 1024).toFixed(1)}KB/s`,
  );
  client.destroy(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}, SECONDS * 1000);
