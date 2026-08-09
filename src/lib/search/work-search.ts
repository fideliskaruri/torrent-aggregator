import { titlePath, workKeyFor } from "@/components/title/work-key";
import type { MediaMetadata } from "@/lib/torrents/types";

export const WORK_SEARCH_CATEGORIES = ["movies", "series", "anime"] as const;
export type WorkSearchCategory = (typeof WORK_SEARCH_CATEGORIES)[number];
/**
 * A *request* scope. `all` fans out across every category and merges the hits;
 * the individual categories narrow. Kept distinct from {@link WorkSearchCategory}
 * because a hit always belongs to one real category — only the request can be
 * "all".
 */
export type WorkSearchScope = WorkSearchCategory | "all";
export type WorkSearchProvider = "tmdb" | "anilist";
export type WorkSearchMediaType = "movie" | "tv" | "anime";

export interface WorkSearchHit {
  workKey: string;
  title: string;
  year: number | null;
  category: WorkSearchCategory;
  provider: WorkSearchProvider;
  providerId: string | null;
  aliases: string[];
  /** Provider-native identity. AniList films remain anime here. */
  mediaType: WorkSearchMediaType;
  /** Shape consumed by the title route: AniList MOVIE is a non-episodic movie. */
  titleMediaType: WorkSearchMediaType;
  isSeries: boolean;
  format: string | null;
  posterUrl: string | null;
  overview: string | null;
  releaseDate: string | null;
  href: string;
}

export function parseWorkSearchCategory(
  value: unknown,
  fallback: WorkSearchCategory = "movies",
): WorkSearchCategory {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  return (WORK_SEARCH_CATEGORIES as readonly string[]).includes(normalized)
    ? (normalized as WorkSearchCategory)
    : fallback;
}

/** Like {@link parseWorkSearchCategory} but also accepts the `all` fan-out scope. */
export function parseWorkSearchScope(
  value: unknown,
  fallback: WorkSearchScope = "all",
): WorkSearchScope {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "all") return "all";
  return (WORK_SEARCH_CATEGORIES as readonly string[]).includes(normalized)
    ? (normalized as WorkSearchCategory)
    : fallback;
}

export function legacyEverythingRedirectUrl(
  scope: unknown,
  query: unknown,
): string {
  const normalizedScope =
    typeof scope === "string" ? scope.trim().toLowerCase() : "";
  const q = typeof query === "string" ? query.trim() : "";
  const params = new URLSearchParams();
  if (normalizedScope === "anime") params.set("category", "anime");
  if (q) params.set("q", q);
  const search = params.toString();
  return search ? `/search?${search}` : "/search";
}

export function workSearchHitFromMetadata(
  metadata: MediaMetadata,
  category: WorkSearchCategory,
  format: string | null = null,
): WorkSearchHit | null {
  const title = metadata.title?.trim();
  if (!title) return null;

  const provider: WorkSearchProvider = metadata.source;
  const mediaType: WorkSearchMediaType =
    category === "movies" ? "movie" : category === "series" ? "tv" : "anime";
  const normalizedFormat = format?.trim().toUpperCase() || null;
  const isSeries =
    category === "series" ||
    (category === "anime" && normalizedFormat !== "MOVIE");
  const titleMediaType: WorkSearchMediaType =
    category === "anime" && !isSeries ? "movie" : mediaType;
  const year = metadata.year ?? null;
  const workKey = workKeyFor(title, isSeries ? null : year);
  if (!workKey) return null;
  const providerId = metadata.externalId?.trim() || null;
  const aliases = [...new Set(
    (metadata.aliases ?? []).map((alias) => alias.trim()).filter(Boolean),
  )];

  return {
    workKey,
    title,
    year,
    category,
    provider,
    providerId,
    aliases,
    mediaType,
    titleMediaType,
    isSeries,
    format: normalizedFormat,
    posterUrl: metadata.posterUrl ?? null,
    overview: metadata.synopsis ?? null,
    releaseDate: metadata.releaseDate ?? null,
    href: workSearchTitleHref({
      workKey,
      title,
      year,
      provider,
      providerId,
      aliases,
      sourceMediaType: mediaType,
      titleMediaType,
      format: normalizedFormat,
      isSeries,
    }),
  };
}

function workSearchTitleHref(input: {
  workKey: string;
  title: string;
  year: number | null;
  provider: WorkSearchProvider;
  providerId: string | null;
  aliases: string[];
  sourceMediaType: WorkSearchMediaType;
  titleMediaType: WorkSearchMediaType;
  format: string | null;
  isSeries: boolean;
}): string {
  const base = titlePath(input.workKey, {
    title: input.title,
    year: input.year,
    mediaType: input.titleMediaType,
  });
  const params = new URLSearchParams();
  params.set("provider", input.provider);
  if (input.providerId) params.set("providerId", input.providerId);
  params.set("sourceType", input.sourceMediaType);
  if (input.format) params.set("format", input.format);
  params.set("series", input.isSeries ? "1" : "0");
  for (const alias of input.aliases) params.append("alias", alias);
  return `${base}&${params.toString()}`;
}
