import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getUserClientConfig, type ClientConnectionConfig } from "@/lib/clients";
import {
  findBuiltinTorrentFile,
  type BuiltinStreamTorrent,
} from "@/lib/clients/builtin-engine";
import { normalizeInfoHash } from "@/lib/torrents/infohash";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteParams = {
  infoHash: string;
};

type IndexDeps = {
  getConfig?: () => Promise<ClientConnectionConfig | null>;
  findFile?: typeof findBuiltinTorrentFile;
  /**
   * The player polls this route for the swarm-health chip. A poll is not worth
   * a log line each time — the diagnostics exist for the one-off resolve.
   */
  quiet?: boolean;
};

function torrentPeers(torrent?: BuiltinStreamTorrent): number | null {
  const peers = torrent?.numPeers;
  return typeof peers === "number" && Number.isFinite(peers) ? peers : null;
}

function torrentDownloadedPct(torrent?: BuiltinStreamTorrent): number | null {
  const progress = torrent?.progress;
  if (typeof progress !== "number" || !Number.isFinite(progress)) return null;
  return Math.round(progress * 10_000) / 100;
}

/**
 * Live swarm state for the player's health chip.
 *
 * Every field is `null` when the engine did not give us a real number, and the
 * UI renders that as "unknown" rather than 0. WebTorrent exposes `numPeers` —
 * *connected peers*, seeds and leeches together — and no seeder count at all,
 * so this deliberately says "peers" everywhere. Reporting a seeder count we do
 * not have would be exactly the class of claim this codebase keeps having to
 * unlearn.
 */
export type StreamSwarmState = {
  /** Connected peers. Not seeders — the engine cannot tell them apart. */
  peers: number | null;
  /** Bytes per second, as the engine measures it. */
  downloadSpeedBps: number | null;
  /** 0..1 of the whole torrent. */
  progress: number | null;
  /** When this sample was taken, so a stale chip can be spotted. */
  observedAt: number;
};

type ByteRange = {
  /** Inclusive byte offset within the file. */
  start: number;
  /** Exclusive byte offset within the file. */
  end: number;
};

type TorrentBitfield = { get?: (index: number) => boolean };
type TorrentPieceState = {
  bitfield?: TorrentBitfield;
  pieceLength?: number;
  lastPieceLength?: number;
  length?: number;
  done?: boolean;
  progress?: number;
  pieces?: Array<unknown>;
};
type FilePieceState = {
  offset?: number;
  length: number;
  _startPiece?: number;
  _endPiece?: number;
  downloaded?: number;
};

