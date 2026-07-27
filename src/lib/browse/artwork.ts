/**
 * Artwork for the *personal* rails — the user's own downloads and grabs.
 *
 * These rails used to resolve posters from `CachedMetadata` with a containment
 * match over the 200 most recent rows, a strategy whose own comment described
 * its miss rate as "high". Measured against a live catalog it was: `Ready to
 * Play` 5/9 and `Recently Added` 5/10, while every rail that used the metadata
 * resolver sat at 100%. That is the wrong way round. Missing artwork on a
 * stranger's chart entry is forgivable; missing artwork on the film the user
 * downloaded themselves is the thing that makes an app stop looking like a
 * product.
 *
 * So there is now one artwork path, `resolveArtworkBatch`, and this module is
 * the seam that maps a *release name* onto it. It reuses the catalog's bounded
 * wrapper rather than restating its guarantees: order-preserving, never
 * throws, and capped so a provider outage costs posters rather than a page.
 *
 * The lookup is keyed on the work identity derived from the release name, not
 * on the raw name — "Dune.Part.Two.2024.2160p.WEB-DL.x265-GROUP" is a
 * filename, and asking a metadata provider about a filename is how you get
 * nothing back.
 */
import { resolveArtworkBounded, type Artwork, type ArtworkQuery } from "@/lib/catalog/artwork";
import { workIdentity } from "@/lib/torrents/work-identity";
import { detectContentKind } from "@/lib/download/smart-category";
import { normalizeMediaType } from "@/lib/metadata/media-type";

export type { Artwork } from "@/lib/catalog/artwork";

const NO_ARTWORK: Artwork = Object.freeze({
  posterUrl: null,
  backdropUrl: null,
});

/**
 * A browse read is on the user's critical path, so it waits for less than a
 * background refresh does. Measured cost on this catalog: 72 titles in 1707ms
 * cold, ~0ms warm — the cache in `metadata/artwork.ts` means only the first
 * page load after a restart pays anything at all.
 */
export const RAIL_ARTWORK_BUDGET_MS = 8_000;

/**
 * Resolve poster/backdrop for a list of release names. Order-preserving,
 * never throws, always exactly `names.length` long.
 *
 * Names that share a work identity are looked up once and share the answer,
 * so a season pack's twelve files and a film's two prints cost one request.
 */
export async function resolveArtworkForReleases(
  names: readonly string[],
  budgetMs: number = RAIL_ARTWORK_BUDGET_MS,
): Promise<Artwork[]> {
  if (names.length === 0) return [];

  // One query per distinct work, and a per-name index back onto it.
  const queryIndex = new Map<string, number>();
  const queries: ArtworkQuery[] = [];
  const slotForName: number[] = [];

  for (const name of names) {
    const identity = workIdentity(name);
    const title = identity.name || name;
    const key = identity.key || title.toLowerCase();

    let slot = queryIndex.get(key);
    if (slot === undefined) {
      slot = queries.length;
      queryIndex.set(key, slot);
      queries.push({
        title,
        year: identity.year,
        // The provider's vocabulary is `movie | tv | anime | null`. A release
        // name is self-describing enough to classify, and `null` is passed
        // through honestly for anything that is not one of the three (a game,
        // an application) rather than guessed into a wrong lookup.
        mediaType: normalizeMediaType(detectContentKind({ title: name })),
      });
    }
    slotForName.push(slot);
  }

  const resolved = await resolveArtworkBounded(queries, budgetMs);

  return slotForName.map((slot) => ({
    posterUrl: resolved[slot]?.posterUrl ?? NO_ARTWORK.posterUrl,
    backdropUrl: resolved[slot]?.backdropUrl ?? NO_ARTWORK.backdropUrl,
  }));
}
