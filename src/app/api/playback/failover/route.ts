/**
 * POST /api/playback/failover — MANUAL OVERRIDE
 *
 * The primary trigger for the swarm-delivery watchdog is server-side: the
 * engine's foreground poll (`pollForegroundSwarmWatch` in
 * `swarm-delivery-watchdog.ts`) drives a tick every 5s for whatever is the
 * foreground stream, with no client involvement. This route is a *manual
 * override* on the same seam — a way to force one watchdog tick for a specific
 * source, useful for diagnostics or a client that wants to nudge a switch. It is
 * deliberately not the only way in, so nothing breaks if a client never calls it.
 *
 * It samples the live transfer, judges it against the stall rule, and — only
 * when the source is genuinely dead — fails over to the next untried release of
 * the same content, abandoning (pausing, not deleting) the stalled one.
 *
 * The response is **structured playback state** plus its rendered copy from the
 * single presentation seam. The engine never writes the words; `describePlayback`
 * does, so the UI can render an honest "this source stalled, trying another" or
 * a terminal "no working source" instead of a bare spinner. See `narration.ts`
 * and commit `badaf94`.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getUserClientConfig } from "@/lib/clients";
import { normalizeInfoHash } from "@/lib/torrents/infohash";
import { preRankKey } from "@/lib/prewarm/prerank";
import type { PreRankTarget } from "@/lib/prewarm/types";
import { describePlayback } from "@/lib/playback/narration";
import { buildSwarmWatchDeps } from "@/lib/playback/engine-deps";
import { swarmDeliveryTick } from "@/lib/playback/swarm-delivery-watchdog";
import { builtinClient } from "@/lib/clients/builtin-engine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function json(status: number, body: Record<string, unknown>): Response {
  return NextResponse.json(body, { status });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return json(401, { error: "Not authenticated" });

  const config = await getUserClientConfig(session.user.id);
  if (!config) return json(503, { error: "No torrent client configured" });
  if (config.clientType !== "builtin") {
    return json(409, {
      error: "Play-time failover requires the built-in client",
      clientType: config.clientType,
    });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const infoHash = normalizeInfoHash(
    typeof body.infoHash === "string" ? body.infoHash : null,
  );
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!infoHash || !title) {
    return json(400, { error: "infoHash and title are required" });
  }

  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.trunc(v) : null;

  // The automatic watchdog only ever fails a source over for a *delivery* stall.
  // A caller may instead report a *playability* failure — the swarm is healthy
  // but the browser cannot decode this release — which the byte-delivery rule
  // would never catch, so it also forces the switch past that rule.
  const reason: "delivery" | "playability" =
    body.reason === "playability" ? "playability" : "delivery";

  const target: PreRankTarget = {
    title,
    mediaType: typeof body.mediaType === "string" ? body.mediaType : "tv",
    season: num(body.season),
    episode: num(body.episode),
    preferredResolution: num(body.preferredResolution),
  };
  const contentKey = preRankKey(target);

  // I19b: retry the SAME release instead of failing over to a different one.
  // A transient DELIVERY failure (no peers / blocked path — e.g. the user just
  // turned a VPN off) must not permanently abandon a good torrent. Only delivery
  // failures are retryable: a playability failure means the bytes are fine but
  // undecodable, so re-announcing the same infoHash would change nothing.
  if (body.action === "retry") {
    if (reason === "playability") {
      return json(409, {
        ok: false,
        code: "NOT_RETRYABLE",
        failureClass: "playability",
        retryable: false,
        infoHash,
      });
    }
    const retry = await builtinClient.retryTorrent(config, infoHash);
    if (!retry.ok) {
      // Expected outcome (no saved source, etc.) — never a 500.
      return json(200, {
        ok: false,
        code: "RETRY_FAILED",
        failureClass: "delivery",
        retryable: false,
        infoHash,
        message: retry.message,
      });
    }
    return json(200, {
      ok: true,
      code: "RETRYING",
      failureClass: "delivery",
      retryable: true,
      infoHash,
      retried: true,
    });
  }

  try {
    const deps = buildSwarmWatchDeps(config, session.user.id);
    const result = await swarmDeliveryTick(contentKey, infoHash, target, deps, {
      cause: reason,
      force: reason === "playability",
    });
    // Discriminated status code so the client never has to parse prose (I33).
    const code = result.exhausted
      ? "EXHAUSTED"
      : result.switched
        ? "SWITCHED"
        : result.verdict.stalled
          ? "STALLED"
          : "PLAYING";
    return json(200, {
      code,
      // Structured facts — the source of truth for the client.
      narration: result.narration,
      // Rendered by the one presentation seam, for direct display.
      copy: describePlayback(result.narration),
      currentHash: result.currentHash,
      switched: result.switched,
      exhausted: result.exhausted,
      stall: {
        stalled: result.verdict.stalled,
        reason: result.verdict.reason,
        deliveredBytes: result.verdict.deliveredBytes,
        windowMs: result.verdict.windowMs,
      },
    });
  } catch (err) {
    // Only genuinely unexpected engine faults reach here — expected no-source
    // and exhausted outcomes are returned as 200 above (I33).
    return json(500, {
      code: "ENGINE_ERROR",
      error: "Failover tick failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
