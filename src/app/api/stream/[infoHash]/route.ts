import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getUserClientConfig, type ClientConnectionConfig } from "@/lib/clients";
import {
  findBuiltinTorrentFile,
  type BuiltinStreamTorrent,
} from "@/lib/clients/builtin-engine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteParams = {
  infoHash: string;
};

type IndexDeps = {
  getConfig?: () => Promise<ClientConnectionConfig | null>;
  findFile?: typeof findBuiltinTorrentFile;
};

function normalizeInfoHash(raw: string): string | null {
  const value = raw.trim();
  if (/^[a-f0-9]{40}$/i.test(value)) return value.toLowerCase();
  if (!/^[a-z2-7]{32}$/i.test(value)) return null;

  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of value.toUpperCase()) {
    const n = alphabet.indexOf(ch);
    if (n < 0) return null;
    bits += n.toString(2).padStart(5, "0");
  }
  let hex = "";
  for (let i = 0; i + 4 <= bits.length && hex.length < 40; i += 4) {
    hex += Number.parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex.length === 40 ? hex : null;
}

function torrentPeers(torrent?: BuiltinStreamTorrent): number | null {
  const peers = torrent?.numPeers;
  return typeof peers === "number" && Number.isFinite(peers) ? peers : null;
}

function torrentDownloadedPct(torrent?: BuiltinStreamTorrent): number | null {
  const progress = torrent?.progress;
  if (typeof progress !== "number" || !Number.isFinite(progress)) return null;
  return Math.round(progress * 10_000) / 100;
}

function logStreamIndex(entry: {
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
  });
}

type RouteContext = {
  params: RouteParams | Promise<RouteParams>;
};

export async function GET(_request: Request, context: RouteContext) {
  return handleStreamIndexRequest(await context.params);
}
