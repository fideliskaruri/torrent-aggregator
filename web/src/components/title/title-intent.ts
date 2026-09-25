import {
  normalizeMediaType,
  type MediaType,
} from "@/lib/metadata/media-type";
import { normalizeTitle } from "@/lib/utils";
import { workKeyMatches } from "./work-key";

export interface TitleIdentityCandidate {
  title?: string | null;
  year?: number | null;
  mediaType?: string | null;
  aliases?: string[] | null;
}

export interface ResolvedTitleIntent {
  title: string | null;
  year: number | null;
  mediaType: MediaType | null;
  /** False means the catalog row contradicted the selected identity. */
  catalogAccepted: boolean;
}

/**
 * Resolve the identity carried by a title link without letting a stale catalog
 * row overwrite it. A selection is accepted only when its title/year can
 * legitimately produce the opaque work key.
 */
export function resolveTitleIntent(input: {
  workKey: string;
  selection?: TitleIdentityCandidate | null;
  catalog?: TitleIdentityCandidate | null;
  watch?: TitleIdentityCandidate | null;
  release?: TitleIdentityCandidate | null;
}): ResolvedTitleIntent {
  const selected =
    validCandidate(input.selection) &&
    workKeyMatches(
      input.workKey,
      input.selection?.title?.trim() ?? "",
      input.selection?.year ?? null,
    )
      ? input.selection ?? null
      : null;
  const watch = validCandidate(input.watch) ? input.watch ?? null : null;
  const release = validCandidate(input.release) ? input.release ?? null : null;
  const catalog = validCandidate(input.catalog) ? input.catalog ?? null : null;
  const anchor = selected ?? watch ?? release ?? catalog;
  const catalogAccepted =
    catalog == null || anchor == null || identitiesAgree(anchor, catalog);
  const acceptedCatalog = catalogAccepted ? catalog : null;

  return {
    title: firstTitle(selected, watch, release, acceptedCatalog),
    year: firstYear(selected, acceptedCatalog, release, watch),
    mediaType: firstMediaType(selected, watch, release, acceptedCatalog),
    catalogAccepted,
  };
}

/** Exact canonical/alias agreement plus non-conflicting year and media type. */
export function identitiesAgree(
  left: TitleIdentityCandidate,
  right: TitleIdentityCandidate,
): boolean {
  const leftNames = candidateNames(left);
  const rightNames = candidateNames(right);
  if (!leftNames.some((name) => rightNames.includes(name))) return false;

  const leftYear = finiteYear(left.year);
  const rightYear = finiteYear(right.year);
  if (leftYear != null && rightYear != null && leftYear !== rightYear) {
    return false;
  }

  const leftType = normalizeMediaType(left.mediaType);
  const rightType = normalizeMediaType(right.mediaType);
  return !(leftType && rightType && leftType !== rightType);
}

function validCandidate(
  candidate: TitleIdentityCandidate | null | undefined,
): candidate is TitleIdentityCandidate {
  return Boolean(candidate?.title?.trim());
}

function candidateNames(candidate: TitleIdentityCandidate): string[] {
  return [...new Set(
    [candidate.title, ...(candidate.aliases ?? [])]
      .map((name) => normalizeTitle(name ?? ""))
      .filter(Boolean),
  )];
}

function firstTitle(
  ...candidates: (TitleIdentityCandidate | null)[]
): string | null {
  for (const candidate of candidates) {
    const title = candidate?.title?.trim();
    if (title) return title;
  }
  return null;
}

function firstYear(
  ...candidates: (TitleIdentityCandidate | null)[]
): number | null {
  for (const candidate of candidates) {
    const year = finiteYear(candidate?.year);
    if (year != null) return year;
  }
  return null;
}

function finiteYear(value: number | null | undefined): number | null {
  return Number.isFinite(value) ? (value as number) : null;
}

function firstMediaType(
  ...candidates: (TitleIdentityCandidate | null)[]
): MediaType | null {
  for (const candidate of candidates) {
    const mediaType = normalizeMediaType(candidate?.mediaType);
    if (mediaType) return mediaType;
  }
  return null;
}
