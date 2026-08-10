import {
  getAniListWorkById,
  type AniListFormat,
  type AniListWork,
} from "@/lib/metadata/anilist";
import { getTmdbById } from "@/lib/metadata/tmdb";
import { normalizeMediaType } from "@/lib/metadata/media-type";
import { identitiesAgree } from "@/components/title/title-intent";
import { workKeyMatches } from "@/components/title/work-key";
import type { MediaMetadata } from "@/lib/torrents/types";

const ANILIST_FORMATS = new Set<AniListFormat>([
  "TV",
  "TV_SHORT",
  "MOVIE",
  "SPECIAL",
  "OVA",
  "ONA",
  "MUSIC",
]);

export type TitleIdentityProvider = "anilist" | "tmdb";
export type TitleIdentityMediaType = "anime" | "movie" | "tv";

export interface TitleProviderIdentity {
  provider: TitleIdentityProvider;
  externalId: string;
  mediaType: TitleIdentityMediaType;
  /** AniList-only shape hint; always null for TMDB. */
  format: AniListFormat | null;
  isSeries: boolean;
  /**
   * Episodes the provider itself reports for this work, or null when it
   * reports none. Only ever set from a *verified* provider lookup — a carried
   * (client-supplied) identity never asserts a count, because a count the
   * client can name is a count the client can invent.
   */
  episodeCount: number | null;
  metadata: MediaMetadata;
  verified: boolean;
}

export interface VerifiedTitleProviderIdentity extends TitleProviderIdentity {
  verified: true;
}

export interface CarriedTitleProviderIdentity extends TitleProviderIdentity {
  verified: false;
}

export type TitleProviderIdentityResult =
  | { kind: "absent" }
  | { kind: "invalid"; reason: string }
  | {
      kind: "carried";
      reason: string;
      identity: CarriedTitleProviderIdentity;
    }
  | { kind: "verified"; identity: VerifiedTitleProviderIdentity };

type AniListLookup = (id: string) => Promise<AniListWork | null>;
type TmdbLookup = (
  mediaType: "movie" | "tv",
  id: string,
) => Promise<MediaMetadata | null>;

/**
 * Verify the identity a title link carries, for any supported provider.
 *
 * Search links carry a provider-native id (`provider`, `providerId`,
 * `sourceType`) so the title page can key off a verified work rather than
 * re-guessing one from a slug. This dispatches on `provider` and applies the
 * *same* agreement contract to every provider — `identitiesAgree` plus
 * `workKeyMatches` — so a hand-typed `?providerId=` can never repoint a work
 * key at an unrelated title. Adding a provider means adding a branch here and
 * nothing downstream: `buildTitleDetail` consumes the result provider-agnostically.
 *
 * The lookups are injected so the route tests can drive them without the
 * network; production defaults reach the real clients.
 */
export async function resolveTitleProviderIdentity(
  params: URLSearchParams,
  workKey: string,
  lookup: AniListLookup = getAniListWorkById,
  tmdbLookup: TmdbLookup = getTmdbById,
): Promise<TitleProviderIdentityResult> {
  const provider = params.get("provider")?.trim().toLowerCase();
  if (!provider) return { kind: "absent" };
  if (provider === "anilist") {
    return resolveAniListIdentity(params, workKey, lookup);
  }
  if (provider === "tmdb") {
    return resolveTmdbIdentity(params, workKey, tmdbLookup);
  }
  return { kind: "invalid", reason: "Unsupported title provider" };
}

// ---------------------------------------------------------------------------
// AniList
// ---------------------------------------------------------------------------

