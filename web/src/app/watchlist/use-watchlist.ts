import { useEffect, useState } from "react";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { useApiQuery } from "@/hooks/use-api-query";
import { parseLibrary } from "@/lib/requests";
import { toast } from "@/lib/toast";
import { removeWatchlistItem } from "@/lib/api/watchlist";
import { deleteFailure } from "@/lib/api/delete-refusal";
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
  preferredResolution?: number | null;
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
  const [patchedOwnerItems, setPatchedOwnerItems] = useState<WatchlistItem[] | null>(null);
  useEffect(() => {
    if (ownerSession && !readOnly && owner.data?.items) {
      setPatchedOwnerItems(owner.data.items);
    }
  }, [owner.data, ownerSession, readOnly]);
  const items = ownerSession && !readOnly
    ? patchedOwnerItems ?? ownerItems
    : data?.items ?? [];
  const patch = useApiMutation<WatchlistPatch, { item?: WatchlistItem }>(
    "/api/watchlist",
    "PATCH",
  );

  async function update(body: WatchlistPatch): Promise<WatchlistItem | null> {
    try {
      const response = await patch.run(body);
      const updatedItem = response?.item ?? null;
      if (updatedItem) {
        setPatchedOwnerItems((current) => {
          const rows = current ?? ownerItems;
          return [
            ...rows.filter((item) => item.id !== body.id && item.id !== updatedItem.id),
            updatedItem,
          ];
        });
      }
      source.refetch();
      return updatedItem;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update this title. Try again.");
      return null;
    }
  }

  async function remove(id: string, deleteAnyway = false) {
    const response = await removeWatchlistItem(id, deleteAnyway);
    if (!response.ok) throw deleteFailure(response.data, "Could not remove this title. Try again.");
    source.refetch();
  }

  async function removeMany(ids: string[]) {
    const responses = await Promise.allSettled(ids.map((id) => removeWatchlistItem(id)));
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
