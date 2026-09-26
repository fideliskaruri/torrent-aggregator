import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { LoadingGlyph } from "@/components/ui/loading";

interface RecoveryInfo {
  dataDirectory: string;
  downloadDirectory?: string | null;
  hasMedia: boolean;
}

export function DownloadRecovery({ mode = "all", onImported, revision }: {
  mode?: "paths" | "empty" | "all";
  onImported?: () => void;
  revision?: string;
}) {
  const [info, setInfo] = useState<RecoveryInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setError(false);
    void fetch("/api/settings/download-recovery", { signal: abort.signal, cache: "no-store" })
      .then(async (response) => {
        if (response.status === 404) { setInfo(null); return; } // Owner-only, hidden on remote access.
        if (!response.ok) throw new Error("Could not inspect download storage");
        setInfo(await response.json() as RecoveryInfo);
      }).catch(() => { if (!abort.signal.aborted) setError(true); });
    return () => abort.abort();
  }, [retry, revision]);

  async function importFiles() {
    setBusy(true);
    try {
      const response = await fetch("/api/settings/download-recovery", { method: "POST" });
      const result = await response.json() as { imported?: number; restoredTorrents?: number; error?: string };
      if (!response.ok) throw new Error(result.error || "Import failed");
      toast.success(`Imported ${result.imported ?? 0} local files; restored ${result.restoredTorrents ?? 0} torrents. Existing downloads were left unchanged.`);
      onImported?.();
      setRetry((value) => value + 1);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Could not import existing downloads");
    } finally { setBusy(false); }
  }

  if (error) return <div role="status" className="text-xs text-[var(--text-secondary)]">
    Storage details unavailable.{" "}
    <Button type="button" variant="ghost" size="sm" onClick={() => setRetry((value) => value + 1)}>Retry storage details</Button>
  </div>;
  if (!info || (mode === "empty" && !info.hasMedia)) return null;
  return <div className="min-w-0 space-y-3 text-xs" data-download-recovery>
    {mode !== "empty" && <dl className="space-y-1 text-[var(--text-secondary)]" data-storage-paths>
      <dt>App data folder</dt>
      <dd className="break-all font-mono">{info.dataDirectory}</dd>
      <dt>Download folder</dt>
      <dd className="break-all font-mono">{info.downloadDirectory || "Not configured — choose and save a folder below."}</dd>
    </dl>}
    {mode !== "paths" && <div className="space-y-2">
      <p className="text-[var(--text-secondary)]">
        {mode === "empty" ? "Media files already exist in your download folder. Recover them without downloading again."
          : "Recover media already in the saved download folder. Files without torrent metadata are imported as completed, non-seeding downloads."}
      </p>
      <Button type="button" variant="secondary" className="min-h-[44px]" disabled={busy || !info.downloadDirectory}
        aria-label="Import existing downloads" data-import-downloads onClick={() => void importFiles()}>
        {busy && <LoadingGlyph className="h-4 w-4" />}
        {busy ? "Scanning and importing…" : "Import existing downloads"}
      </Button>
    </div>}
  </div>;
}
