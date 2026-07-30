import { factsLine } from "@/lib/utils";
import { isSeriesMediaType, normalizeMediaType } from "@/lib/metadata/media-type";

export interface TitleFactsInput {
  year: number | null;
  mediaType: string | null;
  rating: number | null;
  isSeries: boolean;
  seasonCount: number | null;
}

export function titleFacts(input: TitleFactsInput): string {
  return factsLine([
    input.year ? String(input.year) : null,
    mediaTypeLabel(input.mediaType),
    // TMDB reports 0 for a title with no votes yet (e.g. unreleased). A 0.0
    // star reads as a terrible score rather than "not rated", so treat it as
    // absent — the release date already communicates "not out yet".
    input.rating != null && input.rating > 0
      ? `★ ${input.rating.toFixed(1)}`
      : null,
    input.isSeries && input.seasonCount != null && input.seasonCount > 0
      ? `${input.seasonCount} season${input.seasonCount === 1 ? "" : "s"}`
      : null,
  ]);
}

/** Human label for a media type, derived — never compared inline. */
function mediaTypeLabel(raw: string | null): string | null {
  const mediaType = normalizeMediaType(raw);
  if (!mediaType) return null;
  if (mediaType === "movie") return "Film";
  return isSeriesMediaType(mediaType) && mediaType === "anime"
    ? "Anime"
    : "Series";
}
