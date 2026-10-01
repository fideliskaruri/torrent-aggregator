/**
 * Reading and changing "downloads at once" through `/api/settings/client`, the
 * one endpoint and one server field behind both Settings and the Downloads
 * status line. The PUT is a partial update, so `{ maxActiveDownloads }` alone
 * changes nothing else.
 */
import { readJsonBody } from "@/lib/api-json";
import { invalidateDownloadPrefs } from "@/hooks/use-download-prefs";

/** "schedule" while open download hours set their own cap, else "setting". */
export type MaxActiveSource = "schedule" | "setting";

export interface DownloadLimits {
  /** The owner's saved downloads at once. */
  saved: number;
  /** What the queue holds to right now. */
  effective: number;
  source: MaxActiveSource;
}

interface SettingsBody {
  settings?: {
    maxActiveDownloads?: unknown;
    effectiveMaxActive?: unknown;
    maxActiveSource?: unknown;
  };
  message?: unknown;
}

const SAVE_FAILED = "Couldn't change downloads at once. Check your connection and try again.";

function limitsFrom(body: SettingsBody | null): DownloadLimits | null {
  const settings = body?.settings;
  const saved = settings?.maxActiveDownloads;
  if (typeof saved !== "number" || !Number.isFinite(saved)) return null;
  // A server without effectiveMaxActive enforces the saved cap.
  const effective =
    typeof settings?.effectiveMaxActive === "number" && Number.isFinite(settings.effectiveMaxActive)
      ? settings.effectiveMaxActive
      : saved;
  return {
    saved,
    effective,
    source: settings?.maxActiveSource === "schedule" ? "schedule" : "setting",
  };
}

export async function readDownloadLimits(signal?: AbortSignal): Promise<DownloadLimits | null> {
  try {
    const res = await fetch("/api/settings/client", { cache: "no-store", signal });
    if (!res.ok) return null;
    return limitsFrom(await readJsonBody<SettingsBody>(res));
  } catch {
    return null;
  }
}

export type SaveDownloadLimitResult =
  | { ok: true; limits: DownloadLimits | null }
  | { ok: false; message: string };

export async function setMaxActiveDownloads(value: number): Promise<SaveDownloadLimitResult> {
  let res: Response;
  try {
    res = await fetch("/api/settings/client", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxActiveDownloads: value }),
    });
  } catch {
    return { ok: false, message: SAVE_FAILED };
  }
  const body = await readJsonBody<SettingsBody>(res);
  if (!res.ok) {
    // `message` is written for people; `error` is often a validation sentence.
    const message = typeof body?.message === "string" ? body.message.trim() : "";
    return { ok: false, message: message || SAVE_FAILED };
  }
  invalidateDownloadPrefs();
  return { ok: true, limits: limitsFrom(body) };
}
