const TITLE_HREF = "/title";
const SAFE_SEGMENT = /^(?:[A-Za-z0-9\-._~]|%[0-9A-Fa-f]{2})*$/;

export interface TitleLinkParams {
  title: string;
  year?: number | null;
  mediaType?: string | null;
  season?: number | null;
  provider?: "anilist" | "tmdb" | "tvmaze" | "cinemeta" | "itunes" | null;
  providerId?: string | null;
  sourceType?: "anime" | "movie" | "tv" | null;
  format?: string | null;
  series?: boolean | null;
}

export function titlePath(key: string, params: TitleLinkParams): string {
  const search = new URLSearchParams();
  const title = params.title.trim();
  if (title) search.set("t", title);
  if (params.year) search.set("y", String(params.year));
  const mediaType = params.mediaType?.trim();
  if (mediaType) search.set("type", mediaType);

  if (
    params.provider &&
    params.providerId?.trim() &&
    params.sourceType &&
    params.series != null &&
    (params.provider !== "anilist" || Boolean(params.format))
  ) {
    search.set("provider", params.provider);
    search.set("providerId", params.providerId.trim());
    search.set("sourceType", params.sourceType);
    if (params.format) search.set("format", params.format);
    search.set("series", params.series ? "1" : "0");
  }

  const query = search.toString();
  const path = `${TITLE_HREF}/${encodeKeySegment(key)}`;
  return query ? `${path}?${query}` : path;
}

export function encodeKeySegment(key: string): string {
  return SAFE_SEGMENT.test(key) ? key : encodeURIComponent(key);
}