function swarmState(torrent?: BuiltinStreamTorrent): StreamSwarmState {
  const speed = torrent?.downloadSpeed;
  const progress = torrent?.progress;
  return {
    peers: torrentPeers(torrent),
    downloadSpeedBps:
      typeof speed === "number" && Number.isFinite(speed) && speed >= 0 ? speed : null,
    progress:
      typeof progress === "number" && Number.isFinite(progress)
        ? Math.max(0, Math.min(1, progress))
        : null,
    observedAt: Date.now(),
  };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function mergeByteRange(ranges: ByteRange[], range: ByteRange): void {
  if (range.end <= range.start) return;
  const last = ranges[ranges.length - 1];
  if (last && range.start <= last.end) {
    last.end = Math.max(last.end, range.end);
    return;
  }
  ranges.push(range);
}

/**
 * Verified torrent pieces held on disk, intersected with one file.
 *
 * WebTorrent already keeps the authoritative answer in `torrent.bitfield`; the
 * manifest route is the one JSON shape the browser already polls, so surfacing
 * it here avoids a second endpoint whose whole job would be to ask the same
 * engine the same question. Only verified pieces are painted: a partially-filled
 * piece is not something `file.stream()` can seek into without waiting.
 */
export function downloadedFileRanges(
  torrent: BuiltinStreamTorrent | undefined,
  file: { length: number; offset?: number; _startPiece?: number; _endPiece?: number },
): ByteRange[] {
  if (!file.length || file.length <= 0) return [];
  const t = torrent as TorrentPieceState | undefined;
  if (!t) return [];
  if (t.done === true || (typeof t.progress === "number" && t.progress >= 1)) {
    return [{ start: 0, end: file.length }];
  }

  const bitfield = t.bitfield;
  if (typeof bitfield?.get !== "function") return [];
  const pieceLength = finiteNumber(t.pieceLength);
  if (!pieceLength || pieceLength <= 0) return [];

  const f = file as FilePieceState;
  const fileOffset = finiteNumber(f.offset) ?? 0;
  const fileEnd = fileOffset + file.length;
  const startPiece =
    finiteNumber(f._startPiece) ?? Math.max(0, Math.floor(fileOffset / pieceLength));
  const endPiece =
    finiteNumber(f._endPiece) ?? Math.max(startPiece, Math.floor((fileEnd - 1) / pieceLength));
  const torrentLength = finiteNumber(t.length);
  const piecesLength = Array.isArray(t.pieces) ? t.pieces.length : null;
  const ranges: ByteRange[] = [];

  for (let index = startPiece; index <= endPiece; index += 1) {
    if (!bitfield.get(index)) continue;
    const pieceStart = index * pieceLength;
    const isLastPiece = piecesLength !== null && index === piecesLength - 1;
    const pieceEnd =
      isLastPiece && finiteNumber(t.lastPieceLength)
        ? pieceStart + (finiteNumber(t.lastPieceLength) ?? pieceLength)
        : torrentLength
          ? Math.min(torrentLength, pieceStart + pieceLength)
          : pieceStart + pieceLength;
    const start = Math.max(0, Math.min(file.length, Math.max(pieceStart, fileOffset) - fileOffset));
    const end = Math.max(0, Math.min(file.length, Math.min(pieceEnd, fileEnd) - fileOffset));
    mergeByteRange(ranges, { start, end });
  }

  return ranges;
}

function logStreamIndexLine(entry: {
  infoHash: string;
  torrent?: BuiltinStreamTorrent;
  outcome: string;
}) {
  console.info(
    "[stream]",
    JSON.stringify({
      infoHash: entry.infoHash,
      file: null,
      range: null,
      peers: torrentPeers(entry.torrent),
      downloadedPct: torrentDownloadedPct(entry.torrent),
      outcome: entry.outcome,
    }),
  );
}

export async function handleStreamIndexRequest(
  params: RouteParams,
  deps: IndexDeps = {},
): Promise<Response> {
  const infoHash = normalizeInfoHash(params.infoHash);
  const logStreamIndex = deps.quiet
    ? () => {
        /* the player's swarm poll would otherwise write a line every few seconds */
      }
    : logStreamIndexLine;
  if (!infoHash) {
    logStreamIndex({ infoHash: params.infoHash, outcome: "not_found" });
    return NextResponse.json({ error: "Torrent not found" }, { status: 404 });
  }

  const getConfig =
    deps.getConfig ??
    (async () => {
      const session = await auth();
      if (!session?.user?.id) return null;
      return getUserClientConfig(session.user.id);
    });
  const config = await getConfig();
  if (!config) {
    logStreamIndex({ infoHash, outcome: "not_configured" });
    return NextResponse.json(
      { error: "No torrent client configured" },
      { status: 503 },
    );
  }
  if (config.clientType !== "builtin") {
    logStreamIndex({ infoHash, outcome: "non_builtin" });
    return NextResponse.json(
      {
        error: "Streaming requires the built-in client",
        message:
          "Only the built-in WebTorrent engine has live in-process file streams. Switch Settings → Built-in to play in the app.",
        clientType: config.clientType,
      },
      { status: 409 },
    );
  }

  const lookup = await (deps.findFile ?? findBuiltinTorrentFile)(config, infoHash);
  if (lookup.status === "not_found") {
    logStreamIndex({ infoHash, outcome: "not_found" });
    return NextResponse.json({ error: "Torrent not found" }, { status: 404 });
  }
  if (lookup.status === "metadata_pending") {
    logStreamIndex({
      infoHash,
      torrent: lookup.torrent,
      outcome: "metadata_pending",
    });
    return NextResponse.json(
      {
        error: "Torrent metadata is not ready yet",
        message: "The torrent is still fetching metadata; try again in a moment.",
        // The swarm is real even before the file index is: a viewer waiting on
        // metadata is exactly who needs to know whether any peer answered.
        swarm: swarmState(lookup.torrent),
      },
      { status: 425 },
    );
  }

  logStreamIndex({ infoHash, torrent: lookup.torrent, outcome: "ok" });
  return NextResponse.json({
    files: (lookup.torrent.files ?? []).map((file, index) => ({
      path: manifestPath(file.path),
      length: file.length,
      index,
      downloadedRanges: downloadedFileRanges(lookup.torrent, file),
    })),
    clientType: "builtin",
    swarm: swarmState(lookup.torrent),
  });
}

/**
 * A torrent path, in the one separator every consumer of this manifest expects.
 *
 * BEP-3 defines a file's path as a *list* of components; the separator is a
 * presentation choice made when they are joined. WebTorrent joins them with the
 * host platform's separator, so on Windows this manifest was emitting
 *
 *     www.UIndex.org - Rick and Morty S01E02 …-Kitsune\Rick and Morty S01E02 ….mkv
 *
 * with a backslash in the middle. The stream route addresses files by URL path
 * segments, so any consumer that does the obvious and correct thing —
 * `path.split("/")` — gets a single segment containing a literal backslash,
 * builds `…%5CRick%20and%20Morty…`, and receives a 404. I hit exactly that
 * writing `scripts/media-stream-bitrate.mts`, on a file that plays perfectly in
 * the app.
 *
 * The player survives it only because `encodeStreamFilePath` happens to strip
 * backslashes on the way in. That is a defence in the wrong place: it makes
 * every future consumer responsible for remembering a Windows detail that the
 * torrent format does not have. It also stopped being a rare case the moment
 * this app started preferring season packs, because a pack is by definition a
 * multi-file torrent and every one of its paths carries a separator.
 *
 * So normalise at the source and let the player keep its defence.
 */
function manifestPath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

type RouteContext = {
  params: RouteParams | Promise<RouteParams>;
};
export async function GET(request: Request, context: RouteContext) {
  const quiet = new URL(request.url).searchParams.get("poll") === "1";
  return handleStreamIndexRequest(await context.params, { quiet });
}
