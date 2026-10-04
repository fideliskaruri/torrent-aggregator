import { CheckCircle2, Download, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LoadingGlyph } from "@/components/ui/loading";
import { Progress } from "@/components/ui/progress";
import { isBusy, progressPercent, type DesktopStatus, type DownloadProgress } from "@/lib/desktop";

function formatChecked(iso: string | null): string {
  if (!iso) return "Not checked yet";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Not checked yet";
  return `Last checked ${date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;
}

function ProgressLine({ progress, label }: { progress: DownloadProgress; label: string }) {
  const percent = progressPercent(progress);
  const installing = progress.state === "installing";
  return (
    <div className="space-y-1.5" role="status" aria-live="polite">
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span className="min-w-0 truncate">{installing ? `Installing ${label}…` : `Downloading ${label}…`}</span>
        {percent !== null && !installing ? <span className="shrink-0 font-mono tabular-nums">{percent}%</span> : null}
      </div>
      <Progress value={installing ? 100 : percent ?? 0} aria-label={`${label} download progress`} />
    </div>
  );
}

export function DesktopUpdateStatus({
  status,
  primary,
  checking,
  readOnly,
  onCheck,
  onUpdate,
}: {
  status: DesktopStatus;
  primary: boolean;
  checking: boolean;
  readOnly: boolean;
  onCheck: () => void;
  onUpdate: () => void;
}) {
  const updates = status.updates;
  if (!updates.available) {
    return <p className="text-xs text-subtle-foreground" data-desktop-update-status="local">This is a local build, so it does not check for updates.</p>;
  }
  const install = updates.install;
  return (
    <div className="space-y-3 rounded-lg border border-border p-3" data-desktop-update-status>
      {isBusy(install) ? (
        <ProgressLine progress={install} label={`TorrentFlow ${updates.latest?.version ?? ""}`.trim()} />
      ) : (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 space-y-0.5">
            <p className="flex items-center gap-1.5 text-sm text-foreground">
              {updates.updateAvailable ? (
                <><Download className="size-4 shrink-0 text-brand-foreground" aria-hidden="true" />TorrentFlow {updates.latest?.version} is available</>
              ) : (
                <><CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden="true" />{updates.lastError ? "Could not check for updates" : "You're up to date"}</>
              )}
            </p>
            <p className="text-xs text-subtle-foreground">{updates.lastError ?? formatChecked(updates.lastCheckedAt)}</p>
            {install.state === "failed" && install.error ? <p className="text-xs text-destructive" role="alert">{install.error}</p> : null}
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={onCheck} disabled={readOnly || checking}
              aria-label="Check for updates now" data-desktop-check>
              {checking ? <LoadingGlyph className="size-4" /> : <RefreshCw />}
              {checking ? "Checking…" : "Check now"}
            </Button>
            {updates.updateAvailable && updates.latest ? (
              updates.latest.hasInstaller ? (
                <Button type="button" variant={primary ? "default" : "secondary"} size="sm" onClick={onUpdate}
                  disabled={readOnly} aria-label={`Update to TorrentFlow ${updates.latest.version}`} data-desktop-update>
                  <Download />Update
                </Button>
              ) : updates.latest.pageUrl ? (
                <Button asChild variant="secondary" size="sm">
                  <a href={updates.latest.pageUrl} target="_blank" rel="noreferrer" data-desktop-release-page>Release page</a>
                </Button>
              ) : null
            ) : null}
          </div>
        </div>
      )}
      {updates.updateAvailable && !isBusy(install) ? (
        <p className="text-xs text-subtle-foreground">Updating closes TorrentFlow for a moment; downloads resume when it restarts.</p>
      ) : null}
    </div>
  );
}
