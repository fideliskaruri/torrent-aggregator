/**
 * Reading `/api` bodies without letting a transport problem become a
 * "Unexpected end of JSON input" in front of the user. An empty body (a 404
 * from an older server, a 204) and a non-JSON body (a proxy or sign-in page)
 * both read as `null`; callers turn that into a proper state.
 */
export async function readJsonBody<T = unknown>(res: Response): Promise<T | null> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    return null;
  }
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** The send fields the add-torrent input stands for. */
const SOURCE_FIELDS = new Set(["magnet", "torrentUrl", "infoHash"]);

export type SendErrorField = "source" | "savePath" | null;

export interface SendError {
  message: string;
  /** Which part of the form the error belongs to; null = the whole send. */
  field: SendErrorField;
}

const SOURCE_MESSAGES: Record<string, string> = {
  magnet: "That magnet link has no valid info hash. Copy the full link and try again.",
  infoHash: "That info hash isn't valid. Use the 40-character hex or 32-character base32 hash.",
  torrentUrl: "That isn't a usable .torrent URL. It must start with http:// or https://.",
};

const SAVE_PATH_MESSAGE =
  "TorrentFlow can't save to that folder. Choose a folder you can write to in Settings → Downloads.";

/**
 * Turns a failed `/api/torrent/send` answer into one user-facing message tied
 * to the field that caused it. Understands both the old `{ ok, message }` /
 * `{ error }` shapes and the newer `{ error, field }` validation shape.
 */
export function sendErrorFromBody(body: unknown, status: number): SendError {
  const data = (body && typeof body === "object" ? body : {}) as {
    error?: unknown;
    message?: unknown;
    field?: unknown;
    code?: unknown;
  };
  const field = typeof data.field === "string" ? data.field : null;
  const message = typeof data.message === "string" && data.message.trim() ? data.message.trim() : null;
  const error = typeof data.error === "string" && data.error.trim() ? data.error.trim() : null;
  const mentionsSavePath = /save ?path|folder|directory|not writable|unwritable|access (is )?denied/i.test(
    `${error ?? ""} ${message ?? ""}`,
  );

  if (field === "savePath" || (!field && status === 400 && mentionsSavePath)) {
    return { message: SAVE_PATH_MESSAGE, field: "savePath" };
  }
  if (field && SOURCE_FIELDS.has(field)) {
    return { message: SOURCE_MESSAGES[field], field: "source" };
  }
  if (!field && error && /magnet or torrentUrl is required/i.test(error)) {
    return { message: "Paste a magnet link or a direct .torrent URL.", field: "source" };
  }
  if (message) return { message, field: null };
  if (status === 507) {
    return { message: "Your download space limit is full. Free up space or raise the limit in Settings.", field: null };
  }
  if (!body) {
    return {
      message: `TorrentFlow didn't answer properly (HTTP ${status}). Check that it's running, then try again.`,
      field: null,
    };
  }
  // A raw validation sentence ("retention must be one of…") is for developers;
  // say what happened in the user's terms instead.
  return { message: "Couldn't add this torrent. Check the link and try again.", field: null };
}
