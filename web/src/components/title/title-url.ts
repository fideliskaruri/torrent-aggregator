import type { NavigateFunction } from "react-router";
import { encodeKeySegment } from "./work-key";
import type { TitleDetailPayload } from "./types";
import type { TitleDetailProps } from "./title-props";

export function followResolvedWorkKey(
  navigate: NavigateFunction,
  pageKey: string,
  resolved: string | null | undefined,
): boolean {
  const next = resolved?.trim();
  if (!next || sameWorkKey(next, pageKey)) return false;
  navigate(
    { pathname: `/title/${encodeKeySegment(next)}`, search: window.location.search },
    { replace: true },
  );
  return true;
}

export function sameWorkKey(a: string, b: string): boolean {
  const plain = (key: string) => {
    try {
      return decodeURIComponent(key).toLowerCase();
    } catch {
      return key.toLowerCase();
    }
  };
  return plain(a) === plain(b);
}

export function buildDetailUrl(
  props: TitleDetailProps & { season: number | null },
): string {
  const params = new URLSearchParams();
  if (props.title) params.set("t", props.title);
  if (props.year) params.set("y", String(props.year));
  if (props.mediaType) params.set("type", props.mediaType);
  if (props.season != null) params.set("s", String(props.season));
  if (props.provider) params.set("provider", props.provider);
  if (props.providerId) params.set("providerId", props.providerId);
  if (props.sourceType) params.set("sourceType", props.sourceType);
  if (props.format) params.set("format", props.format);
  if (props.seriesHint) params.set("series", props.seriesHint);
  if (props.rememberedSeason != null) {
    params.set("remembered", String(props.rememberedSeason));
  }
  const qs = params.toString();
  const base = `/api/title/${encodeURIComponent(props.workKey)}`;
  return qs ? `${base}?${qs}` : base;
}

export function buildExtrasUrl(
  props: TitleDetailProps,
  payload: TitleDetailPayload,
  season: number | null,
): string | null {
  const title = payload.title.trim();
  if (!title) return null;

  const params = new URLSearchParams();
  params.set("v", "3");
  params.set("t", title);
  if (payload.year) params.set("y", String(payload.year));
  const routeMediaType =
    props.provider ? (props.mediaType ?? payload.mediaType) : payload.mediaType;
  if (routeMediaType) params.set("type", routeMediaType);
  if (payload.posterUrl) params.set("poster", payload.posterUrl);
  if (season != null) params.set("s", String(season));
  if (props.provider) params.set("provider", props.provider);
  if (props.providerId) params.set("providerId", props.providerId);
  if (props.sourceType) params.set("sourceType", props.sourceType);
  if (props.format) params.set("format", props.format);
  if (props.seriesHint) params.set("series", props.seriesHint);
  return `/api/title/${encodeURIComponent(props.workKey)}/extras?${params.toString()}`;
}

export function extrasDataIdentity(url: string | null): string | null {
  if (!url) return null;
  const parsed = new URL(url, "http://torrentflow.local");
  parsed.searchParams.delete("s");
  return `${parsed.pathname}?${parsed.searchParams.toString()}`;
}
