import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TfEmptyState } from "@/components/tf/empty-state";
import { TfErrorState } from "@/components/tf/error-state";
import { LoadingGlyph } from "@/components/ui/loading";
import { formatBytes, formatDuration } from "@/lib/utils";
import { toast } from "@/lib/toast";
import type { ClientTorrent } from "./types";

interface Alternative {
  token: string; hash: string; title: string; seeders: number; peers: number;
  sizeBytes: number | null; quality: number | null; source: string; why: string;
}
interface Alternatives {
  health: { connectedSeeders: number | null; connectedPeers: number | null; downloadBytesPerSecond: number; stalledForSeconds: number; state: string };
  alternatives: Alternative[];
}

export function ReleaseSwapDialog({ torrent, onClose, onSwapped }: {
  torrent: ClientTorrent; onClose: () => void; onSwapped: () => void;
}) {
  const [data, setData] = useState<Alternatives | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [using, setUsing] = useState<string | null>(null);
  const endpoint = `/api/client/torrents/${encodeURIComponent(torrent.hash)}/alternatives`;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(null); setData(null);
    void (async () => {
      try {
        const response = await fetch(endpoint, { signal: controller.signal });
        const body = await response.json();
        if (!response.ok) throw new Error(body.message || "Could not find releases.");
        if (!controller.signal.aborted) setData(body as Alternatives);
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Could not find releases.");
      } finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, [endpoint, retry]);

  async function swap(candidate: Alternative) {
    setUsing(candidate.hash);
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: candidate.token }) });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.message || "Could not replace this release.");
      toast.success("Using the new release");
      onSwapped();
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : "Could not replace this release.");
    } finally { setUsing(null); }
  }

  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="flex max-h-[90dvh] min-w-0 flex-col sm:max-w-2xl" data-release-swap>
      <DialogHeader className="shrink-0 pr-8">
        <DialogTitle>Find another release</DialogTitle>
        <DialogDescription className="break-words">
          Replace this download with the same movie or episode. Using another release removes the old release&apos;s partial files.
          Completed files and other downloads stay untouched.
        </DialogDescription>
      </DialogHeader>
      <div className="min-h-0 space-y-4 overflow-y-auto">
        <p className="break-words text-sm text-[var(--text-secondary)]">{torrent.name}</p>
        {loading ? <div role="status" className="flex min-h-32 items-center justify-center gap-3"><LoadingGlyph /> Searching for other releases…</div>
          : error ? <TfErrorState title="Could not find releases" message={error} onRetry={() => setRetry((n) => n + 1)} />
          : data ? <>
            <p className="rounded-lg bg-[var(--bg-muted)] p-3 text-sm" data-release-health>
              Current: {data.health.connectedSeeders ?? "Unknown"} seeders · {data.health.connectedPeers ?? 0} connected peers · {formatBytes(data.health.downloadBytesPerSecond)}/s
              {data.health.stalledForSeconds > 0 ? ` · No progress observed for ${formatDuration(data.health.stalledForSeconds)}` : ` · ${data.health.state}`}
            </p>
            {data.alternatives.length === 0 ? <div>
              <TfEmptyState title="No other matching releases yet" description="The current and previously tried releases are excluded. Try again later, or keep this download." />
              <Button variant="secondary" className="mt-3 min-h-[44px]" onClick={() => setRetry((n) => n + 1)} data-release-retry>Search again</Button>
            </div> : <ul className="space-y-3">
              {data.alternatives.map((candidate) => <li key={candidate.hash} className="space-y-2 rounded-lg border border-[var(--border)] p-3" data-release-candidate>
                <p className="break-words text-sm font-medium">{candidate.title}</p>
                <p className="text-xs text-[var(--text-secondary)]">
                  {candidate.quality ? `${candidate.quality}p` : "Unknown quality"} · {candidate.sizeBytes ? formatBytes(candidate.sizeBytes) : "Unknown size"} · {candidate.source}
                </p>
                <p className="text-xs text-[var(--text-secondary)]">{candidate.seeders} seeders · {candidate.peers} leechers · {candidate.why}</p>
                <Button variant="secondary" className="min-h-[44px] w-full sm:w-auto" disabled={using !== null}
                  onClick={() => void swap(candidate)} aria-label={`Use ${candidate.title}`} data-use-release>
                  {using === candidate.hash ? "Replacing release…" : "Use this one"}
                </Button>
              </li>)}
            </ul>}
          </> : null}
      </div>
      <Button variant="ghost" className="min-h-[44px] shrink-0" onClick={onClose}>Close</Button>
    </DialogContent>
  </Dialog>;
}
