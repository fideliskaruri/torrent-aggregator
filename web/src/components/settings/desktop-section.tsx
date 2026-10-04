import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { LoadingGlyph, SkeletonBlock } from "@/components/ui/loading";
import { Switch } from "@/components/ui/switch";
import { TfErrorState } from "@/components/tf/error-state";
import { SettingsDisclosure } from "@/components/settings/settings-disclosure";
import { useApiQuery } from "@/hooks/use-api-query";
import {
  DESKTOP_URL,
  checkForUpdatesNow,
  isBusy,
  saveDesktopSettings,
  startUpdate,
  type DesktopStatus,
} from "@/lib/desktop";
import { cn } from "@/lib/utils";
import { DesktopUpdateStatus } from "./desktop-update-status";

export function DesktopSection() {
  const [open, setOpen] = useState(
    () => typeof window !== "undefined" && window.location.hash === "#desktop-app",
  );
  return (
    <SettingsDisclosure
      id="desktop-app"
      title="App"
      summary="Start with Windows and automatic updates."
      open={open}
      onToggle={() => setOpen((value) => !value)}
      className="scroll-mt-20"
    >
      <DesktopPanel />
    </SettingsDisclosure>
  );
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
  const polling = Boolean(status && isBusy(status.updates.install));
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
        <span className="text-xs text-subtle-foreground">Version</span>
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
            <p className="flex items-start gap-2 text-xs text-muted-foreground" role="status">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-foreground" aria-hidden="true" />
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
          <DesktopUpdateStatus
            status={status}
            primary={Boolean(updatePrimary)}
            checking={checking || updates.checking}
            readOnly={readOnly}
            onCheck={() => void checkNow()}
            onUpdate={() => void run(startUpdate)}
          />
        </div>
      ) : (
        <p className="text-xs leading-relaxed text-subtle-foreground" data-desktop-unsupported>
          Start with Windows and automatic updates come with the installed Windows app.
        </p>
      )}


      {message ? (
        <p
          role={message.ok ? "status" : "alert"}
          className={cn("text-xs", message.ok ? "text-muted-foreground" : "text-destructive")}
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
    <Label
      htmlFor={id}
      className={cn(
        "flex min-h-11 items-start justify-between gap-3 rounded-lg border border-border bg-muted/40 p-3 font-normal leading-normal",
        disabled ? "cursor-not-allowed opacity-70" : "cursor-pointer",
      )}
    >
      <span className="min-w-0">
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          {label}
          {busy ? <LoadingGlyph className="h-3.5 w-3.5" /> : null}
        </span>
        <span className="mt-1 block text-xs text-subtle-foreground">{description}</span>
      </span>
      <Switch
        id={id}
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onChange(value === true)}
        className="mt-0.5"
        {...rest}
      />
    </Label>
  );
}
