/**
 * Is this file already 100% on local disk, and where is it?
 *
 * Everything in the complete-file playback strategy hangs off this answer, so
 * it is deliberately conservative: it must never claim a file is complete when
 * it is not, because the strategies it unlocks assume the whole timeline exists
 * and would produce a playlist full of segments that cannot be made.
 *
 * ## Why not `torrent.done`
 *
 * WebTorrent latches per-file `done` and never re-evaluates it, so it sticks at
 * an optimistic high-water mark — the engine has been observed reporting `done`
 * for torrents sitting at 47–52%. `builtin-engine.ts` learned this the hard way
 * and its own `isComplete` uses `progress >= 0.9999`; this mirrors that rule
 * rather than inventing a second source of truth.
 *
 * ## Why the on-disk size is checked too
 *
 * WebTorrent's file store creates every file at full length up front (sparse),
 * so existence and length alone prove nothing. Progress proves the pieces
 * arrived; the size check proves the bytes are where we are about to point
 * ffmpeg. Both are required.
 */
import fs from "node:fs";
import path from "node:path";
import { findBuiltinTorrentFile, type BuiltinStreamTorrent } from "@/lib/clients/builtin-engine";
import type { ClientConnectionConfig } from "@/lib/clients/types";
import prisma from "@/lib/prisma";
import {
  diskFileLengthByPath,
  isCompletedProgress,
  isTorrentFileFullyVerifiedOnDisk,
  resolveCompletedPersistedDiskFile,
} from "@/lib/clients/disk-fastpath";
import { DOWNLOAD_COMPLETE_PROGRESS } from "@/lib/clients/builtin-engine-lifecycle";

/**
 * One completion threshold for the whole codebase, re-exported here for the
 * media layer's existing callers. Previously this was a second literal that
 * agreed with `builtin-engine.ts` by convention and disagreed with
 * `disk-fastpath.ts` (which used a strict `>= 1`) in fact.
 */
export const COMPLETE_PROGRESS = DOWNLOAD_COMPLETE_PROGRESS;

/**
 * Where playable bytes are coming from, independent of the streaming strategy.
 *
 * This distinction is NOT the same question as `strategy`. A `session` strategy
 * still reads from local disk whenever `resolveCompleteLocalFile` succeeds —
 * ffmpeg is handed `absolutePath` and never touches the swarm. A caller that
 * infers "session means swarm" is wrong, which is exactly why this is reported
 * explicitly rather than derived.
 */
export type PlaybackSource = "disk" | "swarm";

export type LocalFileResolution =
  | { ok: true; source: "disk"; absolutePath: string; sizeBytes: number }
  | { ok: false; source: "swarm"; reason: string };

/**
 * Read the download root off a live torrent handle.
 *
 * `BuiltinStreamTorrent` is a `Pick<>` that does not include `path`, but the
 * object behind it is the real WebTorrent torrent, which does. Narrowing
 * structurally keeps this honest — no cast, no `any`, and a missing property
 * degrades to the database lookup instead of producing a bogus path.
 */