async function resolveAniListIdentity(
  params: URLSearchParams,
  workKey: string,
  lookup: AniListLookup,
): Promise<TitleProviderIdentityResult> {
  const externalId = params.get("providerId")?.trim() ?? "";
  if (!/^[1-9]\d{0,11}$/.test(externalId)) {
    return { kind: "invalid", reason: "Invalid AniList identity" };
  }
  if (params.get("sourceType")?.trim().toLowerCase() !== "anime") {
    return { kind: "invalid", reason: "AniList identity must be anime" };
  }

  const carried = carriedAniListIdentity(params, workKey, externalId);
  if ("reason" in carried) return { kind: "invalid", reason: carried.reason };

  let work: AniListWork | null;
  try {
    work = await lookup(externalId);
  } catch {
    return {
      kind: "carried",
      reason: "AniList identity lookup failed",
      identity: carried,
    };
  }
  if (!work) {
    return {
      kind: "carried",
      reason: "AniList identity was not found",
      identity: carried,
    };
  }
  if (
    work.metadata.source !== "anilist" ||
    work.metadata.externalId.trim() !== externalId
  ) {
    return { kind: "invalid", reason: "AniList identity did not match" };
  }

  if (carried.format !== work.format) {
    return { kind: "invalid", reason: "AniList format did not match" };
  }

  const expectedRouteType = work.isSeries ? "anime" : "movie";
  if (params.get("type")?.trim().toLowerCase() !== expectedRouteType) {
    return { kind: "invalid", reason: "Title route shape did not match AniList" };
  }
  if (params.get("series") !== (work.isSeries ? "1" : "0")) {
    return { kind: "invalid", reason: "Series shape did not match AniList" };
  }

  const selectedTitle = params.get("t")?.trim() ?? "";
  const selectedYear = intParam(params.get("y"));
  if (
    !selectedTitle ||
    !identitiesAgree(
      { title: selectedTitle, year: selectedYear, mediaType: "anime" },
      {
        title: work.metadata.title,
        aliases: work.metadata.aliases,
        year: work.metadata.year,
        mediaType: "anime",
      },
    )
  ) {
    return { kind: "invalid", reason: "Title did not match AniList identity" };
  }

  const identityYear = work.isSeries ? null : (work.metadata.year ?? selectedYear);
  const names = [work.metadata.title, ...(work.metadata.aliases ?? [])];
  if (!names.some((name) => workKeyMatches(workKey, name, identityYear))) {
    return { kind: "invalid", reason: "Work key did not match AniList identity" };
  }

  return {
    kind: "verified",
    identity: {
      provider: "anilist",
      externalId,
      mediaType: "anime",
      format: work.format,
      isSeries: work.isSeries,
      episodeCount: work.episodeCount,
      metadata: work.metadata,
      verified: true,
    },
  };
}

function carriedAniListIdentity(
  params: URLSearchParams,
  workKey: string,
  externalId: string,
): CarriedTitleProviderIdentity | { reason: string } {
  const formatRaw = params.get("format")?.trim().toUpperCase() ?? "";
  if (!ANILIST_FORMATS.has(formatRaw as AniListFormat)) {
    return { reason: "Invalid AniList format" };
  }
  const format = formatRaw as AniListFormat;
  const isSeries = format !== "MOVIE";
  if (params.get("series") !== (isSeries ? "1" : "0")) {
    return { reason: "Series shape did not match AniList format" };
  }
  const expectedRouteType = isSeries ? "anime" : "movie";
  if (params.get("type")?.trim().toLowerCase() !== expectedRouteType) {
    return { reason: "Title route shape did not match AniList format" };
  }

  const title = params.get("t")?.trim() ?? "";
  if (!title || title.length > 200) {
    return { reason: "Invalid AniList title" };
  }
  const rawYear = params.get("y");
  const year = intParam(rawYear);
  if (rawYear && (year == null || year < 1800 || year > 2200)) {
    return { reason: "Invalid AniList year" };
  }
  if (!workKeyMatches(workKey, title, isSeries ? null : year)) {
    return { reason: "Work key did not match carried AniList identity" };
  }

  const aliases = cleanAliases(params);
  if (aliases == null) return { reason: "Invalid AniList aliases" };

  return {
    provider: "anilist",
    externalId,
    mediaType: "anime",
    format,
    isSeries,
    episodeCount: null,
    metadata: {
      source: "anilist",
      mediaType: "anime",
      externalId,
      title,
      aliases,
      year,
    },
    verified: false,
  };
}

// ---------------------------------------------------------------------------
// TMDB
// ---------------------------------------------------------------------------

