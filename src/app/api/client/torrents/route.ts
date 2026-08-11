import { NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import {
  getUserClientConfig,
  getClient,
  listClientTorrents,
} from "@/lib/clients";
import type { TorrentClientType } from "@/lib/clients";
import { formatClientError } from "@/lib/clients/errors";
import {
  aggregateOwnedTorrents,
  clientTypeLabel,
  inspectOtherOwners,
  otherOwnerState,
  ownedTransferState,
  transferStoragePathsOverlap,
  verifyOwnedTransfer,
} from "@/lib/clients/transfer-ownership";
import { pruneEmptyParents } from "@/lib/clients/prune-empty-parents";
import { resetDirectorySizeCache } from "@/lib/library/disk-space";
import { resetDiskInventoryCache } from "@/lib/library/disk-inventory";
import { resetLocalFilePresenceCache } from "@/lib/library/local-file-presence";
import prisma from "@/lib/prisma";
import {
  isDownloadRetention,
  retentionStateForOrigin,
} from "@/lib/streaming/retention";
import {
  jsonResponse,
  observeRequest,
} from "@/lib/observability/logging";
import { displayTitleFromWorkKey } from "@/components/title/work-key";
import { acquisitionWorksForUser } from "@/lib/work/store";
import { acquisitionIntentByHash } from "./acquisition-intent";

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
      const snapshot = await aggregateOwnedTorrents(
        config,
        listClientTorrents,
      );
      const torrents = snapshot.torrents;
      const hashes = [
        ...new Set(
          torrents
            .map((t) => t.hash?.toLowerCase())
            .filter((h): h is string => Boolean(h)),
        ),
      ];
      const hashVariants = [
        ...new Set(hashes.flatMap((hash) => [hash, hash.toUpperCase()])),
      ];
      const [engineRows, allTargetRows] = hashes.length
        ? await Promise.all([
            prisma.engineTorrent.findMany({
              where: { userId: session.user.id, hash: { in: hashVariants } },
              select: { hash: true, origin: true },
            }),
            acquisitionWorksForUser(session.user.id, hashes),
          ])
        : [[], []];
      const targetRows = allTargetRows;
      const origins = new Map(
        engineRows.map((row) => [row.hash.toLowerCase(), row.origin] as const),
      );
      const targetByHash = acquisitionIntentByHash(targetRows);
      const workKeys = [
        ...new Set(targetRows.map((target) => target.workKey).filter(Boolean)),
      ];
      const catalogRows = workKeys.length > 0
        ? await prisma.catalogEntry.findMany({
            where: { workKey: { in: workKeys } },
            orderBy: { refreshedAt: "desc" },
            select: {
              workKey: true,
              title: true,
              year: true,
              mediaType: true,
            },
          })
        : [];
      const catalogByWorkKey = new Map<
        string,
        (typeof catalogRows)[number]
      >();
      for (const row of catalogRows) {
        if (!catalogByWorkKey.has(row.workKey)) {
          catalogByWorkKey.set(row.workKey, row);
        }
      }
      const annotated = torrents.map((torrent) => {
        const hash = torrent.hash?.trim().toLowerCase() ?? "";
        const target = hash ? targetByHash.get(hash) ?? null : null;
        const catalog = target
          ? catalogByWorkKey.get(target.workKey) ?? null
          : null;
        const intent = target
          ? {
              workId: target.workId,
              workKey: target.workKey,
              workTitle:
                target.canonicalTitle
                ?? catalog?.title
                ?? displayTitleFromWorkKey(target.workKey),
              workYear: target.year ?? catalog?.year ?? null,
              workMediaType:
                (target.mediaType !== "unknown" ? target.mediaType : null)
                ?? catalog?.mediaType
                ?? torrent.category
                ?? null,
              targetScope: target.scope,
              season: target.season,
              episode: target.episode,
            }
          : {};

        if (torrent.ownerClientType !== "builtin") {
          return { ...torrent, ...intent };
        }
        const retentionState = retentionStateForOrigin(
          hash ? origins.get(hash) : null,
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
            ...intent,
          };
        }
        return { ...torrent, retentionState, ...intent };
      });
      const clientIssues = snapshot.issues.map((issue) => {
        const formatted = formatClientError(issue.error, issue.clientType);
        return {
          clientType: issue.clientType,
          label: clientTypeLabel(issue.clientType),
          message: formatted.offline
            ? `${clientTypeLabel(issue.clientType)} is unavailable.`
            : formatted.message,
          offline: formatted.offline,
        };
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
        partial: clientIssues.length > 0,
        clientIssues,
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
      ownerClientType?: TorrentClientType;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return reply({ error: "Invalid JSON body" }, { status: 400 });
    }

    if (!body.action || !body.hash || !body.ownerClientType) {
      return reply(
        { error: "action, hash and ownerClientType required" },
        { status: 400 },
      );
    }
    if (
      body.ownerClientType !== "builtin" &&
      body.ownerClientType !== "qbittorrent" &&
      body.ownerClientType !== "transmission"
    ) {
      return reply({ error: "Invalid ownerClientType" }, { status: 400 });
    }

    let owned;
    try {
      owned = await verifyOwnedTransfer(
        config,
        body.ownerClientType,
        body.hash,
        listClientTorrents,
      );
    } catch (err) {
      const formatted = formatClientError(err, body.ownerClientType);
      return reply(
        {
          ok: false,
          message: formatted.offline
            ? `${clientTypeLabel(body.ownerClientType)} is unavailable.`
            : formatted.message,
          offline: formatted.offline,
        },
        { status: formatted.offline ? 503 : 502 },
      );
    }
    if (!owned) {
      return reply(
        {
          ok: false,
          message:
            "That transfer was not found in its recorded owner. Refresh and try again.",
        },
        { status: 404 },
      );
    }

    const ownerConfig = owned.config;
    const client = getClient(ownerConfig.clientType);
    let result;

    try {
      if (body.action === "pause" && client.pauseTorrent) {
        result = await client.pauseTorrent(ownerConfig, body.hash);
      } else if (body.action === "resume" && client.resumeTorrent) {
        result = await client.resumeTorrent(ownerConfig, body.hash);
      } else if (body.action === "delete" && client.deleteTorrent) {
        const deleteFiles = body.deleteFiles !== false;
        const otherOwners = deleteFiles
          ? await inspectOtherOwners(
              config,
              body.ownerClientType,
              body.hash,
              listClientTorrents,
            )
          : { torrents: [], unknown: false };
        if (deleteFiles && otherOwners.unknown) {
          return reply(
            {
              ok: false,
              message:
                "Could not verify whether another configured client still uses these files. Reconnect it or remove only the transfer.",
            },
            { status: 503 },
          );
        }
        if (
          deleteFiles &&
          otherOwners.torrents.some((torrent) =>
            transferStoragePathsOverlap(
              owned.torrent.savePath,
              torrent.savePath,
            ),
          )
        ) {
          return reply(
            {
              ok: false,
              message:
                "Another torrent client still uses the same files. Remove only this transfer or delete the other copy first.",
            },
            { status: 409 },
          );
        }

        // Capture save path before delete so we can prune empty Season/Show folders
        // (qBit/Transmission leave empty parents; built-in also does after destroyStore).
        const leafPath = deleteFiles
          ? owned.torrent.savePath?.trim() || null
          : null;

        result = await client.deleteTorrent(
          ownerConfig,
          body.hash,
          deleteFiles,
        );

        const removedFromOwner =
          result.ok
            ? await ownedTransferState(
                config,
                body.ownerClientType,
                body.hash,
                listClientTorrents,
              )
            : "unknown";
        if (result.ok && removedFromOwner !== "absent") {
          result = {
            ok: false,
            message:
              removedFromOwner === "present"
                ? `${clientTypeLabel(body.ownerClientType)} did not remove that transfer.`
                : `Could not verify that ${clientTypeLabel(body.ownerClientType)} removed that transfer.`,
          };
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

        // Only confirmed removal can invalidate local file facts. A qBittorrent
        // delete endpoint may return success for an unknown hash, so the remote
        // acknowledgement alone is not proof that anything was removed.
        if (deleteFiles && result.ok && removedFromOwner === "absent") {
          resetDirectorySizeCache();
          resetDiskInventoryCache();
          resetLocalFilePresenceCache();
        }

        // Delete means gone — the client and the files are already removed, so
        // the rows that remember this infoHash must go too. Left behind, they
        // keep the title page claiming the content is present (stale
        // AcquisitionTarget), block an immediate re-grab (a "sent" GrabJob
        // inside the dedup window), and offer a broken resume (PlaybackProgress
        // pointing at a deleted file). A hash is hex, so the three case
        // spellings below cover every way a client or indexer stored it.
        const remainingOwner =
          deleteFiles && result.ok && removedFromOwner === "absent"
            ? await otherOwnerState(
                config,
                body.ownerClientType,
                body.hash,
                listClientTorrents,
              )
            : "unknown";
        if (
          deleteFiles &&
          result.ok &&
          removedFromOwner === "absent" &&
          remainingOwner === "absent"
        ) {
          const hash = body.hash;
          const infoHashes = [hash, hash.toLowerCase(), hash.toUpperCase()];
          try {
            await prisma.$transaction([
              prisma.grabJob.deleteMany({
                where: { userId: session.user.id, infoHash: { in: infoHashes } },
              }),
              prisma.acquisitionTarget.deleteMany({
                where: { userId: session.user.id, infoHash: { in: infoHashes } },
              }),
              prisma.playbackProgress.deleteMany({
                where: { userId: session.user.id, infoHash: { in: infoHashes } },
              }),
            ]);
          } catch {
            /* best-effort: the torrent and files are already gone */
          }
        }
      } else {
        return reply(
          { error: "Action not supported" },
          { status: 400 },
        );
      }
    } catch (err) {
      const formatted = formatClientError(err, body.ownerClientType);
      const safeError = observer.failure("TORRENT_CONTROL_FAILED", err, {
        action: body.action,
        clientType: body.ownerClientType,
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
        clientType: body.ownerClientType,
      });
    } else {
      observer.degraded("TORRENT_CONTROL_FAILED", {
        action: body.action,
        clientType: body.ownerClientType,
      });
    }
    return reply(
      {
        ...result,
        ownerClientType: body.ownerClientType,
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
