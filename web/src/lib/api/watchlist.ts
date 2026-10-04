import { get, send } from "@/lib/api";
import type { DeletePlan } from "./watchlist-types";

export function removeWatchlistItem(id: string) {
  return send<{ ok?: boolean }>(`/api/watchlist?id=${encodeURIComponent(id)}&confirm=true`, {
    method: "DELETE",
  });
}

export function getDeletePlan(query: string) {
  return get<{ ok?: boolean; plan?: DeletePlan; message?: string; error?: string }>(
    `/api/library/delete?${query}`,
  );
}

export function deleteLibraryFiles(body: {
  watchListItemId: string;
  scope: "show" | "season";
  season?: number;
  confirm: true;
}) {
  return send<{
    ok?: boolean;
    freedFiles?: number;
    message?: string;
    error?: string;
    failed?: unknown[];
    plan?: DeletePlan;
  }>("/api/library/delete", { method: "POST", body });
}
