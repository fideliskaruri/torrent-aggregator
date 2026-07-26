/**
 * The user's target resolution, resolved once for every search.
 *
 * This is read *inside* `searchTorrents` rather than threaded through every
 * caller on purpose. The same argument applies as for `rankResults` itself:
 * all four grab sites (library hunt, auto-rules, watchlist check, on-demand)
 * plus the search API already funnel through `searchTorrents`, so resolving it
 * there means the setting takes effect everywhere at once and cannot be
 * "wired into half the places" — which is exactly how the original quality bug
 * managed to be invisible in the UI while automation misbehaved.
 *
 * This is a single-user, single-process app (it binds to 127.0.0.1 and has no
 * auth by design), so a module-level memo is safe. The short TTL is belt and
 * braces for dev HMR and for anything that writes settings without calling the
 * invalidator.
 */
import prisma from "@/lib/prisma";
import { DEFAULT_TARGET_RESOLUTION } from "@/lib/torrents/quality";

/** Values the UI offers. Anything else in the DB is ignored as corrupt. */
export const SELECTABLE_RESOLUTIONS = [480, 720, 1080, 2160] as const;

const TTL_MS = 30_000;

let cached: { value: number; at: number } | null = null;

export function invalidateTargetResolution() {
  cached = null;
}

export async function getTargetResolution(): Promise<number> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;

  let value = DEFAULT_TARGET_RESOLUTION;
  try {
    const row = await prisma.clientSettings.findFirst({
      select: { preferredResolution: true },
    });
    const stored = row?.preferredResolution;
    if (
      stored != null &&
      (SELECTABLE_RESOLUTIONS as readonly number[]).includes(stored)
    ) {
      value = stored;
    }
  } catch {
    // Ranking must never be the thing that takes search down. A settings read
    // failing is not a reason to return zero results, so fall back to the
    // default and carry on.
    value = DEFAULT_TARGET_RESOLUTION;
  }

  cached = { value, at: Date.now() };
  return value;
}
