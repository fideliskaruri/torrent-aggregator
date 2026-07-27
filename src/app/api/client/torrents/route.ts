import { NextRequest, NextResponse } from "next/server";
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
import { retentionStateForOrigin } from "@/lib/streaming/retention";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const config = await getUserClientConfig(session.user.id);
    if (!config) {
      return NextResponse.json(
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
      const annotated = torrents.map((torrent) => ({
        ...torrent,
        retentionState: retentionStateForOrigin(
          torrent.hash ? origins.get(torrent.hash.toLowerCase()) : null,
        ),
      }));
      return NextResponse.json({
        torrents: annotated,
        clientType: config.clientType,
        host: publicHost,
        offline: false,
        externalClientType: hasExternal ? config.externalClientType : null,
        hasExternal,
      });
    } catch (err) {
      const formatted = formatClientError(err, config.clientType);
      // 503 = external client unavailable. Builtin failures are engine errors (502).
      return NextResponse.json(
        {
          error: "Failed to list torrents",
          message: formatted.message,
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
    return NextResponse.json(
      {
        error: "Client API error",
        message: err instanceof Error ? err.message : String(err),
        torrents: [],
      },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const config = await getUserClientConfig(session.user.id);
    if (!config) {
      return NextResponse.json(
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
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    if (!body.action || !body.hash) {
      return NextResponse.json(
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
        return NextResponse.json(
          { error: `Action ${body.action} not supported` },
          { status: 400 },
        );
      }
    } catch (err) {
      const formatted = formatClientError(err, config.clientType);
      return NextResponse.json(
        {
          ok: false,
          message: formatted.message,
          offline: formatted.offline,
          code: formatted.code,
        },
        { status: formatted.offline ? 503 : 502 },
      );
    }

    return NextResponse.json(
      { ...result, offline: false },
      { status: result.ok ? 200 : 502 },
    );
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: "Client action failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
