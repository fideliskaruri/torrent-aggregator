import { NextResponse } from "next/server";
import { resolveArtworkBatch } from "@/lib/metadata/artwork";
import { artworkKey } from "@/lib/metadata/release-art";

/**
 * Batch artwork lookup for the pages that hold release names.
 *
 * Client, Activity, Download log and Search all render lists whose rows are
 * release names with no poster attached. They are client components, so they
 * cannot call `resolveArtwork` directly; this is the seam.
 *
 * Deliberately a POST of a *batch*: the alternative — one request per row —
 * is the thing this endpoint exists to prevent. The Client page polls every
 * five seconds, so a per-row design would put a request per torrent per poll
 * on the wire forever. `resolveArtworkBatch` is bounded, cached (positive and
 * negative) and de-duplicates in flight, so the second poll onwards costs
 * nothing upstream.
 *
 * Never fails the caller: artwork is decoration, and a page that renders
 * letter tiles is a working page. Errors come back as nulls, not as a status
 * the caller has to branch on.
 */

/** Enough for the longest list any surface renders in one pass, and no more. */
const MAX_ITEMS = 60;

interface RequestItem {
  title?: unknown;
  year?: unknown;
  mediaType?: unknown;
}

function asMediaType(value: unknown): "movie" | "tv" | "anime" | null {
  return value === "movie" || value === "tv" || value === "anime" ? value : null;
}

function asYear(value: unknown): number | null {
  const year = typeof value === "number" ? value : Number(value);
  return Number.isInteger(year) && year > 1800 && year < 2200 ? year : null;
}

export async function POST(request: Request) {
  let items: RequestItem[] = [];
  try {
    const body = (await request.json()) as { items?: unknown };
    if (Array.isArray(body?.items)) items = body.items as RequestItem[];
  } catch {
    // A malformed body is an empty answer, not a 400 — see above.
    return NextResponse.json({ artwork: {} });
  }

  const queries = items
    .map((item) => ({
      title: typeof item?.title === "string" ? item.title.trim() : "",
      year: asYear(item?.year),
      mediaType: asMediaType(item?.mediaType),
    }))
    .filter((query) => query.title.length > 0)
    .slice(0, MAX_ITEMS);

  if (!queries.length) return NextResponse.json({ artwork: {} });

  const resolved = await resolveArtworkBatch(queries);

  const artwork: Record<
    string,
    { posterUrl: string | null; backdropUrl: string | null }
  > = {};
  queries.forEach((query, index) => {
    const art = resolved[index] ?? { posterUrl: null, backdropUrl: null };
    // Keyed the same way the callers key their rows, so a client can look the
    // answer up without knowing the request order.
    artwork[artworkKey(query.title, query.year)] = art;
  });

  return NextResponse.json({ artwork });
}
