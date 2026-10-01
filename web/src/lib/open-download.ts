import { readJsonBody } from "@/lib/api-json";
import { toast } from "@/lib/toast";

/** `open` starts the computer's own player; `reveal` shows the file in its folder. */
export type OpenDownloadMode = "open" | "reveal";

interface OpenDownloadBody {
  ok?: boolean;
  fileName?: string;
  error?: string;
  message?: string;
  openFolderDisabled?: boolean;
}

/**
 * Opens one finished built-in download on the computer running TorrentFlow
 * (docs/api-open-file.md). `id` is a Downloads row's `transferId`, or the bare
 * info hash the title page has. The result is said in a toast. When this
 * computer can't open files after all (remote access, a container),
 * `fallbackPath` goes to the clipboard instead, the same fallback the Open
 * folder action uses.
 */
export async function openDownload(
  id: string,
  mode: OpenDownloadMode,
  fallbackPath?: string | null,
): Promise<boolean> {
  let res: Response;
  try {
    res = await fetch(`/api/downloads/${encodeURIComponent(id)}/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
  } catch {
    toast.error("Couldn't reach TorrentFlow. Check your connection and try again.");
    return false;
  }
  const body = await readJsonBody<OpenDownloadBody>(res);
  const data = body ?? {};
  if (res.ok && data.ok) {
    const name = data.fileName?.trim();
    if (mode === "reveal") toast.success(name ? `Showing ${name} in its folder` : "Showing the file in its folder");
    else toast.success(name ? `Opening ${name}` : "Opening the file");
    return true;
  }
  // `reason` is for code paths; the person reads `message`, else `error`.
  const text =
    data.message?.trim() ||
    data.error?.trim() ||
    (body
      ? "Couldn't open this download. Try again."
      : `TorrentFlow didn't answer properly (HTTP ${res.status}). Check that it's running, then try again.`);
  if (data.openFolderDisabled && fallbackPath) {
    try {
      await navigator.clipboard.writeText(fallbackPath);
      toast.message(text, { description: "Path copied to clipboard" });
      return false;
    } catch {
      // Clipboard blocked: say what happened instead.
    }
  }
  toast.error(text);
  return false;
}

/** Copies a folder path when this computer can't open folders itself. */
export async function copyDownloadPath(path: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(path);
    toast.success("Path copied to clipboard");
  } catch {
    toast.error("Couldn't copy the path. Select it and copy it yourself.", { description: path });
  }
}
