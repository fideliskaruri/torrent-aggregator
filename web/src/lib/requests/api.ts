import { send } from "@/lib/api";
import type { RequestChoice, RequestFailure, RequestScope, RequesterTitle } from "./types";

function requestErrorMessage(failure: RequestFailure | null | undefined): string {
  const { code, status } = failure ?? {};
  switch (code) {
    case "in_library": return "That's already in the library. Open Library to find it.";
    case "duplicate": return "You've already asked for this. Follow it under Requests.";
    case "too_many_open": return "You have too many open requests. Cancel one under Requests, or wait for the owner to answer some.";
    case "not_pending": return "The owner has already answered this request, so it can't be cancelled.";
    case "not_found": return "That request no longer exists. Refresh Requests to see the current list.";
    case "requester_only":
    case "requester_forbidden": return "Requests can only be sent from a friend's account. Sign in with the email the owner shared TorrentFlow with.";
    case "remote_sign_in_required": return "Your sign-in has expired. Reload the page to sign in again.";
    case "remote_access_off":
    case "remote_access_not_enabled": return "The owner has turned off remote access. Ask them to turn it back on.";
  }
  if (status === undefined) return "Couldn't reach TorrentFlow. Check your connection and try again.";
  if (status === 400) return "This title couldn't be requested. Open it again from Search and send the request once more.";
  if (status === 401) return "Your sign-in has expired. Reload the page to sign in again.";
  if (status === 403) return "Your account can't send requests. Ask the owner to check that your email is allowed.";
  if (status >= 500) return "TorrentFlow couldn't save the request. Try again in a moment.";
  return "The request didn't go through. Try again, and ask the owner if it keeps happening.";
}

function requestFailure(data: unknown, status: number): RequestFailure {
  const body = data as { code?: unknown } | null;
  return { code: typeof body?.code === "string" ? body.code : null, status };
}

function createRequestBody(title: RequesterTitle, choice: RequestChoice) {
  const note = choice.note.trim();
  const scope: RequestScope = title.isSeries ? (choice.scope === "seasons" ? "seasons" : "series") : "movie";
  return {
    provider: title.provider,
    providerId: title.providerId,
    mediaType: title.mediaType,
    title: title.title,
    year: title.year,
    posterUrl: title.posterUrl,
    scope,
    seasons: scope === "seasons" ? [...new Set(choice.seasons)].sort((a, b) => a - b) : [],
    note: note.length > 0 ? note : null,
  };
}

export async function cancelRequest(id: string): Promise<string | null> {
  try {
    const response = await send(`/api/requester/requests/${encodeURIComponent(id)}/cancel`, { method: "POST" });
    return response.ok ? null : requestErrorMessage(requestFailure(response.data, response.status));
  } catch {
    return requestErrorMessage(null);
  }
}

export async function sendRequest(title: RequesterTitle, choice: RequestChoice): Promise<string | null> {
  try {
    const response = await send("/api/requester/requests", {
      method: "POST",
      body: createRequestBody(title, choice),
    });
    return response.ok ? null : requestErrorMessage(requestFailure(response.data, response.status));
  } catch {
    return requestErrorMessage(null);
  }
}

export function ownerRequestErrorMessage(
  action: "approve" | "decline" | "retry",
  failure: RequestFailure,
): string {
  if (action === "retry" && failure.code === "not_pending") return "Nothing is left to retry. The list now shows where it stands.";
  if (failure.code === "not_pending") return "This request was already answered. The list now shows where it stands.";
  if (failure.code === "not_found") return "That request no longer exists. The list now shows the current requests.";
  if (failure.status === undefined) return "Couldn't reach TorrentFlow. Check your connection and try again.";
  if (failure.status >= 500) return `Couldn't ${action} right now. Try again in a moment.`;
  return `Couldn't ${action}. Reload the page and try again.`;
}
