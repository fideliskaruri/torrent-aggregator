import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LoadingGlyph } from "@/components/ui/loading";
import { formatBytes } from "@/lib/utils";

interface RecoveryInfo {
  dataDirectory: string;
  downloadDirectory?: string | null;
  hasMedia: boolean;
}

interface SourceCandidate {
  id: string;
  source: string;
  hash: string;
  name: string;
  sizeBytes: number;
  savePath: string;
  dataExists: boolean;
  complete: boolean;
  alreadyImported: boolean;
}

interface SourceScan {
  candidates: SourceCandidate[];
  warnings: string[];
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
  const [sourceOpen, setSourceOpen] = useState(false);
  const [sourceState, setSourceState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [sourceScan, setSourceScan] = useState<SourceScan | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [acknowledged, setAcknowledged] = useState(false);
  const [sourceBusy, setSourceBusy] = useState(false);
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

  async function scanSources() {
    setSourceState("loading");
    try {
      const response = await fetch("/api/settings/download-recovery/sources", { cache: "no-store" });
      if (response.status === 404) {
        setInfo(null);
        setSourceScan(null);
        setSelectedIds(new Set());
        setSourceOpen(false);
        setSourceState("ready");
        return;
      }
      if (!response.ok) throw new Error("Could not scan other torrent clients");
      const result = await response.json() as SourceScan;
      setSourceScan(result);
      setSelectedIds(new Set(result.candidates.filter((candidate) => !candidate.alreadyImported).map((candidate) => candidate.id)));
      setAcknowledged(false);
      setSourceState("ready");
    } catch {
      setSourceState("error");
      toast.error("Could not scan other torrent clients. Try again.");
    }
  }

  function openSourceImport() {
    setSourceOpen(true);
    void scanSources();
  }

  async function importSources() {
    if (!acknowledged || selectedIds.size === 0 || sourceBusy) return;
    setSourceBusy(true);
    const pending = toast.loading("Importing selected torrents…");
    try {
      const response = await fetch("/api/settings/download-recovery/sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [...selectedIds], acknowledged: true }),
      });
      const result = await response.json() as {
        imported?: number;
        paused?: number;
        skipped?: number;
        failed?: number;
        errors?: string[];
        error?: string;
      };
      if (!response.ok) throw new Error(result.error || result.errors?.[0] || "Could not import selected torrents");
      toast.dismiss(pending);
      const summary = `Imported ${result.imported ?? 0}; paused ${result.paused ?? 0}; skipped ${result.skipped ?? 0}.`;
      if ((result.failed ?? 0) > 0 || (result.errors?.length ?? 0) > 0) {
        toast.warning(`${summary} ${result.failed ?? result.errors?.length ?? 0} could not be imported.`);
      } else {
        toast.success(`${summary} Other client data was left unchanged.`);
      }
      onImported?.();
      await scanSources();
    } catch (cause) {
      toast.dismiss(pending);
      toast.error(cause instanceof Error ? cause.message : "Could not import selected torrents");
    } finally {
      setSourceBusy(false);
    }
  }

  async function importFiles() {
    setBusy(true);
    try {
      const response = await fetch("/api/settings/download-recovery", { method: "POST" });
      const result = await response.json() as { imported?: number; restoredTorrents?: number; failedTorrents?: number; error?: string };
      if (!response.ok) throw new Error(result.error || "Import failed");
      const message = `Imported ${result.imported ?? 0} local files; restored ${result.restoredTorrents ?? 0} torrents.`;
      if (result.failedTorrents) toast.warning(`${message} ${result.failedTorrents} torrents could not start; check their error in Downloads.`);
      else toast.success(`${message} Existing downloads were left unchanged.`);
      onImported?.();
      setRetry((value) => value + 1);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Could not import existing downloads");
    } finally { setBusy(false); }
  }

  const groupedSources = useMemo(() => {
    const groups = new Map<string, SourceCandidate[]>();
    for (const candidate of sourceScan?.candidates ?? []) {
      const group = groups.get(candidate.source) ?? [];
      group.push(candidate);
      groups.set(candidate.source, group);
    }
    return [...groups.entries()];
  }, [sourceScan]);

