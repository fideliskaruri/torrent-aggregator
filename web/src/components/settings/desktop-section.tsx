import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, RefreshCw, Wrench } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { LoadingGlyph, SkeletonBlock } from "@/components/ui/loading";
import { Progress } from "@/components/ui/progress";
import { TfErrorState } from "@/components/tf/error-state";
import { SettingsDisclosure } from "@/components/settings/settings-disclosure";
import { useApiQuery } from "@/hooks/use-api-query";
import {
  DESKTOP_URL,
  checkForUpdatesNow,
  formatMegabytes,
  isBusy,
  progressPercent,
  saveDesktopSettings,
  startFfmpegDownload,
  startUpdate,
  type DesktopStatus,
  type DownloadProgress,
} from "@/lib/desktop";
import { cn } from "@/lib/utils";

export function DesktopSection() {
  const [open, setOpen] = useState(
    () => typeof window !== "undefined" && window.location.hash === "#desktop-app",
  );
  return (
    <SettingsDisclosure
      id="desktop-app"
      title="App & media tools"
      summary="Start with Windows, updates, and the ffmpeg tools used for playback checks."
      open={open}
      onToggle={() => setOpen((value) => !value)}
      className="scroll-mt-20"
    >
      <DesktopPanel />
    </SettingsDisclosure>
  );
}

