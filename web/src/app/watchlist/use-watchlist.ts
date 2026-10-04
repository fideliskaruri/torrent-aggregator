import { useCallback } from "react";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { useApiQuery } from "@/hooks/use-api-query";
import { parseLibrary } from "@/lib/requests";
import { toast } from "@/lib/toast";
import { removeWatchlistItem } from "@/lib/api/watchlist";
import type { WatchlistItem, WatchlistResponse } from "@/lib/api/watchlist-types";

type LibraryRow = {
  key?: string;
  id?: string;
  title: string;
  mediaType: string;
  posterUrl: string | null;
  year?: number | null;
};

function readOnlyItem(row: LibraryRow): WatchlistItem {
  return {
    id: row.key ?? row.id ?? row.title,
    mediaType: row.mediaType,
    externalId: "",
    title: row.title,
    posterUrl: row.posterUrl,
    synopsis: null,
    rating: null,
    status: "available",
    lastEpisode: null,
    latestReleaseTitle: null,
    latestReleaseAt: null,
    latestReleaseMagnet: null,
    nextEpisodeHint: null,
    updatedAt: "",
  };
}

export type WatchlistState =
  | { status: "loading"; items: WatchlistItem[] }
  | { status: "error"; items: WatchlistItem[]; message: string; retry: () => void }
  | { status: "empty"; items: WatchlistItem[]; refresh: () => void }
  | { status: "ready"; items: WatchlistItem[]; refresh: () => void };

export function useWatchlist(ownerSession: boolean, readOnly: boolean) {
  const owner = useApiQuery<WatchlistResponse>(
    ownerSession ? "/api/watchlist" : null,
    { refreshMs: 30_000 },
  );
  const requester = useApiQuery<WatchlistResponse>(
    ownerSession ? null : "/api/requester/library",
    {
      refreshMs: 60_000,
      emptyOnUnauthorized: false,
      select: (json) => ({ items: parseLibrary(json).map(readOnlyItem) }),
    },
  );
  const source = ownerSession ? owner : requester;
  const ownerItems = owner.data?.items ?? [];
  const data = !ownerSession
    ? requester.data
    : readOnly && owner.data
      ? { items: ownerItems.map(readOnlyItem) }
      : owner.data;
  const items = data?.items ?? [];
  const patch = useApiMutation<{
    id: string;
    status?: string;
    monitored?: boolean;
    fromSeason?: number;
    fromEpisode?: number;
  }, { item?: WatchlistItem }>("/api/watchlist", "PATCH");
  const state: WatchlistState = source.loading
    ? { status: "loading", items }
    : source.error
      ? { status: "error", items, message: source.error, retry: source.refetch }
      : items.length
        ? { status: "ready", items, refresh: source.refetch }
        : { status: "empty", items, refresh: source.refetch };

  const update = useCallback(async (body: {
    id: string;
    status?: string;
    monitored?: boolean;
    fromSeason?: number;
    fromEpisode?: number;
  }) => {
    try {
      await patch.run(body);
      source.refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update this title. Try again.");
    }
  }, [patch, source]);

  const remove = useCallback(async (id: string) => {
    const response = await removeWatchlistItem(id);
    if (!response.ok) throw response.error;
    source.refetch();
  }, [source]);

  return {
    state,
    query: source,
    update,
    remove,
    pending: patch.pending,
    refresh: source.refetch,
  };
}
