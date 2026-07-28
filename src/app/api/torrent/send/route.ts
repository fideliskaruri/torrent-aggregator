import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import {
  getUserClientConfig,
  resolveSendConfig,
  sendToClient,
} from "@/lib/clients";
import { formatClientError } from "@/lib/clients/errors";
import { resolveSmartSendTarget } from "@/lib/download/smart-target";
import { catalogMetadata } from "@/lib/metadata/catalog-identity";
import type { MediaMetadata } from "@/lib/torrents/types";
import { historyMessageFromFacts } from "@/lib/activity/history";
import {
  existingRetentionOrigin,
  markTorrentStreamOnly,
  promoteTorrentToKept,
  releaseInfoHash,
  retentionStateForOrigin,
  shouldSendAsStreamOnly,
  streamingRetentionEnabled,
} from "@/lib/streaming/retention";
import {
  readDefaultRetentionPolicy,
  resolveSendRetentionChoice,
} from "@/lib/library/retention-settings";

export const dynamic = "force-dynamic";
/** WebTorrent / disk I/O must run in Node, not Edge. */
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: {
      magnet?: string;
      torrentUrl?: string;
      name?: string;
      source?: string;
      infoHash?: string;
      tags?: string[];
      searchCategory?: string | null;
      /** When true, trust body.category as manual override; otherwise re-detect */
      categoryManual?: boolean;
      category?: string | null;
      savePath?: string | null;
      metadata?: MediaMetadata | null;
      /** Watchlist row this grab belongs to; its catalog record beats guessing. */
      watchListItemId?: string | null;
      /**
       * primary (default) = active client (built-in by default).
       * external = optional qBittorrent/Transmission ("Send to my client").
       */
      target?: "primary" | "external";
      /** "stream" = cache entry, "keep" = permanent. */
      retention?: "stream" | "keep";
    };

    try {
      body = (await request.json()) as typeof body;
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body", ok: false, message: "Invalid JSON body" },
        { status: 400 },
      );
    }

    if (!body.magnet && !body.torrentUrl) {
      return NextResponse.json(
        {
          error: "magnet or torrentUrl is required",
          ok: false,
          message: "magnet or torrentUrl is required",
        },
        { status: 400 },
      );
    }

    const baseConfig = await getUserClientConfig(session.user.id);

    if (!baseConfig) {
      return NextResponse.json(
        {
          error: "No torrent client configured",
          ok: false,
          message:
            "Could not provision the built-in download engine. Open Settings and save Built-in, or restart the app.",
        },
        { status: 400 },
      );
    }

    const sendTarget = body.target === "external" ? "external" : "primary";
    let config;
    try {
      config = resolveSendConfig(baseConfig, sendTarget);
    } catch (err) {
      return NextResponse.json(
        {
          ok: false,
          offline: false,
          error: "No external client",
          message: err instanceof Error ? err.message : String(err),
        },
        { status: 400 },
      );
    }

    // A watchlist grab carries the catalog's own verdict — the same record the
    // user picked when adding the show. Resolved server-side from the id
    // rather than trusted from the request body. Anything else falls through
    // to the title heuristics: guessing a show's identity from a bare release
    // name is what misfiles same-named titles, so we don't do it.
    let metadata = body.metadata ?? null;
    if (!metadata && body.watchListItemId) {
      const item = await prisma.watchListItem.findFirst({
        where: { id: body.watchListItemId, userId: session.user.id },
        select: {
          mediaType: true,
          externalId: true,
          title: true,
          posterUrl: true,
          synopsis: true,
          rating: true,
        },
      });
      metadata = catalogMetadata(item);
    }

    const pathTarget = resolveSmartSendTarget(config, {
      name: body.name || "",
      tags: body.tags,
      metadata,
      source: body.source,
      searchCategory: body.searchCategory,
      categoryManual: body.categoryManual,
      category: body.category,
      savePath: body.savePath,
    });

    const { category: cat, savePath, smart } = pathTarget;
    const isBuiltin = config.clientType === "builtin";
    const infoHash = releaseInfoHash({
      infoHash: body.infoHash,
      magnet: body.magnet,
    });
    const existingOrigin = await existingRetentionOrigin(session.user.id, infoHash);
    let sendRetention: "stream" | "keep" | null = body.retention ?? null;
    if (body.retention == null) {
      const defaultRetention = await readDefaultRetentionPolicy(session.user.id);
      sendRetention = resolveSendRetentionChoice({
        defaultPolicy: defaultRetention.policy,
        defaultPolicyPersisted: defaultRetention.persisted,
        explicitRetention: null,
        watchListItemId: body.watchListItemId,
        existingOrigin,
      });
    }
    const streamOnly = shouldSendAsStreamOnly({
      enabled: streamingRetentionEnabled(),
      clientType: config.clientType,
      sendTarget,
      watchListItemId: body.watchListItemId,
      retention: sendRetention,
      existingOrigin,
    });

    // Automatic storage budget (cap under download folder + free-space floor)
    {
      const { assertStorageBudget } = await import("@/lib/library/disk-space");
      const root =
        config.baseDownloadPath?.trim() ||
        savePath ||
        config.savePath?.trim() ||
        process.cwd();
      const budget = await assertStorageBudget({
        root,
        maxStorageBytes: config.maxStorageBytes,
        incomingBytes: null,
      });
      if (!budget.ok) {
        await prisma.downloadHistory.create({
          data: {
            userId: session.user.id,
            title: body.name || "Unknown",
            magnet: body.magnet,
            torrentUrl: body.torrentUrl,
            infoHash: body.infoHash,
            source: body.source,
            status: "failed",
            message: budget.message,
          },
        });
        return NextResponse.json(
          {
            ok: false,
            offline: false,
            error: "Storage limit",
            message: budget.message,
            clientType: config.clientType,
            target: { category: cat, savePath },
          },
          { status: 507 },
        );
      }
    }

    let result: { ok: boolean; message: string };
    try {
      result = await sendToClient(config, {
        magnet: body.magnet,
        torrentUrl: body.torrentUrl,
        name: body.name,
        category: cat,
        savePath,
        streamOnly,
      });
    } catch (err) {
      // Pass clientType so builtin never gets ECONNREFUSED "offline" framing
      const formatted = formatClientError(err, config.clientType);
      result = {
        ok: false,
        message: formatted.message,
      };
      await prisma.downloadHistory.create({
        data: {
          userId: session.user.id,
          title: body.name || "Unknown",
          magnet: body.magnet,
          torrentUrl: body.torrentUrl,
          infoHash: body.infoHash,
          source: body.source,
          status: "failed",
          message: formatted.message,
        },
      });
      return NextResponse.json(
        {
          ...result,
          offline: formatted.offline,
          code: formatted.code,
          clientType: config.clientType,
          sendTarget,
          target: { category: cat, savePath },
          smart: {
            kind: smart.kind,
            category: smart.category,
            confidence: smart.confidence,
          },
        },
        { status: formatted.offline ? 503 : 502 },
      );
    }

    // Offline only for external clients. Builtin never talks to host:8080.
    const looksOffline =
      !isBuiltin &&
      !result.ok &&
      /unreachable|econnrefused|fetch failed|timeout|not listening|cannot reach/i.test(
        result.message || "",
      );

    await prisma.downloadHistory.create({
      data: {
        userId: session.user.id,
        title: body.name || "Unknown",
        magnet: body.magnet,
        torrentUrl: body.torrentUrl,
        infoHash: body.infoHash,
        source: body.source,
        status: result.ok ? "sent" : "failed",
        message: historyMessageFromFacts({ message: result.message }),
        category: cat ?? null,
        savePath: savePath ?? null,
        clientType: config.clientType,
        sendKind: smart.kind,
      },
    });

    let retentionState = retentionStateForOrigin(
      existingOrigin ?? (streamOnly ? "stream" : "user"),
    );
    if (result.ok && isBuiltin && sendTarget === "primary") {
      if (streamOnly) {
        await markTorrentStreamOnly(session.user.id, infoHash, {
          allowFreshDefaultOrigin: existingOrigin == null,
        });
        retentionState = "stream";
      } else {
        await promoteTorrentToKept(session.user.id, infoHash);
        retentionState = "kept";
      }
    }

    return NextResponse.json(
      {
        ...result,
        offline: looksOffline,
        clientType: config.clientType,
        sendTarget,
        target: { category: cat, savePath },
        smart: {
          kind: smart.kind,
          category: smart.category,
          confidence: smart.confidence,
        },
        retentionState,
      },
      { status: result.ok ? 200 : looksOffline ? 503 : 502 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const offline =
      /econnrefused|unreachable|fetch failed|timeout|not listening|cannot reach/i.test(
        message,
      );
    return NextResponse.json(
      {
        ok: false,
        offline,
        error: offline ? "Client offline" : "Send failed",
        message: offline
          ? "Cannot reach external torrent client. Check Host URL in Settings, or use built-in Send."
          : message,
      },
      { status: offline ? 503 : 500 },
    );
  }
}