function formatChecked(iso: string | null): string {
  if (!iso) return "Not checked yet";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Not checked yet";
  return `Last checked ${date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;
}

function DesktopPanel() {
  const [busyPoll, setBusyPoll] = useState(false);
  const { data, loading, error, refetch } = useApiQuery<DesktopStatus>(DESKTOP_URL, {
    refreshMs: busyPoll ? 1000 : 60_000,
    emptyOnUnauthorized: false,
  });
  const [saving, setSaving] = useState<"autostart" | "updates" | null>(null);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const status = data;
  const polling = Boolean(status && (isBusy(status.ffmpeg.download) || isBusy(status.updates.install)));
  useEffect(() => {
    setBusyPoll(polling);
  }, [polling]);

  if (error && !status) {
    return (
      <TfErrorState title="Could not load app settings" message={error} onRetry={refetch} />
    );
  }
  if (loading || !status) {
    return (
      <div className="space-y-4" aria-label="Loading app settings" aria-busy="true">
        <SkeletonBlock className="h-4 w-56 max-w-full" />
        <SkeletonBlock className="h-14 w-full" />
        <SkeletonBlock className="h-14 w-full" />
      </div>
    );
  }

  const readOnly = !status.editable;

  async function save(kind: "autostart" | "updates", change: Parameters<typeof saveDesktopSettings>[0]) {
    setSaving(kind);
    setMessage(null);
    try {
      await saveDesktopSettings(change);
      refetch();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : "Save failed" });
    } finally {
      setSaving(null);
    }
  }

  async function checkNow() {
    setChecking(true);
    setMessage(null);
    try {
      const next = await checkForUpdatesNow();
      refetch();
      setMessage(
        next.updates.lastError
          ? { ok: false, text: next.updates.lastError }
          : next.updates.updateAvailable
            ? { ok: true, text: `TorrentFlow ${next.updates.latest?.version} is available.` }
            : { ok: true, text: "You're on the latest version." },
      );
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : "Check failed" });
    } finally {
      setChecking(false);
    }
  }

  async function run(action: () => Promise<void>) {
    setMessage(null);
    try {
      await action();
      setBusyPoll(true);
      refetch();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : "Something went wrong" });
    }
  }

  const updates = status.updates;
  const updatePrimary = status.supported && updates.updateAvailable && updates.latest?.hasInstaller;

  return (
    <div className="space-y-5" data-desktop-settings>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-[var(--text-tertiary)]">Version</span>
        <Badge variant="outline" className="font-mono" data-desktop-version>
          {status.version === "0.0.0" ? "Local build" : status.version}
        </Badge>
      </div>

      {status.supported ? (
        <div className="space-y-3">
          <ToggleRow
            id="desktop-autostart"
            label="Start with Windows"
            description="Opens TorrentFlow in the tray when you sign in, without a browser window."
            checked={status.autostart.enabled}
            disabled={readOnly || saving !== null}
            busy={saving === "autostart"}
            onChange={(checked) => void save("autostart", { startWithWindows: checked })}
            data-desktop-autostart
          />
          {status.autostart.pointsElsewhere ? (
            <p className="flex items-start gap-2 text-xs text-[var(--text-secondary)]" role="status">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--warning)]" aria-hidden="true" />
              The startup entry opens a different copy of TorrentFlow. Turn this off and on to point it here.
            </p>
          ) : null}
          <ToggleRow
            id="desktop-updates"
            label="Check for updates automatically"
            description="Looks for a new release on GitHub once a day."
            checked={updates.enabled}
            disabled={readOnly || saving !== null}
            busy={saving === "updates"}
            onChange={(checked) => void save("updates", { checkForUpdates: checked })}
            data-desktop-updates
          />
          <UpdateStatus
            status={status}
            primary={Boolean(updatePrimary)}
            checking={checking || updates.checking}
            readOnly={readOnly}
            onCheck={() => void checkNow()}
            onUpdate={() => void run(startUpdate)}
          />
        </div>
      ) : (
        <p className="text-xs leading-relaxed text-[var(--text-tertiary)]" data-desktop-unsupported>
          Start with Windows and automatic updates come with the installed Windows app.
        </p>
      )}

      <FfmpegStatus
        status={status}
        primary={!updatePrimary}
        readOnly={readOnly}
        onDownload={() => void run(startFfmpegDownload)}
      />

      {message ? (
        <p
          role={message.ok ? "status" : "alert"}
          className={cn("text-xs", message.ok ? "text-[var(--text-secondary)]" : "text-[var(--danger)]")}
          data-desktop-message
        >
          {message.text}
        </p>
      ) : null}
    </div>
  );
}

function ToggleRow({
  id,
  label,
  description,
  checked,
  disabled,
  busy,
  onChange,
  ...rest
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  busy: boolean;
  onChange: (checked: boolean) => void;
} & Record<`data-${string}`, boolean | string | undefined>) {
  return (
    <label
      htmlFor={id}
      className={cn(
        "flex min-h-11 items-start gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg-muted)]/40 p-3",
        disabled ? "cursor-not-allowed opacity-70" : "cursor-pointer",
      )}
    >
      <Checkbox
        id={id}
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onChange(value === true)}
        {...rest}
      />
      <span className="min-w-0 pt-0.5">
        <span className="flex items-center gap-2 text-sm font-medium text-[var(--text)]">
          {label}
          {busy ? <LoadingGlyph className="h-3.5 w-3.5" /> : null}
        </span>
        <span className="mt-1 block text-xs text-[var(--text-tertiary)]">{description}</span>
      </span>
    </label>
  );
}

function ProgressLine({ progress, label }: { progress: DownloadProgress; label: string }) {
  const pct = progressPercent(progress);
  const installing = progress.state === "installing";
  return (
    <div className="space-y-1.5" role="status" aria-live="polite">
      <div className="flex items-center justify-between gap-3 text-xs text-[var(--text-secondary)]">
        <span className="min-w-0 truncate">{installing ? `Installing ${label}…` : `Downloading ${label}…`}</span>
        {pct !== null && !installing ? <span className="shrink-0 font-mono tabular-nums">{pct}%</span> : null}
      </div>
      <Progress value={installing ? 100 : pct ?? 0} aria-label={`${label} download progress`} />
    </div>
  );
}

function UpdateStatus({
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
    return (
      <p className="text-xs text-[var(--text-tertiary)]" data-desktop-update-status="local">
        This is a local build, so it does not check for updates.
      </p>
    );
  }
  const install = updates.install;
  return (
    <div className="space-y-3 rounded-lg border border-[var(--border)] p-3" data-desktop-update-status>
      {isBusy(install) ? (
        <ProgressLine progress={install} label={`TorrentFlow ${updates.latest?.version ?? ""}`.trim()} />
      ) : (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 space-y-0.5">
            <p className="flex items-center gap-1.5 text-sm text-[var(--text)]">
              {updates.updateAvailable ? (
                <>
                  <Download className="h-4 w-4 shrink-0 text-[var(--accent-text)]" aria-hidden="true" />
                  TorrentFlow {updates.latest?.version} is available
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--success)]" aria-hidden="true" />
                  {updates.lastError ? "Could not check for updates" : "You're up to date"}
                </>
              )}
            </p>
            <p className="text-xs text-[var(--text-tertiary)]">
              {updates.lastError ?? formatChecked(updates.lastCheckedAt)}
            </p>
            {install.state === "failed" && install.error ? (
              <p className="text-xs text-[var(--danger)]" role="alert">{install.error}</p>
            ) : null}
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={onCheck}
              disabled={readOnly || checking}
              aria-label="Check for updates now"
              data-desktop-check
            >
              {checking ? <LoadingGlyph className="h-3.5 w-3.5" /> : <RefreshCw />}
              {checking ? "Checking…" : "Check now"}
            </Button>
            {updates.updateAvailable && updates.latest ? (
              updates.latest.hasInstaller ? (
                <Button
                  type="button"
                  variant={primary ? "default" : "secondary"}
                  size="sm"
                  onClick={onUpdate}
                  disabled={readOnly}
                  aria-label={`Update to TorrentFlow ${updates.latest.version}`}
                  data-desktop-update
                >
                  <Download />
                  Update
                </Button>
              ) : updates.latest.pageUrl ? (
                <Button asChild variant="secondary" size="sm">
                  <a href={updates.latest.pageUrl} target="_blank" rel="noreferrer" data-desktop-release-page>
                    Release page
                  </a>
                </Button>
              ) : null
            ) : null}
          </div>
        </div>
      )}
      {updates.updateAvailable && !isBusy(install) ? (
        <p className="text-xs text-[var(--text-tertiary)]">
          Updating closes TorrentFlow for a moment; downloads resume when it restarts.
        </p>
      ) : null}
    </div>
  );
}

function FfmpegStatus({
  status,
  primary,
  readOnly,
  onDownload,
}: {
  status: DesktopStatus;
  primary: boolean;
  readOnly: boolean;
  onDownload: () => void;
}) {
  const ff = status.ffmpeg;
  const found = Boolean(ff.ffmpeg && ff.ffprobe);
  const busy = isBusy(ff.download);
  const size = formatMegabytes(ff.packageSize);
  return (
    <div className="space-y-3 rounded-lg border border-[var(--border)] p-3" data-desktop-ffmpeg>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <p className="flex items-center gap-1.5 text-sm font-medium text-[var(--text)]">
            <Wrench className="h-4 w-4 shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
            ffmpeg &amp; ffprobe
          </p>
          <p className="text-xs leading-relaxed text-[var(--text-tertiary)]">
            Used to check finished downloads are real video and to read subtitles and audio tracks.
          </p>
        </div>
        <Badge
          variant={found ? "success" : "danger"}
          className="shrink-0 self-start"
          data-desktop-ffmpeg-status={found ? "found" : "missing"}
        >
          {found ? (ff.managed ? "Installed by TorrentFlow" : "Found") : "Missing"}
        </Badge>
      </div>
      {found ? (
        <dl className="grid gap-1 text-xs">
          <PathRow label="ffmpeg" value={ff.ffmpeg!} />
          <PathRow label="ffprobe" value={ff.ffprobe!} />
        </dl>
      ) : null}
      {busy ? <ProgressLine progress={ff.download} label="ffmpeg" /> : null}
      {ff.download.state === "failed" && ff.download.error ? (
        <p className="text-xs text-[var(--danger)]" role="alert" data-desktop-ffmpeg-error>{ff.download.error}</p>
      ) : null}
      {!found && !busy ? (
        ff.canDownload ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="min-w-0 text-xs text-[var(--text-tertiary)]">
              {ff.packageLabel}{size ? ` · ${size}` : ""}, checksum-verified, saved in TorrentFlow's data folder.
            </p>
            <Button
              type="button"
              variant={primary ? "default" : "secondary"}
              size="sm"
              className="shrink-0 self-start sm:self-auto"
              onClick={onDownload}
              disabled={readOnly}
              aria-label="Download ffmpeg"
              data-desktop-ffmpeg-download
            >
              <Download />
              {ff.download.state === "failed" ? "Try again" : "Download ffmpeg"}
            </Button>
          </div>
        ) : (
          <p className="text-xs text-[var(--text-tertiary)]">
            Install ffmpeg with your package manager (it must be on PATH), or set FFMPEG_PATH and FFPROBE_PATH.
          </p>
        )
      ) : null}
    </div>
  );
}

function PathRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 gap-2">
      <dt className="w-14 shrink-0 text-[var(--text-tertiary)]">{label}</dt>
      <dd className="min-w-0 break-all font-mono text-[var(--text-secondary)]">{value}</dd>
    </div>
  );
}
