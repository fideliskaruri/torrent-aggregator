import { send } from "@/lib/api";

/** Library kinds a drive accepts, in the server's enum order. */
export const LIBRARY_KINDS = [
  { value: "Movies", label: "Movies" },
  { value: "TV", label: "TV" },
  { value: "Anime", label: "Anime" },
  { value: "AnimeMovies", label: "Anime movies" },
] as const;
export type LibraryKind = (typeof LIBRARY_KINDS)[number]["value"];

export interface StorageRoot {
  id: string;
  path: string;
  kinds: LibraryKind[];
  priority: number;
  reserveBytes: number;
  enabled: boolean;
  online: boolean;
  reviewRequired: boolean;
  lastCheckedAt: string | null;
  lastError: string | null;
  version: number;
  freeBytes: number | null;
}

export interface ImportCandidate {
  workId: string;
  title: string;
  year: number | null;
  kind: "Film" | "Series";
  episodeId: string | null;
  season: number | null;
  episode: number | null;
}

export interface ImportItem {
  id: string;
  path: string;
  bytes: number;
  group: "Confident" | "NeedsPick" | "Unmatched";
  candidates: ImportCandidate[];
  sidecars: { path: string }[];
  alreadyInLibrary: boolean;
  message: string | null;
}

export interface ImportScan {
  id: string;
  path: string;
  state: "queued" | "scanning" | "complete" | "failed";
  total: number;
  scanned: number;
  items: ImportItem[];
  error: string | null;
}

export interface ImportResultItem {
  itemId: string;
  imported: boolean;
  alreadyInLibrary: boolean;
  error: string | null;
}

/** Sends JSON to a library route and returns the body, or throws the server's own message. */
export async function libraryRequest<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res;
  try {
    res = await send<T>(url, { method, body });
  } catch {
    throw new Error("TorrentFlow didn't answer. Check that it's running, then try again.");
  }
  const json = res.data as Record<string, unknown> | null;
  if (!res.ok) {
    const failure = json?.failure as { message?: string } | undefined;
    const message = failure?.message ?? (typeof json?.message === "string" ? json.message : null);
    throw new Error(message ?? `TorrentFlow couldn't do that (HTTP ${res.status}). Try again.`);
  }
  return json as T;
}

/** "Breaking Bad (2008)", "Breaking Bad, season 1 episode 3". */
export function candidateLabel(candidate: ImportCandidate): string {
  if (candidate.episodeId)
    return `${candidate.title}, season ${candidate.season} episode ${candidate.episode}`;
  return candidate.year ? `${candidate.title} (${candidate.year})` : candidate.title;
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
