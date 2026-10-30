import { get, send, type ApiResponse } from "@/lib/api";

export const JELLYFIN_URL = "/api/settings/jellyfin";

export type JellyfinConnection = "ok" | "unreachable" | "unauthorized" | "notConfigured";
export type JellyfinPathMapping = { from: string; to: string };
export type JellyfinUserMapping = { torrentFlowUserId: string; jellyfinUserId: string };
export type TorrentFlowPerson = { id: string | number; name: string | null; owner: boolean };

export type JellyfinStatus = {
  people: TorrentFlowPerson[];
  serverUrl: string | null;
  userId: string | null;
  configured: boolean;
  userName: string | null;
  isAdmin: boolean;
  serverId: string | null;
  serverName: string | null;
  publicUrl: string | null;
  pathMappings: JellyfinPathMapping[];
  watchUserIds: string[];
  userMappings: JellyfinUserMapping[];
  syncLibraries: boolean;
  suggestNextEpisodes: number;
  subtitleLanguages: string[];
  connection: JellyfinConnection;
  message: string;
};

export type JellyfinUser = { id: string; name: string; isAdmin: boolean };
export type FolderSuggestion = {
  rootId: string | number;
  localPath: string;
  suggestedJellyfinPath: string | null;
  verified: boolean;
};

export type JellyfinOptions = Partial<Pick<JellyfinStatus,
  "publicUrl" | "pathMappings" | "watchUserIds" | "userMappings" | "syncLibraries" | "suggestNextEpisodes" | "subtitleLanguages">>;

export const SUGGEST_COUNTS = [0, 1, 2, 3, 5] as const;

function messageOf(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    for (const key of ["message", "error", "detail"] as const) {
      const value = (body as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim() && value.length < 300) return value.trim();
    }
  }
  return fallback;
}

async function expect<T>(pending: Promise<ApiResponse<T>>, fallback: string): Promise<T> {
  const response = await pending;
  if (!response.ok || response.data == null) throw new Error(messageOf(response.data, fallback));
  return response.data;
}

export function signIn(serverUrl: string, username: string, password: string) {
  return expect(send<JellyfinStatus>(`${JELLYFIN_URL}/signin`, { method: "POST", body: { serverUrl, username, password } }),
    "Could not sign in to Jellyfin. Check the address, username and password.");
}

export function connectWithKey(serverUrl: string, userId: string, apiKey: string) {
  return expect(send<JellyfinStatus>(JELLYFIN_URL, { method: "PUT", body: { serverUrl, userId, apiKey } }),
    "Could not connect. Check the address, API key and user ID.");
}

export function disconnect() {
  return expect(send<JellyfinStatus>(JELLYFIN_URL, { method: "DELETE" }), "Could not disconnect Jellyfin. Try again.");
}

export function saveOptions(options: JellyfinOptions) {
  return expect(send<JellyfinStatus>(`${JELLYFIN_URL}/options`, { method: "PATCH", body: options }),
    "Could not save this change. Try again.");
}

export function loadUsers() {
  return expect(get<JellyfinUser[]>(`${JELLYFIN_URL}/users`, { cache: "no-store" }),
    "Could not load Jellyfin users.");
}

export function suggestFolders() {
  return expect(get<FolderSuggestion[]>(`${JELLYFIN_URL}/mappings/suggest`, { cache: "no-store" }),
    "Could not look up your folders in Jellyfin.");
}

export async function verifyFolder(localPath: string, jellyfinPath: string) {
  const response = await send<{ ok: boolean; message: string }>(`${JELLYFIN_URL}/mappings/verify`,
    { method: "POST", body: { localPath, jellyfinPath } });
  const body = response.data;
  if (body && typeof body.ok === "boolean") return { ok: body.ok, message: messageOf(body, "") };
  return { ok: false, message: messageOf(body, "Could not check this folder. Try again.") };
}

export function personName(person: TorrentFlowPerson) {
  return person.name?.trim() || (person.owner ? "You" : "Someone");
}

export function connectedLine(status: JellyfinStatus): string {
  if (status.connection === "ok") {
    const who = status.userName ?? "your account";
    return status.isAdmin ? `Connected as ${who} (admin)` : `Connected as ${who}`;
  }
  if (status.connection === "unreachable") return "Jellyfin is not answering";
  if (status.connection === "unauthorized") return "Jellyfin refused the sign-in";
  return "Not connected";
}
