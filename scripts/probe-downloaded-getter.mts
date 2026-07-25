/**
 * Diagnostic: does our replaced `downloaded` getter agree with the bitfield?
 *
 * Adds a magnet into a scratch directory with the real patch applied, then
 * every few seconds prints our reported number next to an independently
 * recomputed one, plus the raw internals it is derived from. Any disagreement
 * localises the bug to our getter; agreement localises it to verification.
 *
 * Usage: npx tsx scripts/probe-downloaded-getter.mts "<magnet>" [seconds]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebTorrent from "webtorrent";
import { patchWebTorrentPieceRace, repairedPieceCount } from "../src/lib/clients/webtorrent-piece-race.js";
import { builtinClientOptions, builtinAddOptions } from "../src/lib/clients/builtin-engine.js";

const magnet = process.argv[2];
const seconds = Number(process.argv[3] || 45);
const vanilla = process.argv.includes("--vanilla");
if (!magnet) throw new Error("magnet required");

const TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce",
];
const uri = magnet + TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join("");

type Piece = { length: number; missing: number } | null;
type T = {
  name?: string;
  length?: number;
  pieceLength?: number;
  lastPieceLength?: number;
  pieces?: Piece[];
  bitfield?: { get(i: number): boolean };
  downloaded?: number;
  progress?: number;
  numPeers?: number;
  downloadSpeed?: number;
  done?: boolean;
  ready?: boolean;
  on(ev: string, fn: () => void): void;
};

if (!vanilla) await patchWebTorrentPieceRace();
console.log(vanilla ? "MODE: vanilla webtorrent (no patch)" : "MODE: patched");
process.on("uncaughtException", (e) => {
  console.log(`uncaughtException: ${e instanceof Error ? e.message : e}`);
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-getter-"));
const client = new WebTorrent(builtinClientOptions) as unknown as {
  add(uri: string, opts: object): T;
  destroy(): void;
};
const t = client.add(uri, { ...builtinAddOptions, path: dir });

t.on("ready", () => console.log(`ready · pieces=${t.pieces?.length} pieceLength=${t.pieceLength}`));

const started = Date.now();
const timer = setInterval(() => {
  const pieces = t.pieces;
  const bf = t.bitfield;
  if (!pieces || !bf) {
    console.log("… no metadata yet");
    return;
  }
  const len = pieces.length;
  let bits = 0;
  let nulls = 0;
  let partial = 0;
  let nonPieceEntries = 0;
  for (let i = 0; i < len; i++) {
    if (bf.get(i)) bits++;
    const p = pieces[i];
    if (p === null) nulls++;
    else if (typeof p.missing !== "number" || typeof p.length !== "number") nonPieceEntries++;
    else partial += p.length - p.missing;
  }
  const truthBytes =
    bits * (t.pieceLength ?? 0) -
    (bf.get(len - 1) ? (t.pieceLength ?? 0) - (t.lastPieceLength ?? 0) : 0);
  const total = t.length ?? 1;
  const onDisk = dirBytes(dir);
  let ours = "throw";
  try {
    ours = (((t.downloaded ?? 0) / total) * 100).toFixed(2) + "%";
  } catch {
    /* vanilla webtorrent throws here — that is the bug we patched */
  }
  console.log(
    [
      `t=${((Date.now() - started) / 1000).toFixed(0)}s`,
      `ours=${ours}`,
      `bitfieldTruth=${((truthBytes + partial) / total * 100).toFixed(2)}%`,
      `bitsSet=${bits}/${len}`,
      `nulls=${nulls}`,
      `nonPiece=${nonPieceEntries}`,
      `partialMB=${(partial / 1048576).toFixed(1)}`,
      `onDiskMB=${(onDisk / 1048576).toFixed(1)}`,
      `peers=${t.numPeers}`,
      `kbps=${((t.downloadSpeed ?? 0) / 1024).toFixed(0)}`,
      `repaired=${repairedPieceCount()}`,
    ].join(" "),
  );
}, 5000);

function dirBytes(d: string): number {
  let n = 0;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) n += dirBytes(p);
    else n += fs.statSync(p).size;
  }
  return n;
}

setTimeout(() => {
  clearInterval(timer);
  const pieces = t.pieces;
  const bf = t.bitfield;
  if (pieces && bf) {
    const orphans: number[] = [];
    for (let i = 0; i < pieces.length; i++) {
      if (pieces[i] === null && !bf.get(i)) orphans.push(i);
    }
    console.log(`\norphans (piece null, bit unset): ${orphans.length}`);
    if (orphans.length) {
      const i = orphans[0];
      const writable = bf as unknown as { set(n: number, v: boolean): void };
      console.log(`  sample index ${i} of ${pieces.length}`);
      console.log(`  bit before set: ${bf.get(i)}`);
      writable.set(i, true);
      console.log(`  bit after set(true): ${bf.get(i)}  <-- false means the bitfield silently refused`);
      const buf = (bf as unknown as { buffer?: { length: number } }).buffer;
      console.log(`  bitfield buffer bytes: ${buf?.length} (need ${Math.ceil(pieces.length / 8)})`);
    }
  }
  client.destroy();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}, seconds * 1000);
