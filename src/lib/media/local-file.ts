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

/** Matches `isComplete` in builtin-engine.ts — one rule, stated twice, on purpose. */
export const COMPLETE_PROGRESS = 0.9999;

export type LocalFileResolution =
  | { ok: true; absolutePath: string; sizeBytes: number }
  | { ok: false; reason: string };

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

export async function resolveCompleteLocalFile(input: {
  config: ClientConnectionConfig;
  infoHash: string;
  filePath: string;
}): Promise<LocalFileResolution> {
  const { config, infoHash, filePath } = input;

  let lookup;
  try {
    lookup = await findBuiltinTorrentFile(config, infoHash, filePath);
  } catch (err) {
    return { ok: false, reason: `engine lookup failed: ${err instanceof Error ? err.message : err}` };
  }
  if (lookup.status !== "found") {
    return { ok: false, reason: `torrent lookup: ${lookup.status}` };
  }

  const progress = lookup.torrent.progress;
  if (!Number.isFinite(progress) || progress < COMPLETE_PROGRESS) {
    const pct = Number.isFinite(progress) ? (progress * 100).toFixed(1) : "unknown";
    return { ok: false, reason: `torrent is ${pct}% downloaded` };
  }

  const saveRoot = savePathFromHandle(lookup.torrent) ?? (await savePathFromDatabase(infoHash));
  if (!saveRoot) {
    return { ok: false, reason: "no download directory recorded for this torrent" };
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
        reason: `on-disk size ${stat.size} does not match the torrent's ${expected}`,
      };
    }
    return { ok: true, absolutePath: candidate, sizeBytes: stat.size };
  }

  return { ok: false, reason: `file not found under ${saveRoot}` };
}
