/**
 * First-download setup, asked where the owner is instead of in Settings.
 *
 * A fresh install has no download folder or space limit, and the server
 * refuses a kept download until both exist. Rather than a toast that sends the
 * owner off to Settings and loses what they were doing, the first Download
 * opens this dialog with the same fields Settings uses, saves them, and lets
 * the download carry on.
 *
 * Streams never need this: the engine stores them in its own cache.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { AlertTriangle } from "lucide-react";
import {
  detectUnsafeDownloadPath,
  unsafeDownloadPathMessage,
} from "@/app/settings/download-path-safety";
import { invalidateDownloadPrefs } from "@/hooks/use-download-prefs";
import { DownloadLocationFields } from "@/components/settings/download-location-fields";
import { FolderPicker } from "@/components/settings/folder-picker";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LoadingGlyph } from "@/components/ui/loading";

const DEFAULT_SPACE_GB = "100";

interface SettingsPayload {
  settings?: {
    setupComplete?: boolean;
    baseDownloadPath?: string | null;
    savePath?: string | null;
    maxStorageGb?: number | null;
  };
  defaults?: { baseDownloadPath?: string };
  message?: string;
  error?: string;
}

interface DownloadSetupContextValue {
  /**
   * Resolves true once downloads have a folder and a space limit, asking the
   * owner first when they do not. False means the owner cancelled.
   * `recheck` skips the cached answer, for when the server just refused.
   */
  ensureDownloadSetup: (opts?: { recheck?: boolean }) => Promise<boolean>;
}

const DownloadSetupContext = createContext<DownloadSetupContextValue | null>(null);

// Outside the provider there is nothing to ask with, so the request goes ahead
// and the server's own refusal is what the owner sees.
const PASSTHROUGH: DownloadSetupContextValue = {
  ensureDownloadSetup: () => Promise.resolve(true),
};

export function useDownloadSetup(): DownloadSetupContextValue {
  return useContext(DownloadSetupContext) ?? PASSTHROUGH;
}

export function DownloadSetupProvider({ children }: { children: ReactNode }) {
  const ready = useRef(false);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const decide = useRef<((ok: boolean) => void) | null>(null);

  const [open, setOpen] = useState(false);
  const [folder, setFolder] = useState("");
  const [spaceGb, setSpaceGb] = useState(DEFAULT_SPACE_GB);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const settle = useCallback((ok: boolean) => {
    const resolve = decide.current;
    decide.current = null;
    setOpen(false);
    setPickerOpen(false);
    setSaving(false);
    resolve?.(ok);
  }, []);

  const ensureDownloadSetup = useCallback(
    ({ recheck = false }: { recheck?: boolean } = {}) => {
      if (ready.current && !recheck) return Promise.resolve(true);
      // Two Download presses before the first answer share one dialog.
      if (inFlight.current) return inFlight.current;
      const run = (async () => {
        let data: SettingsPayload;
        try {
          const res = await fetch("/api/settings/client");
          if (!res.ok) return true;
          data = (await res.json()) as SettingsPayload;
        } catch {
          // Can't tell, so don't block: the send reports its own failure.
          return true;
        }
        const s = data.settings;
        if (s?.setupComplete) {
          ready.current = true;
          return true;
        }
        ready.current = false;
        setFolder(
          s?.baseDownloadPath?.trim() ||
            s?.savePath?.trim() ||
            data.defaults?.baseDownloadPath ||
            "",
        );
        setSpaceGb(
          s?.maxStorageGb != null && s.maxStorageGb > 0
            ? String(s.maxStorageGb)
            : DEFAULT_SPACE_GB,
        );
        setError(null);
        setOpen(true);
        return new Promise<boolean>((resolve) => {
          decide.current = resolve;
        });
      })();
      inFlight.current = run;
      void run.finally(() => {
        inFlight.current = null;
      });
      return run;
    },
    [],
  );

  async function save(event: FormEvent) {
    event.preventDefault();
    const path = folder.trim();
    const gb = Number(spaceGb);
    if (!path) {
      setError("Choose a download folder.");
      return;
    }
    if (!Number.isFinite(gb) || gb <= 0) {
      setError("Set a space limit above 0 GB.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/client", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseDownloadPath: path, maxStorageGb: gb }),
      });
      const data = (await res.json().catch(() => null)) as SettingsPayload | null;
      if (!res.ok || !data?.settings?.setupComplete) {
        setError(data?.message || data?.error || "Could not save these settings.");
        setSaving(false);
        return;
      }
      ready.current = true;
      invalidateDownloadPrefs();
      settle(true);
    } catch {
      setError("Could not reach TorrentFlow to save these settings.");
      setSaving(false);
    }
  }

  const safety = detectUnsafeDownloadPath(folder);
  const value = useMemo(() => ({ ensureDownloadSetup }), [ensureDownloadSetup]);

  return (
    <DownloadSetupContext.Provider value={value}>
      {children}
      <Dialog
        // Hidden, not closed, while the folder browser is up, so the answers so
        // far survive the trip.
        open={open && !pickerOpen}
        onOpenChange={(next) => {
          if (!next && !pickerOpen) settle(false);
        }}
      >
        <DialogContent className="gap-4 p-5 sm:max-w-md" data-download-setup>
          <DialogHeader className="pr-10">
            <DialogTitle>Where should downloads go?</DialogTitle>
            <DialogDescription>
              Pick a folder and how much space TorrentFlow may use. You only do
              this once, and you can change it later in Settings.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={(e) => void save(e)} className="space-y-4">
            <DownloadLocationFields
              idPrefix="setup-"
              folder={folder}
              onFolderChange={setFolder}
              onBrowse={() => setPickerOpen(true)}
              spaceGb={spaceGb}
              onSpaceGbChange={setSpaceGb}
            />
            {safety.unsafe ? (
              <p className="flex items-start gap-2 text-xs leading-relaxed text-[var(--warning)]">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {unsafeDownloadPathMessage(safety.reasons)}
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-xs text-[var(--danger)]">
                {error}
              </p>
            ) : null}
            <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
              <Button type="button" variant="ghost" onClick={() => settle(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving} data-download-setup-save>
                {saving ? <LoadingGlyph className="h-4 w-4" /> : null}
                Save and download
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <FolderPicker
        open={open && pickerOpen}
        initialPath={folder}
        title="Choose download folder"
        onClose={() => setPickerOpen(false)}
        onSelect={(path) => {
          setFolder(path);
          setPickerOpen(false);
        }}
      />
    </DownloadSetupContext.Provider>
  );
}
