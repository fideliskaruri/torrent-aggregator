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
      path: file.path,
      length: file.length,
      index,
    })),
    clientType: "builtin",
    swarm: swarmState(lookup.torrent),
  });
}

type RouteContext = {
  params: RouteParams | Promise<RouteParams>;
};

export async function GET(request: Request, context: RouteContext) {
  const quiet = new URL(request.url).searchParams.get("poll") === "1";
  return handleStreamIndexRequest(await context.params, { quiet });
}
