
const WORK_SEARCH_CATEGORIES = ["movies", "series", "anime"] as const;
type WorkSearchCategory = (typeof WORK_SEARCH_CATEGORIES)[number];
/**
 * A *request* scope. `all` fans out across every category and merges the hits;
 * the individual categories narrow. Kept distinct from {@link WorkSearchCategory}
 * because a hit always belongs to one real category — only the request can be
 * "all".
 */
export type WorkSearchScope = WorkSearchCategory | "all";
type WorkSearchProvider = "tmdb" | "anilist" | "itunes" | "tvmaze";
type WorkSearchMediaType = "movie" | "tv" | "anime";

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

function parseWorkSearchCategory(
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
