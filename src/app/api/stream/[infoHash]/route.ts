import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getUserClientConfig, type ClientConnectionConfig } from "@/lib/clients";
import {
  findLiveBuiltinTorrentFile,
  type BuiltinStreamTorrent,
} from "@/lib/clients/builtin-engine";
import { normalizeInfoHash } from "@/lib/torrents/infohash";
import {
  isSupportedMediaAssetFileName,
  isSupportedVideoFileName,
  selectMainFeatureFile,
} from "@/lib/torrents/filters";
import { parseEpisode } from "@/lib/torrents/episodes";
import {
  getCompletedMediaManifest,
  type CompletedMediaManifest,
} from "@/lib/library/completed-media";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteParams = {
  infoHash: string;
};

type IndexDeps = {
  getConfig?: () => Promise<ClientConnectionConfig | null>;
  findFile?: typeof findLiveBuiltinTorrentFile;
  /**
   * The player polls this route for the swarm-health chip. A poll is not worth
   * a log line each time — the diagnostics exist for the one-off resolve.
   */
  quiet?: boolean;
  /**
   * When present, only this manifest path carries downloadedRanges. The player
   * polls this route while one file is on screen; repeating range arrays for a
   * 24-episode pack on every tick would spend bytes on files the viewer is not
   * looking at.
   */
  downloadedRangesFor?: string | null;
  targetEpisode?: { season: number; episode: number } | null;
  getCompletedManifest?: (
    infoHash: string,
  ) => Promise<CompletedMediaManifest | null>;
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

export const MAX_DOWNLOADED_RANGES_PER_FILE = 64;

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

function capDownloadedRanges(ranges: ByteRange[]): ByteRange[] {
  if (ranges.length <= MAX_DOWNLOADED_RANGES_PER_FILE) return ranges;
  const capped = ranges.map((range) => ({ ...range }));
  /**
   * This manifest is polled and multiplied by file count in season packs. A
   * scrubber a few hundred pixels wide cannot resolve hundreds of one-piece
   * islands, so coalesce the smallest gaps until the payload is bounded. That
   * over-reports by less than a pixel for the gaps we erase, while preserving
   * the first and last held boundaries and keeping sparse shape visible.
   */
  while (capped.length > MAX_DOWNLOADED_RANGES_PER_FILE) {
    let mergeAt = 1;
    let smallestGap = Number.POSITIVE_INFINITY;
    for (let i = 1; i < capped.length; i += 1) {
      const gap = capped[i].start - capped[i - 1].end;
      if (gap < smallestGap) {
        smallestGap = gap;
        mergeAt = i;
      }
    }
    capped[mergeAt - 1] = {
      start: capped[mergeAt - 1].start,
      end: capped[mergeAt].end,
    };
    capped.splice(mergeAt, 1);
  }
  return capped;
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
  const bitfield = t.bitfield;
  if (typeof bitfield?.get !== "function") return [];
  const pieceCount = Array.isArray(t.pieces) ? t.pieces.length : 0;
  if (
    pieceCount > 0 &&
    Array.from({ length: pieceCount }, (_, index) => index).every((index) =>
      bitfield.get?.(index),
    )
  ) {
    return [{ start: 0, end: file.length }];
  }
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

  return capDownloadedRanges(ranges);
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
  const completedManifest = await (
    deps.getCompletedManifest ??
    ((hash) =>
      config.userId
        ? getCompletedMediaManifest(config.userId, hash)
        : Promise.resolve(null))
  )(infoHash);
  if (completedManifest) {
    const targetEpisode = deps.targetEpisode;
    const targetFileIndex =
      targetEpisode == null
        ? -1
        : completedManifest.files.findIndex((file) => {
            if (!isSupportedVideoFileName(file.relativePath)) return false;
            const parsed = parseEpisode(file.relativePath);
            return (
              parsed.season === targetEpisode.season &&
              parsed.episode === targetEpisode.episode
            );
          });
    const targetVideoIndex = targetFileIndex >= 0 ? targetFileIndex : null;
    const primaryVideoIndex =
      targetVideoIndex ??
      selectMainFeatureFile(
        completedManifest.files.map((file) => ({
          path: file.relativePath,
          length: file.length,
        })),
      )?.index ??
      null;
    return NextResponse.json({
      files: completedManifest.files.map((file, index) => ({
        path: file.relativePath,
        length: file.length,
        index,
        ...(deps.downloadedRangesFor == null ||
        manifestPath(deps.downloadedRangesFor) === file.relativePath
          ? { downloadedRanges: [{ start: 0, end: file.length }] }
          : {}),
      })),
      primaryVideoIndex,
      targetVideoIndex,
      clientType: "builtin",
      swarm: {
        peers: 0,
        downloadSpeedBps: 0,
        progress: 1,
        observedAt: Date.now(),
      },
    });
  }

  if (config.clientType !== "builtin") {
    logStreamIndex({ infoHash, outcome: "non_builtin" });
    return NextResponse.json(
      {
        error: "Streaming requires the built-in client",
        message:
          "This title is not available as completed local media. Switch Settings → Built-in to stream an active torrent.",
        clientType: config.clientType,
      },
      { status: 409 },
    );
  }

  const lookup = await (deps.findFile ?? findLiveBuiltinTorrentFile)(config, infoHash);
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
  const downloadedRangesFor = deps.downloadedRangesFor
    ? manifestPath(deps.downloadedRangesFor)
    : null;
  const torrentFiles = (lookup.torrent.files ?? []).filter((file) =>
    isSupportedMediaAssetFileName(file.path),
  );
  // I14b: tell the player which file is the main feature so "Play" on a movie
  // lands on the feature, not a bonus/extra/sample bundled in the same torrent.
  // Additive: the player MAY read `primaryVideoIndex` to pick a default file; a
  // client that ignores it behaves exactly as before.
  const targetEpisode = deps.targetEpisode;
  const targetFileIndex =
    targetEpisode == null
      ? -1
      : torrentFiles.findIndex((file) => {
          if (!isSupportedVideoFileName(file.path)) return false;
          const parsed = parseEpisode(file.path);
          return (
            parsed.season === targetEpisode.season &&
            parsed.episode === targetEpisode.episode
          );
        });
  const targetVideoIndex = targetFileIndex >= 0 ? targetFileIndex : null;
  const primaryVideoIndex =
    targetVideoIndex ?? selectMainFeatureFile(torrentFiles)?.index ?? null;
  return NextResponse.json({
    files: torrentFiles.map((file, index) => {
      const path = manifestPath(file.path);
      return {
        path,
        length: file.length,
        index,
        ...(downloadedRangesFor === null || downloadedRangesFor === path
          ? { downloadedRanges: downloadedFileRanges(lookup.torrent, file) }
          : {}),
      };
    }),
    primaryVideoIndex,
    targetVideoIndex,
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
  const searchParams = new URL(request.url).searchParams;
  const quiet = searchParams.get("poll") === "1";
  const season = Number(searchParams.get("season"));
  const episode = Number(searchParams.get("episode"));
  return handleStreamIndexRequest(await context.params, {
    quiet,
    downloadedRangesFor: searchParams.get("file"),
    targetEpisode:
      Number.isInteger(season) &&
      season > 0 &&
      Number.isInteger(episode) &&
      episode > 0
        ? { season, episode }
        : null,
  });
}
