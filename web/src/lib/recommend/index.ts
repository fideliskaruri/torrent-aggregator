/**
 * "Because you're watching X" — one rail, from the catalogs' own
 * recommendations.
 *
 * There is deliberately no recommender here. TMDB's `/recommendations` is
 * behavioural (people who watched this watched that) and is already better than
 * anything that could be built over a five-row library. Its neighbour
 * `/similar` is a genre-vector match and is not usable: it returns 320,032
 * films "similar" to Oppenheimer, led by titles nobody has heard of. AniList
 * exposes a community-voted equivalent.
 *
 * One seed, one rail. A blended rank across several seeds is degenerate at this
 * library size — every candidate would have exactly one vote — and per-seed
 * provenance is the only thing that makes a suggestion explicable.
 */
import type { MediaMetadata } from "@/lib/torrents/types";

type Recommendation = {
  provider: "anilist" | "tmdb";
  sourceMediaType: "anime" | "movie" | "tv";
  /** Provider/library family. AniList movies remain anime identities. */
  mediaType: MediaMetadata["mediaType"];
  /** Shape consumed by the title route. */
  titleMediaType: MediaMetadata["mediaType"];
  externalId: string;
  title: string;
  posterUrl: string | null;
  year: number | null;
  rating: number | null;
  format: string | null;
  isSeries: boolean;
};

export type RecommendationRail = {
  /** The library title this rail is explained by. */
  seedTitle: string;
  items: Recommendation[];
};
