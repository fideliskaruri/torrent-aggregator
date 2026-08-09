/**
 * Shared grab pipeline: search → select → dedupe → viability → storage →
 * send → record.
 *
 * All three callers (automation, rules, on-demand) share this implementation.
 * Behavioural differences are injected via typed hooks in GrabPipelineOptions;
 * the pipeline itself contains no caller-specific branches.
 *
 * Transaction safety: the client send is an external side-effect that cannot
 * be rolled back. The pipeline therefore orders operations so a crash can
 * only cause a *retry*, never a *skip*:
 *
 *   1. Send to client (external, irreversible)
 *   2. In one atomic transaction:
 *      a. Check idempotency guard (recent grab with same infoHash?)
 *      b. Write GrabJob
 *      c. Write DownloadHistory
 *      d. Call onSuccess / onFailure (cursor advance, rule state, etc.)
 *
 * If the process crashes between 1 and 2, the cursor has not advanced, so the
 * next run re-discovers the same episode and dedupes on infoHash. Losing an
 * episode silently (cursor advanced past a never-grabbed ep) is impossible.
 *
 * If the transaction itself fails (e.g. a DB constraint), ALL writes roll
 * back together — GrabJob, DownloadHistory, AND the caller's cursor/state —
 * leaving the DB exactly as it was before the attempt.
 *
 * Idempotency: inside the transaction, the pipeline checks whether a recent
 * successful grab already exists for the same (userId, normalised infoHash).
 * If so it refreshes that record's message on both GrabJob and DownloadHistory
 * (the client's latest status is the more useful one) and returns
 * `"already_active"` without creating a second pair. The check is inside the
 * transaction, and a unique-violation on write is caught as the same outcome,
 * so two concurrent requests cannot both produce a row.
 *
 * The guard only applies when an infoHash is present — a NULL hash means
 * "unknown", not "the same release" — and only within
 * `GRAB_DEDUP_WINDOW_MS`, so deleting a download and re-grabbing it later,
 * or grabbing the same release again months on, still works.
 */
import prisma from "@/lib/prisma";
import { searchTorrents } from "@/lib/torrents/aggregator";
import { sendToClient } from "@/lib/clients";
import { formatClientError, isClientOfflineError } from "@/lib/clients/errors";
import type { GrabPipelineOptions, GrabPipelineResult } from "./types";
import { historyMessageFromFacts } from "@/lib/activity/history";
import {
  meetsResolutionFloor,
  normalizeResolutionFloor,
} from "@/lib/torrents/quality";

/**
 * How long a prior grab blocks a second grab of the same infoHash.
 *
 * 5 minutes: long enough to absorb double-clicks, concurrent automation
 * + manual grabs, and retry storms. Short enough that a user who deletes
 * a download and re-grabs (or grabs a better release of the same content
 * months later) is never blocked.
 */
export const GRAB_DEDUP_WINDOW_MS = 5 * 60 * 1000;

/**
 * Lowercase + strip all whitespace — indexers deliver mixed-case hashes, and
 * some wrap them in padding. Two spellings of one hash must compare equal or
 * the guard silently lets the duplicate through.
 */
export function normalizeInfoHash(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/\s+/g, "").toLowerCase();
  return cleaned || null;
}

/**
 * True when Prisma rejected a write because a uniqueness rule on infoHash was
 * violated — i.e. a concurrent request won the race to create the same grab.
 *
 * This is the backstop for the in-transaction read guard. SQLite does not take
 * a write lock for a read, so two interactive transactions *can* both pass the
 * `findFirst` before either writes. Only a database constraint makes the
 * invariant truly enforceable; until one exists this branch simply never fires.
 */
function isInfoHashUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; meta?: { target?: unknown } };
  if (e?.code !== "P2002") return false;
  const target = e.meta?.target;
  const text = Array.isArray(target) ? target.join(",") : String(target ?? "");
  return /infohash/i.test(text);
}