async function resolveTmdbIdentity(
  params: URLSearchParams,
  workKey: string,
  lookup: TmdbLookup,
): Promise<TitleProviderIdentityResult> {
  const externalId = params.get("providerId")?.trim() ?? "";
  if (!/^[1-9]\d{0,11}$/.test(externalId)) {
    return { kind: "invalid", reason: "Invalid TMDB identity" };
  }
  const sourceType = params.get("sourceType")?.trim().toLowerCase();
  if (sourceType !== "movie" && sourceType !== "tv") {
    return { kind: "invalid", reason: "TMDB identity must be a movie or series" };
  }
  const mediaType: "movie" | "tv" = sourceType;
  const isSeries = mediaType === "tv";

  const carried = carriedTmdbIdentity(params, workKey, externalId, mediaType);
  if ("reason" in carried) return { kind: "invalid", reason: carried.reason };

  let work: MediaMetadata | null;
  try {
    work = await lookup(mediaType, externalId);
  } catch {
    return {
      kind: "carried",
      reason: "TMDB identity lookup failed",
      identity: carried,
    };
  }
  if (!work) {
    return {
      kind: "carried",
      reason: "TMDB identity was not found",
      identity: carried,
    };
  }
  if (work.source !== "tmdb" || work.externalId.trim() !== externalId) {
    return { kind: "invalid", reason: "TMDB identity did not match" };
  }
  if (normalizeMediaType(work.mediaType) !== mediaType) {
    return { kind: "invalid", reason: "TMDB media type did not match" };
  }

  const selectedTitle = params.get("t")?.trim() ?? "";
  const selectedYear = intParam(params.get("y"));
  if (
    !selectedTitle ||
    !identitiesAgree(
      { title: selectedTitle, year: selectedYear, mediaType },
      {
        title: work.title,
        aliases: work.aliases,
        year: work.year,
        mediaType,
      },
    )
  ) {
    return { kind: "invalid", reason: "Title did not match TMDB identity" };
  }

  const identityYear = isSeries ? null : (work.year ?? selectedYear);
  const names = [work.title, ...(work.aliases ?? [])];
  if (!names.some((name) => workKeyMatches(workKey, name, identityYear))) {
    return { kind: "invalid", reason: "Work key did not match TMDB identity" };
  }

  return {
    kind: "verified",
    identity: {
      provider: "tmdb",
      externalId,
      mediaType,
      format: null,
      isSeries,
      episodeCount: null,
      metadata: work,
      verified: true,
    },
  };
}

function carriedTmdbIdentity(
  params: URLSearchParams,
  workKey: string,
  externalId: string,
  mediaType: "movie" | "tv",
): CarriedTitleProviderIdentity | { reason: string } {
  const isSeries = mediaType === "tv";
  if (params.get("series") !== (isSeries ? "1" : "0")) {
    return { reason: "Series shape did not match TMDB source" };
  }
  if (normalizeMediaType(params.get("type")) !== mediaType) {
    return { reason: "Title route shape did not match TMDB source" };
  }

  const title = params.get("t")?.trim() ?? "";
  if (!title || title.length > 200) {
    return { reason: "Invalid TMDB title" };
  }
  const rawYear = params.get("y");
  const year = intParam(rawYear);
  if (rawYear && (year == null || year < 1800 || year > 2200)) {
    return { reason: "Invalid TMDB year" };
  }
  if (!workKeyMatches(workKey, title, isSeries ? null : year)) {
    return { reason: "Work key did not match carried TMDB identity" };
  }

  const aliases = cleanAliases(params);
  if (aliases == null) return { reason: "Invalid TMDB aliases" };

  return {
    provider: "tmdb",
    externalId,
    mediaType,
    format: null,
    isSeries,
    episodeCount: null,
    metadata: {
      source: "tmdb",
      mediaType,
      externalId,
      title,
      aliases,
      year,
    },
    verified: false,
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Trimmed, de-duped, bounded alias list — or null when a bound is exceeded. */
function cleanAliases(params: URLSearchParams): string[] | null {
  const aliases = params
    .getAll("alias")
    .map((alias) => alias.trim())
    .filter(Boolean);
  if (aliases.length > 8 || aliases.some((alias) => alias.length > 200)) {
    return null;
  }
  return [...new Set(aliases)];
}

function intParam(raw: string | null): number | null {
  if (!raw) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : null;
}
