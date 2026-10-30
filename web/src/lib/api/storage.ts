import { get, send } from "@/lib/api";
import { deleteFailure } from "@/lib/api/delete-refusal";

export type LibraryKind = "Movies" | "TV" | "Anime" | "AnimeMovies";
export type StorageStatus = "online" | "offline" | "full" | "review" | "off";

export const LIBRARY_KINDS: { kind: LibraryKind; label: string }[] = [
  { kind: "Movies", label: "Movies" },
  { kind: "TV", label: "Series" },
  { kind: "Anime", label: "Anime" },
  { kind: "AnimeMovies", label: "Anime movies" },
];

export interface StorageRoot {
  id: string;
  path: string;
  label: string;
  kinds: LibraryKind[];
  priority: number;
  enabled: boolean;
  online: boolean;
  reviewRequired: boolean;
  lastError: string | null;
  version: number;
  status: StorageStatus;
  totalBytes: number | null;
  freeBytes: number | null;
  committedBytes: number;
  maxAllocatedBytes: number | null;
  usedBytes: number;
  /** The space kept free right now, including the automatic default. */
  reserveBytes: number;
  /** What the owner set; 0 means automatic. */
  reserveSetting: number;
  missingCount: number;
  jellyfin: StorageJellyfin;
}

export interface StorageJellyfin {
  state: "off" | "pending" | "registered" | "indexed" | "failed";
  libraries: string[];
  message: string | null;
}

export interface JellyfinOrphanPath {
  rootId: string;
  libraryName: string;
  path: string;
  state: "off" | "removed-root";
}

export async function listJellyfinOrphanPaths(): Promise<JellyfinOrphanPath[]> {
  const response = await get<{ paths: JellyfinOrphanPath[] }>("/api/jellyfin/orphan-paths");
  return response.ok && response.data ? response.data.paths : [];
}

export async function syncRootToJellyfin(rootId: string): Promise<StorageJellyfin> {
  const response = await send<{ jellyfin?: StorageJellyfin; message?: string }>(
    `/api/library/roots/${encodeURIComponent(rootId)}/jellyfin/sync`,
    { method: "POST" },
  );
  const status = response.data?.jellyfin;
  if (status?.state === "failed") throw new Error(status.message ?? "Jellyfin did not take the folder. Try again.");
  if (response.error || !status)
    throw new Error(failureMessage(response.data, "Could not reach Jellyfin. Check that it is running and try again."));
  return status;
}

export async function removeRootFromJellyfin(rootId: string): Promise<string> {
  const response = await send<{ removed?: number; failed?: number; message?: string }>(
    `/api/library/roots/${encodeURIComponent(rootId)}/jellyfin/remove`,
    { method: "POST" },
  );
  const message = response.data?.message ?? "Could not reach Jellyfin. Check that it is running and try again.";
  if (response.error || !response.data || (response.data.removed ?? 0) === 0 || (response.data.failed ?? 0) > 0)
    throw new Error(message);
  return message;
}

export interface StorageRootEdit {
  kinds: LibraryKind[];
  reserveBytes: number;
  maxAllocatedBytes: number | null;
  enabled: boolean;
  confirmIdentity?: boolean;
}

interface RootReply {
  root: StorageRoot | null;
  failure: { message: string } | null;
}

function failureMessage(data: unknown, fallback: string): string {
  if (data && typeof data === "object") {
    const record = data as { failure?: { message?: unknown } | null; message?: unknown; error?: unknown };
    if (typeof record.failure?.message === "string") return record.failure.message;
    if (typeof record.message === "string") return record.message;
    if (typeof record.error === "string") return record.error;
  }
  return fallback;
}

async function rootCall(path: string, method: string, body?: unknown): Promise<StorageRoot | null> {
  const response = await send<RootReply>(path, { method, body });
  if (response.error || response.data?.failure)
    throw new Error(failureMessage(response.data, "Could not save the storage location. Try again."));
  return response.data?.root ?? null;
}

export async function listStorageRoots(): Promise<StorageRoot[]> {
  const response = await get<{ roots: StorageRoot[] }>("/api/library/roots");
  if (response.error || !response.data)
    throw new Error(failureMessage(response.data, "Could not load storage locations."));
  return [...response.data.roots].sort((a, b) => a.priority - b.priority);
}

export function addStorageRoot(path: string, kinds: LibraryKind[], reserveBytes = 0, maxAllocatedBytes: number | null = null) {
  return rootCall("/api/library/roots", "POST", { path, kinds, reserveBytes, maxAllocatedBytes });
}

export function updateStorageRoot(root: StorageRoot, edit: StorageRootEdit) {
  return rootCall(`/api/library/roots/${encodeURIComponent(root.id)}`, "PUT", {
    priority: root.priority,
    expectedVersion: root.version,
    kinds: edit.kinds,
    reserveBytes: edit.reserveBytes,
    enabled: edit.enabled,
    maxAllocatedBytes: edit.maxAllocatedBytes,
    clearMaxAllocatedBytes: edit.maxAllocatedBytes === null,
    confirmIdentity: edit.confirmIdentity ?? false,
  });
}

export function removeStorageRoot(root: StorageRoot) {
  return rootCall(`/api/library/roots/${encodeURIComponent(root.id)}`, "DELETE");
}

export async function reorderStorageRoots(ids: string[]): Promise<void> {
  const response = await send("/api/library/roots/order", { method: "PUT", body: { ids } });
  if (response.error) throw new Error(failureMessage(response.data, "Could not save the new order. Try again."));
}

export interface CleanupItem {
  workId: string;
  title: string;
  year: number | null;
  kind: "film" | "series";
  poster: string | null;
  watched: "movie" | { played: number; total: number };
  lastPlayedAt: string | null;
  bytes: number;
  watchedBytes: number;
  roots: { id: string; label: string; online: boolean }[];
  deletable: boolean;
  watchedEpisodeIds: string[];
}

export type CleanupAvailability = "ok" | "off" | "unreachable" | string;

export interface CleanupList {
  jellyfin: CleanupAvailability;
  needsAdmin?: boolean;
  message?: string | null;
  items: CleanupItem[];
}

export async function listCleanup(): Promise<CleanupList> {
  const response = await get<CleanupList>("/api/library/cleanup");
  if (response.error || !response.data)
    throw new Error(failureMessage(response.data, "Could not load watched titles."));
  return response.data;
}

export type CleanupScope = "watched" | "whole";

export interface CleanupDeleteResult {
  freedBytes: number;
  failedFiles: number;
}

export async function deleteCleanupItem(
  item: CleanupItem,
  scope: CleanupScope,
  deleteAnyway = false,
): Promise<CleanupDeleteResult> {
  const body =
    item.kind === "series" && scope === "watched"
      ? { workId: item.workId, scope: "episodes", episodeIds: item.watchedEpisodeIds, confirm: true, deleteAnyway }
      : { workId: item.workId, scope: "show", confirm: true, deleteAnyway };
  const response = await send<{ ok?: boolean; freedBytes?: number; failed?: unknown[] }>("/api/library/delete", {
    method: "POST",
    body,
  });
  if (response.error || !response.data) throw deleteFailure(response.data, `Could not delete ${item.title}.`);
  return {
    freedBytes: response.data.freedBytes ?? 0,
    failedFiles: response.data.ok === false ? Math.max(response.data.failed?.length ?? 0, 1) : 0,
  };
}