function savePathFromHandle(torrent: BuiltinStreamTorrent): string | null {
  if (!("path" in torrent)) return null;
  const value: unknown = torrent.path;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function savePathFromDatabase(infoHash: string): Promise<string | null> {
  try {
    const row = await prisma.engineTorrent.findFirst({
      where: { hash: infoHash },
      select: { savePath: true },
      orderBy: { updatedAt: "desc" },
    });
    const value = row?.savePath?.trim();
    return value ? value : null;
  } catch {
    return null;
  }
}

/**
 * Candidate on-disk locations for a torrent file.
 *
 * WebTorrent stores multi-file torrents as `<root>/<torrentName>/<file.path>`
 * and `file.path` already carries the torrent-name prefix, so the join is the
 * normal case. The flattened basename is tried second because the engine
 * flattens a junk single-folder root once a download finishes.
 */
export function localPathCandidates(saveRoot: string, filePath: string): string[] {
  const normalized = filePath.replace(/\\/g, path.sep).replace(/\//g, path.sep);
  const candidates = [path.join(saveRoot, normalized)];
  const flattened = path.join(saveRoot, path.basename(normalized));
  if (flattened !== candidates[0]) candidates.push(flattened);
  return candidates;
}

/**
 * The persisted (no live torrent required) answer.
 *
 * Split out because it has to run twice: once *before* the engine lookup as a
 * fast path, and once *after* it as a fallback. A completed torrent is routinely
 * parked/evicted from the live client to free memory, so `findBuiltinTorrentFile`
 * answering "not-found" says nothing about whether the bytes are on disk — and
 * treating that as "not local" sent finished downloads back through the swarm.
 *
 * Exported because warm/speculative callers need exactly this and nothing more:
 * it touches only the database and `fs.stat`, so unlike
 * {@link resolveCompleteLocalFile} it can never wake WebTorrent.
 */
export async function resolvePersistedLocalFile(
  userId: string | null | undefined,
  infoHash: string,
  filePath: string,
): Promise<LocalFileResolution | null> {
  const scope = userId?.trim();
  if (!scope) return null;
  try {
    const row = await prisma.engineTorrent.findFirst({
      where: {
        userId: scope,
        hash: infoHash.toLowerCase(),
        progress: { gte: COMPLETE_PROGRESS },
      },
      select: {
        progress: true,
        savePath: true,
        verifiedBitfield: true,
        verifiedFilesJson: true,
      },
      orderBy: { updatedAt: "desc" },
    });
    if (!row?.verifiedBitfield?.trim()) return null;
    const persisted = resolveCompletedPersistedDiskFile(
      row.progress,
      row.savePath,
      row.verifiedFilesJson,
      filePath,
    );
    if (!persisted) return null;
    const length = await diskFileLengthByPath(
      persisted.path,
      persisted.length,
      persisted.mtimeMs,
      persisted.rootPath,
    );
    if (length == null) return null;
    return {
      ok: true,
      source: "disk",
      absolutePath: persisted.path,
      sizeBytes: length,
    };
  } catch {
    // A partial/live torrent can still be resolved through the engine.
    return null;
  }
}

export async function resolveCompleteLocalFile(input: {
  config: ClientConnectionConfig;
  infoHash: string;
  filePath: string;
}): Promise<LocalFileResolution> {
  const { config, infoHash, filePath } = input;

  const persisted = await resolvePersistedLocalFile(config.userId, infoHash, filePath);
  if (persisted) return persisted;

  let lookup;
  try {
    lookup = await findBuiltinTorrentFile(config, infoHash, filePath);
  } catch (err) {
    return {
      ok: false,
      source: "swarm",
      reason: `engine lookup failed: ${err instanceof Error ? err.message : err}`,
    };
  }
  if (lookup.status !== "found") {
    return {
      ok: false,
      source: "swarm",
      reason: `torrent lookup: ${lookup.status}`,
    };
  }

  const progress = lookup.torrent.progress;
  const wholeTorrentComplete = isCompletedProgress(progress);
  // A season pack can sit well under 100% while the one requested episode
  // already has every one of its own pieces verified — `verifiedBitfield`/
  // `verifiedFilesJson` only prove that at whole-torrent completion, so they
  // cannot answer this. The live bitfield can: it is per-piece truth from the
  // engine, not an aggregate percentage, so a fully-downloaded file inside a
  // still-partial pack is correctly treated as complete without waiting for
  // (or misrepresenting) the rest of the pack.
  if (!wholeTorrentComplete && !isTorrentFileFullyVerifiedOnDisk(lookup.torrent, lookup.file)) {
    const pct = Number.isFinite(progress) ? (progress * 100).toFixed(1) : "unknown";
    return {
      ok: false,
      source: "swarm",
      reason: `torrent is ${pct}% downloaded and this file is not fully verified yet`,
    };
  }

  const saveRoot = savePathFromHandle(lookup.torrent) ?? (await savePathFromDatabase(infoHash));
  if (!saveRoot) {
    return {
      ok: false,
      source: "swarm",
      reason: "no download directory recorded for this torrent",
    };
  }

  const expected = lookup.file.length;
  for (const candidate of localPathCandidates(saveRoot, filePath)) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(candidate);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (expected > 0 && stat.size !== expected) {
      return {
        ok: false,
        source: "swarm",
        reason: `on-disk size ${stat.size} does not match the torrent's ${expected}`,
      };
    }
    return { ok: true, source: "disk", absolutePath: candidate, sizeBytes: stat.size };
  }

  return { ok: false, source: "swarm", reason: `file not found under ${saveRoot}` };
}
