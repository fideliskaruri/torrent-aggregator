import { send } from "@/lib/api";

export type WatchLaterState =
  | "downloading"
  | "inLibrary"
  | "available"
  | "inCinemas"
  | "coming"
  | "unavailable";

export interface WatchLaterItem {
  watchItemId: string;
  workKey: string;
  mediaType: string;
  title: string;
  year: number | null;
  posterUrl: string | null;
  state: WatchLaterState;
  availableAt: string | null;
  watched: boolean;
  newEpisodes: boolean;
  unavailable: boolean;
  series: boolean;
}

export interface WatchLaterResponse {
  items: WatchLaterItem[];
  jellyfinStale: boolean;
}

export const WATCH_LATER_URL = "/api/watch-later";

export type WatchLaterGroupKey = "outNow" | "coming" | "library" | "watched";

export const WATCH_LATER_GROUPS: { key: WatchLaterGroupKey; title: string }[] = [
  { key: "outNow", title: "Out now" },
  { key: "coming", title: "Coming soon" },
  { key: "library", title: "In your library" },
  { key: "watched", title: "Watched" },
];

export function groupOf(item: WatchLaterItem): WatchLaterGroupKey {
  if (item.watched && !item.newEpisodes) return "watched";
  switch (item.state) {
    case "inLibrary":
    case "downloading":
      return "library";
    case "coming":
    case "inCinemas":
      return "coming";
    default:
      return "outNow";
  }
}

export function groupWatchLater(items: WatchLaterItem[]): Record<WatchLaterGroupKey, WatchLaterItem[]> {
  const groups: Record<WatchLaterGroupKey, WatchLaterItem[]> = {
    outNow: [], coming: [], library: [], watched: [],
  };
  for (const item of items) groups[groupOf(item)].push(item);
  groups.coming.sort((a, b) => (a.availableAt ?? "9999").localeCompare(b.availableAt ?? "9999"));
  return groups;
}

export function parseWatchLater(json: unknown): WatchLaterResponse {
  const body = json as Partial<WatchLaterResponse> | null;
  return {
    items: Array.isArray(body?.items) ? body.items : [],
    jellyfinStale: body?.jellyfinStale === true,
  };
}

/** "Out on 14 March", or "In cinemas until 14 March" for a film still in its window. */
export function releaseLine(item: WatchLaterItem): string | null {
  if (!item.availableAt) return item.state === "inCinemas" ? "In cinemas" : "Date not announced";
  const date = new Date(item.availableAt);
  if (Number.isNaN(date.getTime())) return null;
  const sameYear = date.getFullYear() === new Date().getFullYear();
  const text = date.toLocaleDateString(undefined, {
    day: "numeric", month: "long", ...(sameYear ? {} : { year: "numeric" }),
  });
  return item.state === "inCinemas" ? `In cinemas, out to watch ${text}` : `Out ${text}`;
}

async function failure(res: Response, fallback: string): Promise<Error> {
  try {
    const body = (await res.json()) as { error?: string; message?: string };
    return new Error(body.message ?? body.error ?? fallback);
  } catch {
    return new Error(fallback);
  }
}

/** Following a title is what makes the hunter fetch it, now or on release. */
export async function follow(item: WatchLaterItem): Promise<void> {
  const res = await send("/api/watchlist", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: item.watchItemId, monitored: true }),
  });
  if (!res.ok) throw await failure(res, `Could not start ${item.title}. Try again.`);
}

export type RemoveResult = "removed" | "hasFiles";

/** Never passes confirm=true: that would delete files. A title with files is removed from Library. */
export async function removeFromWatchlist(item: WatchLaterItem): Promise<RemoveResult> {
  const res = await send(`/api/watchlist?id=${encodeURIComponent(item.watchItemId)}`, { method: "DELETE" });
  if (res.status === 409) return "hasFiles";
  if (!res.ok) throw await failure(res, `Could not remove ${item.title}. Try again.`);
  return "removed";
}