function looksOfflineMessage(message: string): boolean {
  return /unreachable|econnrefused|fetch failed|timeout|not listening|cannot reach/i.test(
    message || "",
  );
}

/**
 * Run the shared grab pipeline once for a single candidate.
 *
 * Callers iterate over their own work items (rules, watchlist rows, etc.)
 * and call this once per item. The pipeline handles everything from search
 * through recording — callers never touch sendToClient or write GrabJob
 * directly.
 */
export async function runGrabPipeline(
  opts: GrabPipelineOptions,
): Promise<GrabPipelineResult> {
  const {
    userId,
    search,
    config,
    selectCandidate,
    checkDuplicate,
    checkViability,
    checkStorageBudget,
    resolveTarget,
    fallbackTitle,
    grabJobKind,
    externalId,
    purpose,
    addPayload,
    onSuccess,
    onFailure,
    onNoCandidate,
  } = opts;

  const doSearch = opts._searchFn ?? searchTorrents;
  const doSend = opts._sendFn ?? sendToClient;
  const db = opts._prisma ?? prisma;

  // ── 1. Search ──────────────────────────────────────────────────────────
  const result = await doSearch({
    query: search.query,
    category: search.category,
    limit: search.limit,
    sources: search.sources,
    enrich: search.enrich,
    skipCache: search.skipCache,
    background: search.background,
    targetResolution: search.targetResolution,
    filters: {
      hasMagnet: search.filters.hasMagnet,
      minSeeders: search.filters.minSeeders,
      maxSizeBytes: search.filters.maxSizeBytes,
      resolution: search.filters.resolution,
      season: search.filters.season,
      episode: search.filters.episode,
    },
  });

  // ── 2. Select candidate ────────────────────────────────────────────────
  const candidate = selectCandidate(result.results);

  if (!candidate?.magnet) {
    const message = opts.noMatchMessage
      ? opts.noMatchMessage(result.results.length)
      : result.results.length
        ? `No matching release in ${result.results.length} results`
        : "No matching torrents";
    await db.grabJob.create({
      data: {
        userId,
        title: fallbackTitle,
        query: search.query,
        status: "skipped",
        message,
        kind: grabJobKind,
        externalId,
      },
    });
    await onNoCandidate?.("no_results", message, null);
    return { status: "skipped", message, candidate: null, target: null, offline: false };
  }

  const minimumResolution = normalizeResolutionFloor(opts.minimumResolution);
  if (
    minimumResolution != null &&
    !meetsResolutionFloor(candidate.title, minimumResolution)
  ) {
    const message = `Skipped ${candidate.title}: it does not meet the ${minimumResolution}p minimum quality`;
    await db.grabJob.create({
      data: {
        userId,
        title: candidate.title,
        query: search.query,
        status: "skipped",
        message,
        magnet: candidate.magnet,
        infoHash: normalizeInfoHash(candidate.infoHash),
        source: candidate.source,
        kind: grabJobKind,
        externalId,
      },
    });
    await onNoCandidate?.("below_resolution_floor", message, candidate);
    return {
      status: "skipped",
      message,
      candidate,
      target: null,
      offline: false,
    };
  }

  // ── 3. Dedupe ──────────────────────────────────────────────────────────
  if (checkDuplicate) {
    const dupeReason = await checkDuplicate(candidate);
    if (dupeReason) {
      await db.grabJob.create({
        data: {
          userId,
          title: candidate.title,
          query: search.query,
          status: "skipped",
          message: dupeReason,
          magnet: candidate.magnet,
          infoHash: normalizeInfoHash(candidate.infoHash),
          source: candidate.source,
          kind: grabJobKind,
          externalId,
        },
      });
      await onNoCandidate?.("duplicate", dupeReason, candidate);
      return { status: "skipped", message: dupeReason, candidate, target: null, offline: false };
    }
  }

  // ── 4. Viability gate ──────────────────────────────────────────────────
  if (checkViability) {
    const viability = await checkViability(candidate);
    if (!viability.proceed) {
      await db.grabJob.create({
        data: {
          userId,
          title: candidate.title,
          query: search.query,
          status: "skipped",
          message: viability.message,
          magnet: candidate.magnet,
          infoHash: normalizeInfoHash(candidate.infoHash),
          source: candidate.source,
          kind: grabJobKind,
          externalId,
        },
      });
      const reason = viability.deferred ? "deferred" : "not_viable";
      await onNoCandidate?.(reason, viability.message, candidate);
      return { status: "skipped", message: viability.message, candidate, target: null, offline: false };
    }
  }

  // ── 5. Resolve download target (category + path) ───────────────────────
  const target = resolveTarget(config, candidate);

  // ── 6. Storage budget ──────────────────────────────────────────────────
  if (checkStorageBudget) {
    const space = await checkStorageBudget(candidate, target);
    if (!space.ok) {
      await db.grabJob.create({
        data: {
          userId,
          title: candidate.title,
          query: search.query,
          status: "failed",
          message: space.message,
          magnet: candidate.magnet,
          infoHash: normalizeInfoHash(candidate.infoHash),
          source: candidate.source,
          savePath: target.savePath,
          category: target.category,
          kind: grabJobKind,
          externalId,
        },
      });
      // Storage failures are pre-send: no tx needed, no cursor to protect.
      return {
        status: "failed",
        message: space.message,
        candidate,
        target,
        offline: false,
        storage: space.storage ?? null,
      };
    }
  }

  // ── 7. Send to torrent client (external, irreversible) ─────────────────
  //
  // This MUST happen before the transaction. A crash after send but before
  // the transaction leaves the cursor un-advanced, so the next run
  // re-discovers the same episode and dedupes on infoHash — a retry, never
  // a skip. The reverse (transaction first, then send) would advance the
  // cursor on success and then crash before the torrent actually reached the
  // client — permanently losing an episode.
  let send: { ok: boolean; message: string };
  let offline = false;
  try {
    send = await doSend(config, {
      magnet: candidate.magnet,
      torrentUrl: candidate.torrentUrl,
      name: candidate.title,
      category: target.category,
      savePath: target.savePath,
      ...addPayload,
      // Purpose is authoritative and required — spread last so a stray
      // addPayload can never leave the intent unstated or override it.
      purpose,
    });
  } catch (err) {
    const formatted = formatClientError(err, config.clientType);
    send = { ok: false, message: formatted.message };
    offline =
      config.clientType !== "builtin" &&
      (formatted.offline || isClientOfflineError(err));
  }

  if (
    config.clientType !== "builtin" &&
    !send.ok &&
    looksOfflineMessage(send.message)
  ) {
    offline = true;
  }

  // ── 8. Atomic commit: GrabJob + DownloadHistory + caller state ─────────
  //
  // Everything in this block is DB-only. The hooks (onSuccess / onFailure)
  // receive the tx handle and MUST write through it, so a failure at any
  // point rolls back ALL writes — including the caller's cursor advance or
  // rule state update. No network calls inside the transaction.
  //
  // The idempotency guard is the first thing inside the transaction: if
  // this (userId, infoHash) was already grabbed successfully within the
  // dedup window, we refresh the existing GrabJob + DownloadHistory message
  // (the client's latest status is more useful than the original) and skip
  // everything else — including the caller's onSuccess hook, so no cursor
  // advances twice for one grab. The read is inside the transaction, and a
  // unique-violation on the write is caught as the same outcome, so two
  // concurrent requests cannot both produce a row.
  const historyPrefix = opts.downloadHistoryPrefix ??
    (grabJobKind === "library"
      ? "Library automation"
      : grabJobKind === "rule"
        ? "Auto-rule"
        : "On-demand");

  const historyFacts = () => ({
    context: historyPrefix,
    message: send.message,
    category: target.category ?? null,
    savePath: target.savePath ?? null,
  });

  const buildHistoryMessage = () => historyMessageFromFacts(historyFacts());

  const hash = normalizeInfoHash(candidate.infoHash);
  const eventCreatedAt = new Date();
  let alreadyActive = false;
  let alreadyActiveMessage = "";

  try {
    await db.$transaction(async (tx) => {
      // ── Idempotency guard ────────────────────────────────────────────
      // Only guard when we have a real infoHash. Rows without one (magnet-
      // only releases, seeded fixtures) share a NULL and must never collapse
      // into a single "duplicate" — NULL is "unknown", not "the same".
      if (hash) {
        const cutoff = new Date(Date.now() - GRAB_DEDUP_WINDOW_MS);
        const existing = await tx.grabJob.findFirst({
          where: {
            userId,
            infoHash: hash,
            status: "sent",
            createdAt: { gte: cutoff },
          },
          orderBy: { createdAt: "desc" },
          select: { id: true, message: true },
        });
        if (existing) {
          alreadyActive = true;
          alreadyActiveMessage = send.ok ? send.message : (existing.message ?? "");

          // Only a *successful* re-send carries newer truth. Letting a failed
          // retry stamp its error over a healthy record would turn a working
          // download into a phantom failure in the UI.
          if (send.ok) {
            await tx.grabJob.update({
              where: { id: existing.id },
              data: { message: send.message },
            });

            // The board renders DownloadHistory, not GrabJob — updating only
            // the job would leave the stale "0% · 2 peers" line on screen.
            const priorHistory = await tx.downloadHistory.findFirst({
              where: {
                userId,
                infoHash: hash,
                status: "sent",
                createdAt: { gte: cutoff },
              },
              orderBy: { createdAt: "desc" },
              select: { id: true },
            });
            if (priorHistory?.id) {
              await tx.downloadHistory.update({
                where: { id: priorHistory.id },
                data: {
                  ...historyFacts(),
                  message: buildHistoryMessage(),
                },
              });
            }
          }
          return;
        }
      }

      // ── Normal path: create new records ────────────────────────────────
      await tx.grabJob.create({
        data: {
          userId,
          title: candidate.title,
          query: search.query,
          status: send.ok ? "sent" : "failed",
          message: send.message,
          magnet: candidate.magnet,
          infoHash: hash,
          source: candidate.source,
          savePath: target.savePath,
          category: target.category,
          kind: grabJobKind,
          externalId,
          retention: purpose,
          createdAt: eventCreatedAt,
        },
      });

      await tx.downloadHistory.create({
        data: {
          userId,
          title: candidate.title,
          magnet: candidate.magnet,
          torrentUrl: candidate.torrentUrl,
          infoHash: hash,
          source: candidate.source,
          status: send.ok ? "sent" : "failed",
          retention: purpose,
          createdAt: eventCreatedAt,
          ...historyFacts(),
          message: buildHistoryMessage(),
        },
      });

      // Caller's state update runs inside the same transaction.
      if (send.ok) {
        await onSuccess?.(tx, candidate, target, send.message);
      } else {
        await onFailure?.(tx, candidate, target, send.message, offline);
      }
    });
  } catch (err) {
    // A concurrent request beat us to the create and the database refused the
    // duplicate. The whole transaction rolled back — including the caller's
    // cursor advance — so the winning request owns the grab and this one
    // reports the same outcome a losing read-guard check would have.
    if (!hash || !isInfoHashUniqueViolation(err)) throw err;
    alreadyActive = true;
    alreadyActiveMessage = send.message;
  }

  if (alreadyActive) {
    return {
      status: "already_active",
      message: alreadyActiveMessage || "Already downloading this release",
      candidate,
      target,
      offline: false,
    };
  }

  return {
    status: send.ok ? "sent" : "failed",
    message: send.message,
    candidate,
    target,
    offline,
  };
}
