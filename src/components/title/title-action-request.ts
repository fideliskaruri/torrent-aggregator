import type { TitleAction } from "./title-actions";
import type { TitleGrabResponse, TitleRetention } from "./types";

export interface PostTitleActionInput {
  workKey: string;
  title?: string | null;
  mediaType?: string | null;
  year?: number | null;
  action: TitleAction;
  retention: TitleRetention;
}

export async function postTitleAction({
  workKey,
  title,
  mediaType,
  year,
  action,
  retention,
}: PostTitleActionInput): Promise<TitleGrabResponse> {
  if (retention === "keep" && action.kind === "get" && action.infoHash?.trim()) {
    const res = await fetch("/api/torrent/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        infoHash: action.infoHash,
        name: title ?? undefined,
        retention,
      }),
    });
    const body = (await res.json().catch(() => null)) as TitleGrabResponse | null;
    if (!res.ok || !body?.ok) {
      throw new Error(body?.message || "Could not keep this episode");
    }
    return body;
  }

  const res = await fetch(`/api/title/${encodeURIComponent(workKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      season: action.season,
      episode: action.episode,
      title: title ?? null,
      mediaType: mediaType ?? null,
      year: year ?? null,
      retention,
    }),
  });
  const body = (await res.json().catch(() => null)) as TitleGrabResponse | null;
  if (!res.ok || !body?.ok) {
    throw new Error(body?.message || "Could not send this episode");
  }
  return body;
}
