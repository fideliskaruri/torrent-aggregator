/**
 * Catalog identity: the difference between a fact and a guess.
 *
 * `detectContentKind` accepts two things that look alike and are not:
 *
 *   - `searchCategory` — a *hint*. "The user had Anime selected in a
 *     dropdown." Weak on purpose: someone browsing the anime tab can still
 *     grab a western show, so structural signals in the title outrank it.
 *   - `metadata` — a *fact*. "AniList #151807 is this show." AniList only
 *     catalogues anime, so membership settles the question outright, and
 *     `detectContentKind` already lets it beat every heuristic.
 *
 * A watchlist item is the second kind. `mediaType` and `externalId` are the
 * catalog's own verdict, recorded when the user added the show — not
 * something we inferred from a release name. But the send paths were passing
 * `categoryForMediaType(item.mediaType)`, which converts that fact into the
 * weaker hint and loses the distinction: an anime with ordinary `S02E05`
 * numbering came out as TV, because the numbering outranks a hint.
 *
 * This module converts a stored item back into the fact it came from, so the
 * heuristics are never consulted for a show we can already name.
 *
 * `source` is derived rather than stored, and the mapping is exact rather
 * than a guess: the watchlist writes AniList ids under `mediaType: "anime"`
 * and TMDB ids under `movie`/`tv` (see `/api/watchlist`), which is the same
 * split `resolveMetadata` uses when it populates them.
 */
import type { MediaMetadata } from "@/lib/torrents/types";

/** The subset of a watchlist row that carries catalog identity. */
export type CatalogIdentity = {
  mediaType: string;
  externalId?: string | null;
  title: string;
  posterUrl?: string | null;
  synopsis?: string | null;
  rating?: number | null;
};

/** Which catalog an id belongs to. Anime is AniList; everything else TMDB. */
export function catalogSourceFor(mediaType: string): "anilist" | "tmdb" {
  return mediaType === "anime" ? "anilist" : "tmdb";
}

function isKnownMediaType(t: string): t is MediaMetadata["mediaType"] {
  return t === "anime" || t === "movie" || t === "tv";
}

/**
 * Rebuilds the catalog record a watchlist item was created from.
 *
 * Returns null for anything we cannot vouch for, because a half-made
 * `MediaMetadata` is worse than none: `detectContentKind` treats what it gets
 * as authoritative, so guessing here would launder a guess into a fact — the
 * exact failure this module exists to undo.
 *
 * The title is deliberately the *catalog* title, not the release name. It
 * also feeds `resolveSmartPath`, so passing it fixes the show folder as well
 * as the category — episodes land under `Solo Leveling/` rather than whatever
 * the release name happened to parse to.
 */
export function catalogMetadata(
  item: CatalogIdentity | null | undefined,
): MediaMetadata | null {
  if (!item) return null;

  const mediaType = (item.mediaType || "").trim().toLowerCase();
  if (!isKnownMediaType(mediaType)) return null;

  const title = (item.title || "").trim();
  if (!title) return null;

  return {
    source: catalogSourceFor(mediaType),
    mediaType,
    externalId: (item.externalId || "").trim(),
    title,
    posterUrl: item.posterUrl ?? null,
    synopsis: item.synopsis ?? null,
    rating: item.rating ?? null,
  };
}
