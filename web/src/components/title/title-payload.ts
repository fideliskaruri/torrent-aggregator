import { parseRequestState, type RequesterTitle } from "@/lib/requests";
import type { CatalogIdentity } from "@/lib/browse/types";
import type { TitleDetailPayload } from "./types";

export function withCatalogDefaults(json: unknown): TitleDetailPayload {
  const p = (json ?? {}) as Partial<TitleDetailPayload> & { inLibrary?: unknown };
  return {
    ...p,
    aliases: p.aliases ?? [],
    seasons: p.seasons ?? [],
    episodes: ((p.episodes ?? []) as Partial<TitleDetailPayload["episodes"][number]>[]).map((e) => ({
      availability: null,
      infoHash: null,
      filePath: null,
      downloadFraction: null,
      nextUp: false,
      fromPack: false,
      transfer: null,
      ...e,
    })),
    availability: p.availability ?? null,
    infoHash: p.infoHash ?? null,
    transfer: p.transfer ?? null,
    library: p.library ?? {
      inLibrary: p.inLibrary === true,
      watchListItemId: null,
      monitored: false,
      status: null,
      cursorSeason: null,
      cursorEpisode: null,
      addPayload: {
        mediaType: p.mediaType ?? "movie",
        externalId: "",
        title: p.title ?? "",
        posterUrl: p.posterUrl ?? null,
        synopsis: null,
        rating: null,
      },
    },
  } as TitleDetailPayload;
}

export function requestTitleFor(
  payload: TitleDetailPayload & CatalogIdentity,
): RequesterTitle | null {
  if (!payload.provider || !payload.providerId) return null;
  const mediaType = payload.mediaType ?? (payload.isSeries ? "tv" : "movie");
  return {
    key: payload.workKey,
    title: payload.title,
    year: payload.year,
    mediaType,
    isSeries: payload.isSeries,
    format: null,
    category: "",
    provider: payload.provider,
    providerId: payload.providerId,
    posterUrl: payload.posterUrl ?? null,
    overview: payload.overview ?? null,
    releaseDate: payload.releaseDate ?? null,
    ...parseRequestState(payload),
  };
}
