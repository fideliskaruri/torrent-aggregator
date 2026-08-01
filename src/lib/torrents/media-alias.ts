import type { MediaMetadata } from "./types";
import { classifySpecialRelease } from "./episodes";

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function lexicalCatalogAgreement(
  releaseName: string,
  catalogTitle: string,
): boolean {
  const release = normalize(releaseName);
  const catalog = normalize(catalogTitle);
  if (!release || !catalog) return false;
  if (release === catalog) return true;
  if (!catalog.includes(release)) return false;
  const head = catalogTitle.split(/:\s*|\s+[-–—]\s+/)[0];
  return normalize(head) !== release;
}

/**
 * True only when provider evidence can bridge a release name to its canonical
 * title without collapsing films, OVAs, recaps or short same-word titles.
 */
export function mediaAliasAgrees(
  releaseName: string,
  metadata: MediaMetadata | null | undefined,
): boolean {
  const catalogTitle = metadata?.title?.trim();
  if (!metadata || !catalogTitle) return false;
  if (lexicalCatalogAgreement(releaseName, catalogTitle)) return true;

  const release = normalize(releaseName);
  if (
    (metadata.aliases ?? []).some((alias) => normalize(alias) === release)
  ) {
    return true;
  }

  const animeLike =
    metadata.mediaType === "anime" ||
    (metadata.originalLanguage?.toLowerCase() === "ja" &&
      metadata.genres?.some((genre) => genre.toLowerCase() === "animation"));
  if (
    !animeLike ||
    !metadata.externalId?.trim() ||
    metadata.externalId.trim() === "0" ||
    classifySpecialRelease(releaseName) ||
    release.split(" ").length < 4
  ) {
    return false;
  }

  const releaseTokens = new Set(distinctiveTokens(release));
  return distinctiveTokens(normalize(catalogTitle)).some((token) =>
    releaseTokens.has(token),
  );
}

const STOPWORDS = new Set([
  "the",
  "that",
  "this",
  "with",
  "from",
  "season",
  "series",
  "part",
]);

function distinctiveTokens(value: string): string[] {
  return value
    .split(" ")
    .filter((token) => token.length >= 5 && !STOPWORDS.has(token));
}
