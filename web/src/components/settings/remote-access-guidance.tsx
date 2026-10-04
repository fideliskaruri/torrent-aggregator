import { AlertTriangle, CheckCircle2, Lock, RotateCw, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { RemoteAccessCheck, RemoteAccessSettings } from "./remote-access-types";

export function RemoteAccessGuidance({
  settings,
  readOnly,
  check,
  checkError,
}: {
  settings: RemoteAccessSettings;
  readOnly: boolean;
  check: RemoteAccessCheck | null;
  checkError: string | null;
}) {
  return (
    <div className="space-y-3">
      {settings.warnings.length ? (
        <div role="status" data-remote-access-warnings className="flex items-start gap-2 rounded-lg border border-brand/25 bg-brand-dim p-3">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-brand-foreground" aria-hidden="true" />
          <ul className="min-w-0 space-y-0.5 text-xs leading-relaxed text-muted-foreground">
            {settings.warnings.map((warning) => <li key={warning} className="break-words">{warning}</li>)}
          </ul>
        </div>
      ) : null}
      {readOnly ? (
        <div role="status" data-remote-access-readonly className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3">
          <Lock className="mt-0.5 size-4 shrink-0 text-subtle-foreground" aria-hidden="true" />
          <p className="text-xs leading-relaxed text-muted-foreground">
            You're connected remotely, so these settings are read-only. Change them on the computer running TorrentFlow.
          </p>
        </div>
      ) : null}
      {settings.restartRequired ? (
        <div role="status" data-remote-access-restart className="flex items-start gap-2 rounded-lg border border-brand/25 bg-brand-dim p-3">
          <RotateCw className="mt-0.5 size-4 shrink-0 text-brand-foreground" aria-hidden="true" />
          <p className="text-xs leading-relaxed text-muted-foreground">
            <span className="font-medium text-foreground">Restart needed.</span>{" "}
            Turning remote access on or off and changing its port take effect the next time TorrentFlow starts.
          </p>
        </div>
      ) : null}
      {check ? (
        <div role="status" data-remote-access-check className={cn(
          "space-y-1 rounded-lg border p-3 text-xs leading-relaxed",
          check.ok ? "border-success/40 bg-success/5" : "border-brand/25 bg-brand-dim",
        )}>
          <p className="flex items-start gap-2 font-medium text-foreground">
            {check.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" /> :
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-brand-foreground" aria-hidden="true" />}
            {check.ok ? `Ready. Cloudflare published ${check.keyCount ?? 0} signing keys for your team.` : "Not ready yet"}
          </p>
          {check.problems.length ? <ul className="list-disc space-y-0.5 pl-6 text-muted-foreground">
            {check.problems.map((problem) => <li key={problem}>{problem}</li>)}
          </ul> : null}
          {check.keysError ? <p className="break-words pl-6 text-subtle-foreground">{check.keysError}</p> : null}
        </div>
      ) : checkError ? (
        <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
          <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" /><span>{checkError}</span>
        </p>
      ) : null}
    </div>
  );
}
