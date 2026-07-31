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
} from "@/lib/streaming/retention";
import {
  readDefaultRetentionPolicy,
  resolveSendRetentionChoice,
} from "@/lib/library/retention-settings";
import { sendRetentionToPurpose } from "@/lib/streaming/send-retention";

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
      /**
       * The owner was shown the real figures and chose to exceed their own cap.
       * Only the cap can be overridden — the free-space floor ignores this.
       */
      overrideStorageCap?: boolean;
    };

    try {
      body = (await request.json()) as typeof body;
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body", ok: false, message: "Invalid JSON body" },
        { status: 400 },
      );
    }

    if (!body.magnet && !body.torrentUrl && !(body.infoHash && body.retention)) {
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

    if (!body.magnet && !body.torrentUrl && body.infoHash && body.retention) {
      const infoHash = releaseInfoHash({ infoHash: body.infoHash });
      const existing = await existingRetentionOrigin(session.user.id, infoHash);
      // A failed read shows honestly as "unknown"; it never implies a state.
      let retentionState =
        existing.status === "found"
          ? retentionStateForOrigin(existing.origin)
          : "unknown";
      if (config.clientType === "builtin" && sendTarget === "primary") {
        if (body.retention === "stream") {
          // Play toggle: prewarm|stream → stream (issue B). The guard inside
          // markTorrentStreamOnly can never touch a `user` row, so a toggle can
          // never demote a real download; the old `allowFreshDefaultOrigin`
          // escape hatch that let a null/failed read demote a user row is gone.
          await markTorrentStreamOnly(session.user.id, infoHash);
          retentionState = "stream";
        } else {
          await promoteTorrentToKept(session.user.id, infoHash);
          retentionState = "kept";
        }
      }
      return NextResponse.json({
        ok: true,
        message: body.retention === "keep" ? "Kept in your library." : "Marked stream-only.",
        clientType: config.clientType,
        sendTarget,
        retentionState,
      });
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
    const existingLookup = await existingRetentionOrigin(session.user.id, infoHash);
    const existingOrigin =
      existingLookup.status === "found" ? existingLookup.origin : null;
    let sendRetention: "stream" | "keep" | null = body.retention ?? null;
    if (body.retention == null) {
      if (existingLookup.status === "error") {
        // Fail closed (issue D / rule 3): if we cannot read the existing origin
        // we must NOT default an untyped send to an evictable stream. A genuine
        // `user` download would then have its history hidden and could later
        // fall in scope of stream eviction. `keep` is the non-destructive choice
        // under uncertainty; we never guess toward deletion.
        sendRetention = "keep";
      } else {
        const defaultRetention = await readDefaultRetentionPolicy(session.user.id);
        sendRetention = resolveSendRetentionChoice({
          defaultPolicy: defaultRetention.policy,
          defaultPolicyPersisted: defaultRetention.persisted,
          explicitRetention: null,
          watchListItemId: body.watchListItemId,
          existingOrigin,
        });
      }
    }
    // The engine's authoritative add intent, derived from the resolved retention
    // choice. The builtin engine is ALWAYS told the true intent so a fresh row
    // is born `stream` and a Play of an existing `prewarm` promotes to `stream`
    // rather than being (mis)classified by the engine's `user` default — the
    // original bug. A watchlisted stream resolves to `keep` inside the helper.
    const purpose = sendRetentionToPurpose(sendRetention, body.watchListItemId);
    // Honesty (issue G): an external client cannot honour a stream — it always
    // fetches the whole file — so we neither pretend it streamed nor silently
    // relabel it. `streamDegraded` is surfaced to the caller and the row is
    // recorded as a kept download.
    const streamDegraded = purpose === "stream" && !isBuiltin;
    // What actually lands on disk. Only a genuine builtin stream is tagged
    // `stream` so Activity / Recently Added can hide it (issue E); a degraded
    // external "stream" is an honest kept download.
    const historyRetention = isBuiltin && purpose === "stream" ? "stream" : "keep";

    // Automatic storage budget (cap under download folder + free-space floor).
    // Play reclaims stream cache before refusing; Download still obeys the cap.
    {
      const { checkSendStorage } = await import("@/lib/library/storage-gate");
      const root =
        config.baseDownloadPath?.trim() ||
        savePath ||
        config.savePath?.trim() ||
        process.cwd();
      const budget = await checkSendStorage({
        userId: session.user.id,
        config,
        root,
        incomingBytes: null,
        retention: sendRetention,
        // Never reclaim the very thing being sent: the viewer may be re-playing
        // a stalled allocation, and freeing it to make room for itself would
        // delete the request out from under the request.
        protectHashes: body.infoHash ? [body.infoHash] : undefined,
        overrideCap: body.overrideStorageCap === true,
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
            retention: historyRetention,
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
            // The facts the client needs to offer a real choice instead of a
            // dead end: which limit, whether it may be overridden, the numbers,
            // and where the control that changes it lives.
            storage: budget.override,
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
        purpose,
        // The gate above already decided this may proceed. Without carrying
        // that forward the engine's own check refuses it again.
        overrideStorageCap: body.overrideStorageCap === true,
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
          retention: historyRetention,
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
        retention: historyRetention,
      },
    });

    let retentionState = retentionStateForOrigin(
      existingOrigin ?? (purpose === "stream" ? "stream" : "user"),
    );
    if (result.ok && isBuiltin && sendTarget === "primary") {
      if (purpose === "stream") {
        // Verification only — the engine already birthed/kept the correct origin
        // from `purpose`. Idempotent on a `stream` row and (issue B) promotes a
        // `prewarm` up to `stream`; it can never touch a `user` row.
        await markTorrentStreamOnly(session.user.id, infoHash);
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
        streamDegraded,
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