  if (error) return <div role="status" className="text-xs text-[var(--text-secondary)]">
    Storage details unavailable.{" "}
    <Button type="button" variant="ghost" size="sm" onClick={() => setRetry((value) => value + 1)}>Retry storage details</Button>
  </div>;
  if (!info) return null;
  return <div className="min-w-0 space-y-3 text-xs" data-download-recovery>
    {mode !== "empty" && <dl className="space-y-1 text-[var(--text-secondary)]" data-storage-paths>
      <dt>App data folder</dt>
      <dd className="break-all font-mono">{info.dataDirectory}</dd>
      <dt>Download folder</dt>
      <dd className="break-all font-mono">{info.downloadDirectory || "Not configured — choose and save a folder below."}</dd>
    </dl>}
    {mode !== "paths" && <div className="space-y-2">
      <p className="text-[var(--text-secondary)]">
        {mode === "empty" && info.hasMedia ? "Media files already exist in your download folder. Recover them without downloading again."
          : mode === "empty" ? "Recover downloads already held by another torrent client, or scan your local folder for media."
          : "Recover media already in the saved download folder. Files without torrent metadata are imported as completed, non-seeding downloads."}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" className="min-h-[44px]" disabled={busy || !info.downloadDirectory}
          aria-label="Import existing downloads" data-import-downloads onClick={() => void importFiles()}>
          {busy && <LoadingGlyph className="h-4 w-4" />}
          {busy ? "Scanning and importing…" : "Import existing downloads"}
        </Button>
        <Button type="button" variant="outline" className="min-h-[44px]" aria-label="Import from another torrent client"
          data-import-other-client onClick={openSourceImport}>
          Import from another client
        </Button>
      </div>
    </div>}
    <Dialog open={sourceOpen} onOpenChange={setSourceOpen}>
      <DialogContent className="flex max-h-[95dvh] flex-col gap-4 overflow-hidden p-5 sm:max-w-2xl" data-source-import-panel>
        <DialogHeader className="pr-10">
          <DialogTitle>Import from another torrent client</DialogTitle>
          <DialogDescription>
            Select downloads to add here. Torrent data is never copied or moved, and the other client is never edited.
          </DialogDescription>
        </DialogHeader>
        <div className="shrink-0 rounded-md border border-[var(--border)] bg-[var(--bg-muted)] p-3 text-[var(--text-secondary)]">
          <p><strong className="text-[var(--text)]">Before importing:</strong> close the other client or remove these torrents from it without deleting their data.</p>
          <label className="mt-3 flex min-h-[44px] items-center gap-2 text-[var(--text)]">
            <Checkbox checked={acknowledged} disabled={sourceBusy} onCheckedChange={(checked) => setAcknowledged(checked === true)}
              aria-label="Acknowledge other client is closed or torrents were removed without deleting data" data-source-acknowledgment />
            I understand the other client must be closed or have these torrents removed without deleting data.
          </label>
        </div>
        {sourceState === "loading" && <div role="status" className="flex items-center gap-2 text-[var(--text-secondary)]"><LoadingGlyph className="h-4 w-4" /> Scanning configured torrent clients…</div>}
        {sourceState === "error" && <div role="alert" className="space-y-2 text-[var(--text-secondary)]"><p>Source scan failed.</p><Button type="button" variant="ghost" onClick={() => void scanSources()} data-source-scan-retry>Retry scan</Button></div>}
        {sourceState === "ready" && (
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1" data-source-candidates>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="ghost" disabled={sourceBusy} onClick={() => setSelectedIds(new Set(sourceScan?.candidates.filter(c => !c.alreadyImported).map(c => c.id)))}>Select all</Button>
              <Button type="button" variant="ghost" disabled={sourceBusy} onClick={() => setSelectedIds(new Set())}>Clear selection</Button>
              <Button type="button" variant="ghost" disabled={sourceBusy} onClick={() => void scanSources()}>Scan again</Button>
            </div>
            {sourceScan?.warnings.map((warning, index) => <p key={index} className="break-words rounded-md border border-[var(--accent)]/40 bg-[var(--bg-muted)] p-3 text-[var(--text-secondary)]" data-source-warning>{warning}</p>)}
            {groupedSources.length === 0 && <p className="rounded-md border border-dashed border-[var(--border)] p-4 text-[var(--text-secondary)]">No other-client downloads were found. You can retry the scan or use the local-folder import.</p>}
            {groupedSources.map(([source, candidates]) => (
              <section key={source} className="space-y-2" data-source-group={source}>
                <h3 className="font-medium text-[var(--text)]">{source}</h3>
                {candidates.map((candidate) => (
                  <label key={candidate.id} className="flex gap-3 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] p-3" data-source-candidate={candidate.id}>
                    <Checkbox checked={selectedIds.has(candidate.id)} disabled={sourceBusy || candidate.alreadyImported}
                      onCheckedChange={(checked) => setSelectedIds((current) => {
                        const next = new Set(current);
                        if (checked === true) next.add(candidate.id); else next.delete(candidate.id);
                        return next;
                      })} aria-label={`Select ${candidate.name}`} />
                    <span className="min-w-0 flex-1 space-y-1">
                      <span className="block break-words font-medium text-[var(--text)]">{candidate.name}</span>
                      <span className="block text-[var(--text-secondary)]">{formatBytes(candidate.sizeBytes)} · {candidate.complete ? "Complete (advisory)" : "Partial"} · {candidate.dataExists ? "Data found" : "Data missing"}</span>
                      <span className="block break-all font-mono text-[var(--text-tertiary)]">{candidate.savePath}</span>
                      <span className="block text-[var(--text-tertiary)]">{candidate.dataExists ? "Hash will be rechecked" : "Will import paused until you restore the files or resume"}{candidate.alreadyImported ? " · Already imported" : ""}</span>
                    </span>
                  </label>
                ))}
              </section>
            ))}
          </div>
        )}
        <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-[var(--border)] pt-3">
          <Button type="button" variant="ghost" onClick={() => setSourceOpen(false)} data-source-import-cancel>Cancel</Button>
          <Button type="button" disabled={sourceBusy || !acknowledged || selectedIds.size === 0 || sourceState !== "ready"}
            onClick={() => void importSources()} data-source-import-submit>
            {sourceBusy && <LoadingGlyph className="h-4 w-4" />}
            {sourceBusy ? "Importing…" : `Import selected (${selectedIds.size})`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  </div>;
}
