/**
 * Containment checks for filesystem paths supplied over HTTP.
 *
 * `open-folder` spawns the OS file manager on a path from the request body.
 * Without a containment check any caller that can reach the app can open any
 * directory on the host — TorrentFlow has no sign-in, so "any caller" means
 * anything that can reach the port. Restricting reveals to the configured
 * library roots keeps the feature (open where my download went) while removing
 * the arbitrary-path reach.
 */
import path from "node:path";

/** Collects the directories a user has actually configured as library roots. */
export function libraryRoots(config: {
  baseDownloadPath?: string | null;
  savePath?: string | null;
  pathRules?: Record<string, string> | null;
}): string[] {
  const raw = [
    config.baseDownloadPath,
    config.savePath,
    ...Object.values(config.pathRules ?? {}),
  ];

  const roots: string[] = [];
  for (const entry of raw) {
    const trimmed = entry?.trim();
    if (!trimmed) continue;
    const resolved = path.resolve(trimmed);
    if (!roots.includes(resolved)) roots.push(resolved);
  }
  return roots;
}

/**
 * True when `target` is one of `roots` or sits underneath one.
 *
 * Uses path.relative rather than string prefixing so that `/downloads-secret`
 * is not treated as living inside `/downloads`, and so `..` segments cannot
 * escape. Comparison is case-insensitive on Windows only.
 */
export function isInsideRoot(target: string, root: string): boolean {
  const insensitive = process.platform === "win32";
  const a = path.resolve(root);
  const b = path.resolve(target);
  const rel = path.relative(
    insensitive ? a.toLowerCase() : a,
    insensitive ? b.toLowerCase() : b,
  );
  if (rel === "") return true;
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function isWithinLibrary(target: string, roots: string[]): boolean {
  return roots.some((root) => isInsideRoot(target, root));
}
