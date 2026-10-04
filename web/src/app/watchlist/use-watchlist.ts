import { useApiMutation } from "@/hooks/use-api-mutation";
import { useApiQuery } from "@/hooks/use-api-query";
import { parseLibrary } from "@/lib/requests";
import { toast } from "@/lib/toast";
import { removeWatchlistItem } from "@/lib/api/watchlist";
import type { WatchlistItem, WatchlistResponse } from "@/lib/api/watchlist-types";

type LibraryRow = {
  key?: string;
  id?: string;
  workKey?: string | null;
  title: string;
  mediaType: string;
  posterUrl: string | null;
  year?: number | null;
};

type WatchlistPatch = {
  id: string;
  status?: string;
  monitored?: boolean;
  fromSeason?: number;
  fromEpisode?: number;
};

function readOnlyItem(row: LibraryRow): WatchlistItem {
  return {
    id: row.key ?? row.id ?? row.title,
    workKey: row.workKey ?? row.key,
    mediaType: row.mediaType,
    externalId: "",
    title: row.title,
    posterUrl: row.posterUrl,
    synopsis: null,
    rating: null,
    status: "available",
    updatedAt: "",
  };
}

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
  const patch = useApiMutation<WatchlistPatch, { item?: WatchlistItem }>("/api/watchlist", "PATCH");

  async function update(body: WatchlistPatch) {
    try {
      await patch.run(body);
      source.refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update this title. Try again.");
    }
  }

  async function remove(id: string) {
    const response = await removeWatchlistItem(id);
    if (!response.ok) throw response.error;
    source.refetch();
  }

  async function removeMany(ids: string[]) {
    const responses = await Promise.allSettled(ids.map(removeWatchlistItem));
    source.refetch();
    const failed = responses.find((result) =>
      result.status === "rejected" || !result.value.ok,
    );
    if (failed) throw failed.status === "rejected" ? failed.reason : failed.value.error;
  }

  return {
    items,
    query: source,
    update,
    remove,
    removeMany,
    refresh: source.refetch,
  };
}
