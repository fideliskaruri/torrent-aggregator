import {
  getAniListWorkById,
  type AniListFormat,
  type AniListWork,
} from "@/lib/metadata/anilist";
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

export interface TitleProviderIdentity {
  provider: "anilist";
  externalId: string;
  mediaType: "anime";
  format: AniListFormat | null;
  isSeries: boolean;
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

export async function resolveTitleProviderIdentity(
  params: URLSearchParams,
  workKey: string,
  lookup: AniListLookup = getAniListWorkById,
): Promise<TitleProviderIdentityResult> {
  const provider = params.get("provider")?.trim().toLowerCase();
  if (!provider) return { kind: "absent" };
  if (provider !== "anilist") {
    return { kind: "invalid", reason: "Unsupported title provider" };
  }

  const externalId = params.get("providerId")?.trim() ?? "";
  if (!/^[1-9]\d{0,11}$/.test(externalId)) {
    return { kind: "invalid", reason: "Invalid AniList identity" };
  }
  if (params.get("sourceType")?.trim().toLowerCase() !== "anime") {
    return { kind: "invalid", reason: "AniList identity must be anime" };
  }

  const carried = carriedIdentity(params, workKey, externalId);
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
      metadata: work.metadata,
      verified: true,
    },
  };
}

function carriedIdentity(
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
  if (
    rawYear &&
    (year == null || year < 1800 || year > 2200)
  ) {
    return { reason: "Invalid AniList year" };
  }
  if (!workKeyMatches(workKey, title, isSeries ? null : year)) {
    return { reason: "Work key did not match carried AniList identity" };
  }

  const aliases = params
    .getAll("alias")
    .map((alias) => alias.trim())
    .filter(Boolean);
  if (aliases.length > 8 || aliases.some((alias) => alias.length > 200)) {
    return { reason: "Invalid AniList aliases" };
  }

  return {
    provider: "anilist",
    externalId,
    mediaType: "anime",
    format,
    isSeries,
    metadata: {
      source: "anilist",
      mediaType: "anime",
      externalId,
      title,
      aliases: [...new Set(aliases)],
      year,
    },
    verified: false,
  };
}

function intParam(raw: string | null): number | null {
  if (!raw) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : null;
}
