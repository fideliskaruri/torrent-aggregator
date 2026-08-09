/**
 * Which file inside an already-held torrent IS a given episode.
 *
 * The expensive part of "play the next episode" is deciding it needs to be
 * fetched at all. When the episode the viewer is about to watch is already
 * sitting inside the season pack currently on screen, the honest answer is
 * "same torrent, this file" — no indexer search, no acquisition, no new swarm.
 *
 * Nothing here parses episodes on its own: it reuses {@link packEpisodeFiles},
 * which already knows how to ignore featurettes, samples and non-video junk,
 * and the persisted verified-file list every other disk-truth reader uses.
 *
 * Pure: no filesystem, no database.
 */
import path from "node:path";
import { heldFilesFromVerifiedJson } from "@/lib/library/deletion-plan";
import { packEpisodeFiles } from "@/lib/torrents/pack-episode-files";

/** The columns this needs off an `EngineTorrent` row. */
export type EpisodeFileRow = {
  savePath: string | null;
  verifiedFilesJson: string | null;
};

/**
 * The torrent-relative path of an absolute on-disk file.
 *
 * `verifiedFilesJson` records absolute paths; every playback surface (the
 * stream manifest, `/api/stream`, `/api/playback/plan`) addresses files by the
 * path *inside* the torrent. Returns null when the file is not contained by the
 * save root — never a guess, never an absolute path a route would reject.
 */
export function torrentRelativeFilePath(
  savePath: string | null | undefined,
  absolutePath: string,
): string | null {
  const root = savePath?.trim();
  if (!root || !path.isAbsolute(absolutePath)) return null;
  const relative = path.relative(path.resolve(root), path.resolve(absolutePath));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return relative.split(path.sep).join("/");
}

/**
 * The torrent-relative path of `season`×`episode` inside this torrent, or null.
 *
 * Null means "no deterministic answer here" — a torrent that is not a pack for
 * that season, an episode whose file has not been verified yet, or a file that
 * lives outside the recorded save root.
 */
export function episodeFileInTorrent(
  row: EpisodeFileRow,
  season: number | null | undefined,
  episode: number | null | undefined,
): string | null {
  if (typeof season !== "number" || typeof episode !== "number") return null;
  const files = heldFilesFromVerifiedJson(row.verifiedFilesJson).map((file) => ({
    path: file.path,
    size: file.sizeBytes,
  }));
  if (files.length === 0) return null;
  const absolute = packEpisodeFiles(files, season).get(episode);
  if (!absolute) return null;
  return torrentRelativeFilePath(row.savePath, absolute);
}
