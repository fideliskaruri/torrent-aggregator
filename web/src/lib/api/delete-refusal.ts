/**
 * Before deleting files the server asks Jellyfin whether anyone is playing
 * them. Something playing is always refused. When Jellyfin can't be asked (the
 * PC is off, or the sign-in isn't an admin) the server refuses with reason
 * "playback-unknown" and the owner may send the same delete again with
 * `deleteAnyway`.
 */
export class PlaybackUncheckedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaybackUncheckedError";
  }
}

export function deleteFailure(body: unknown, fallback: string): Error {
  const data = (body && typeof body === "object" ? body : {}) as {
    reason?: unknown;
    message?: unknown;
    error?: unknown;
  };
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
  const error = text(data.error);
  const message = text(data.message) ?? (error && error !== "Refused" ? error : null) ?? fallback;
  return data.reason === "playback-unknown" ? new PlaybackUncheckedError(message) : new Error(message);
}
