import { NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import {
  getUserClientConfig,
  getClient,
  listClientTorrents,
} from "@/lib/clients";
import { formatClientError } from "@/lib/clients/errors";
import { pruneEmptyParents } from "@/lib/clients/prune-empty-parents";
import { resetDirectorySizeCache } from "@/lib/library/disk-space";
import prisma from "@/lib/prisma";
import {
  isDownloadRetention,
  retentionStateForOrigin,
} from "@/lib/streaming/retention";
import {
  jsonResponse,
  observeRequest,
} from "@/lib/observability/logging";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const observer = observeRequest(request, "torrent-client", "list-torrents");
  const reply = (body: unknown, init?: ResponseInit) =>
    jsonResponse(observer, body, init);
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return reply({ error: "Unauthorized" }, { status: 401 });
    }

    const config = await getUserClientConfig(session.user.id);
    if (!config) {
      observer.degraded("TORRENT_LIST_FAILED", { status: "not-configured" });
      return reply(
        {
          error: "No torrent client configured",
          message:
            "Could not provision download settings. Try Settings → save Built-in, or restart the app.",
          offline: false,
          clientType: "builtin",
          torrents: [],
        },
        { status: 400 },
      );
    }

    const publicHost =
      config.clientType === "builtin" ? "" : config.host || "";
    const hasExternal =
      config.externalClientType === "qbittorrent" ||
      config.externalClientType === "transmission";

    try {
      const torrents = await listClientTorrents(config);
      const hashes = [
        ...new Set(
          torrents
            .map((t) => t.hash?.toLowerCase())
            .filter((h): h is string => Boolean(h)),
        ),
      ];
      if (hashes.length > 0) {
        const torrentByHash = new Map(
          torrents
            .filter((torrent) => Boolean(torrent.hash))
            .map((torrent) => [torrent.hash!.toLowerCase(), torrent] as const),
        );
        const targets = await prisma.acquisitionTarget.findMany({
          where: {
            userId: session.user.id,
            infoHash: { in: hashes },
            status: { in: ["queued", "downloading"] },
          },
          select: { id: true, infoHash: true, progress: true, status: true },
        });
        await Promise.all(
          targets.map((target) => {
            const torrent = target.infoHash
              ? torrentByHash.get(target.infoHash.toLowerCase())
              : null;
            if (!torrent) return Promise.resolve();
            const progress = Math.min(
              1,
              Math.max(0, Number(torrent.progress) || 0),
            );
            const downloaded =
              progress >= 1 ||
              String(torrent.state ?? "").toLowerCase().includes("seeding");
            if (
              target.progress === (downloaded ? 1 : progress) &&
              target.status === (downloaded ? "downloaded" : "downloading")
            ) {
              return Promise.resolve();
            }
            return prisma.acquisitionTarget.update({
              where: { id: target.id },
              data: {
                status: downloaded ? "downloaded" : "downloading",
                progress: downloaded ? 1 : progress,
              },
            });
          }),
        );
      }
      const origins = hashes.length
        ? new Map(
            (
              await prisma.engineTorrent.findMany({
                where: { userId: session.user.id, hash: { in: hashes } },
                select: { hash: true, origin: true },
              })
            ).map((row) => [row.hash.toLowerCase(), row.origin] as const),
          )
        : new Map<string, string>();
      const annotated = torrents.map((torrent) => {
        const retentionState = retentionStateForOrigin(
          torrent.hash ? origins.get(torrent.hash.toLowerCase()) : null,
        );
        // Fix once at the shared source: a stream/prewarm torrent is not a
        // download, so it must expose no download progress or transfer rate to
        // any consumer of this poll (teaser, /client, browse cards, title
        // hero). Zeroing the download-facing numbers here means every surface
        // agrees without each re-deciding — and a future consumer cannot
        // reintroduce a "% downloaded" for a stream by reading a raw field.
        if (!isDownloadRetention(retentionState)) {
          return {
            ...torrent,
            progress: 0,
            dlspeed: 0,
            upspeed: 0,
            eta: 0,
            peers: 0,
            retentionState,
          };
        }
        return { ...torrent, retentionState };
      });
      observer.success("TORRENT_LIST_SUCCEEDED", {
        clientType: config.clientType,
        count: annotated.length,
      }, { emit: false });
      return reply({
        torrents: annotated,
        clientType: config.clientType,
        host: publicHost,
        offline: false,
        externalClientType: hasExternal ? config.externalClientType : null,
        hasExternal,
      });
    } catch (err) {
      const formatted = formatClientError(err, config.clientType);
      const safeError = observer.failure("TORRENT_LIST_FAILED", err, {
        clientType: config.clientType,
        offline: formatted.offline,
      });
      // 503 = external client unavailable. Builtin failures are engine errors (502).
      return reply(
        {
          error: "Failed to list torrents",
          message: formatted.offline
            ? "The configured torrent client is unavailable."
            : safeError.message,
          code: formatted.code,
          offline: formatted.offline,
          clientType: config.clientType,
          host: publicHost,
          torrents: [],
          externalClientType: hasExternal ? config.externalClientType : null,
          hasExternal,
        },
        { status: formatted.offline ? 503 : 502 },
      );
    }
  } catch (err) {
    const safeError = observer.failure("TORRENT_LIST_FAILED", err);
    return reply(
      {
        error: "Client API error",
        code: safeError.code,
        message: safeError.message,
        torrents: [],
      },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  const observer = observeRequest(request, "torrent-client", "control-torrent");
  const reply = (body: unknown, init?: ResponseInit) =>
    jsonResponse(observer, body, init);
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return reply({ error: "Unauthorized" }, { status: 401 });
    }

    const config = await getUserClientConfig(session.user.id);
    if (!config) {
      observer.degraded("TORRENT_CONTROL_FAILED", {
        status: "not-configured",
      });
      return reply(
        {
          error: "No torrent client configured",
          message:
            "Could not provision download settings. Try Settings → Built-in.",
          offline: false,
        },
        { status: 400 },
      );
    }

    let body: {
      action?: "pause" | "resume" | "delete";
      hash?: string;
      deleteFiles?: boolean;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return reply({ error: "Invalid JSON body" }, { status: 400 });
    }

    if (!body.action || !body.hash) {
      return reply(
        { error: "action and hash required" },
        { status: 400 },
      );
    }

    const client = getClient(config.clientType);
    let result;

    try {
      if (body.action === "pause" && client.pauseTorrent) {
        result = await client.pauseTorrent(config, body.hash);
      } else if (body.action === "resume" && client.resumeTorrent) {
        result = await client.resumeTorrent(config, body.hash);
      } else if (body.action === "delete" && client.deleteTorrent) {
        const deleteFiles = body.deleteFiles !== false;

        // Capture save path before delete so we can prune empty Season/Show folders
        // (qBit/Transmission leave empty parents; built-in also does after destroyStore).
        let leafPath: string | null = null;
        if (deleteFiles) {
          try {
            const listed = await listClientTorrents(config);
            const match = listed.find(
              (t) => t.hash?.toLowerCase() === body.hash!.toLowerCase(),
            );
            leafPath = match?.savePath?.trim() || null;
          } catch {
            leafPath = null;
          }
        }

        result = await client.deleteTorrent(config, body.hash, deleteFiles);

        // The storage budget memoises the download tree's size; deleting files
        // is the one event that makes it shrink, so drop it now rather than
        // refusing the next send against a stale total.
        if (deleteFiles && result.ok) {
          resetDirectorySizeCache();
        }

        // Built-in already prunes inside deleteTorrent; still safe to run for
        // external clients. For builtin, second pass is a no-op if already clean.
        if (
          deleteFiles &&
          result.ok &&
          leafPath &&
          config.baseDownloadPath?.trim()
        ) {
          try {
            const pruned = pruneEmptyParents(
              leafPath,
              config.baseDownloadPath.trim(),
            );
            if (pruned.removed.length) {
              result = {
                ...result,
                message: `${result.message} · cleaned ${pruned.removed.length} empty folder(s)`,
              };
            }
          } catch {
            /* best-effort */
          }
        }
      } else {
        return reply(
          { error: "Action not supported" },
          { status: 400 },
        );
      }
    } catch (err) {
      const formatted = formatClientError(err, config.clientType);
      const safeError = observer.failure("TORRENT_CONTROL_FAILED", err, {
        action: body.action,
        clientType: config.clientType,
        offline: formatted.offline,
      });
      return reply(
        {
          ok: false,
          message: formatted.offline
            ? "The configured torrent client is unavailable."
            : safeError.message,
          offline: formatted.offline,
          code: formatted.code,
        },
        { status: formatted.offline ? 503 : 502 },
      );
    }

    if (result.ok) {
      observer.success("TORRENT_CONTROL_SUCCEEDED", {
        action: body.action,
        clientType: config.clientType,
      });
    } else {
      observer.degraded("TORRENT_CONTROL_FAILED", {
        action: body.action,
        clientType: config.clientType,
      });
    }
    return reply(
      {
        ...result,
        message: result.ok ? result.message : "Torrent action failed.",
        offline: false,
      },
      { status: result.ok ? 200 : 502 },
    );
  } catch (err) {
    const safeError = observer.failure("TORRENT_CONTROL_FAILED", err);
    return reply(
      {
        ok: false,
        error: "Client action failed",
        code: safeError.code,
        message: safeError.message,
      },
      { status: 500 },
    );
  }
}
