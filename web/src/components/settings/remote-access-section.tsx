import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Globe,
  Lock,
  RotateCw,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { LoadingGlyph, SkeletonBlock } from "@/components/ui/loading";
import { TfErrorState } from "@/components/tf/error-state";
import { SettingsDisclosure } from "@/components/settings/settings-disclosure";
import { sessionAwareFetch } from "@/lib/session-expiry";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

interface RemoteAccessSettings {
  enabled: boolean;
  tunnelPort: number;
  tunnelBindAddress: string;
  teamDomain: string | null;
  audience: string | null;
  ownerEmails: string[];
  allowRequesters: boolean;
  restartRequired: boolean;
  running: {
    enabled: boolean;
    tunnelPort: number;
    tunnelBindAddress: string;
    listening: boolean;
    tunnelUrl: string;
  };
  editable: boolean;
  via: "local" | "tunnel";
  warnings: string[];
}

interface RemoteAccessCheck {
  ok: boolean;
  listening: boolean;
  tunnelUrl: string | null;
  issuer: string | null;
  keyCount: number | null;
  keysError: string | null;
  problems: string[];
}

interface RemoteAccessForm {
  enabled: boolean;
  tunnelPort: number;
  teamDomain: string;
  audience: string;
  ownerEmails: string;
  allowRequesters: boolean;
}

const inputClass = "h-11 scroll-mb-32 text-base sm:text-sm";

function toForm(settings: RemoteAccessSettings): RemoteAccessForm {
  return {
    enabled: settings.enabled,
    tunnelPort: settings.tunnelPort,
    teamDomain: settings.teamDomain ?? "",
    audience: settings.audience ?? "",
    ownerEmails: settings.ownerEmails.join("\n"),
    allowRequesters: settings.allowRequesters !== false,
  };
}

function splitEmails(value: string): string[] {
  return value
    .split(/[\s,;]+/)
    .map((email) => email.trim())
    .filter(Boolean);
}

function tunnelUrl(bindAddress: string, port: number): string {
  const host = bindAddress.includes(":") ? `[${bindAddress}]` : bindAddress;
  return `http://${host}:${port}`;
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {
    // Not JSON; the fallback is all we have.
  }
  return fallback;
}

export function RemoteAccessSection() {
  const [open, setOpen] = useState(
    () => typeof window !== "undefined" && window.location.hash === "#remote-access",
  );
  return (
    <SettingsDisclosure
      id="remote-access"
      title="Remote access"
      summary="Use TorrentFlow from your phone or away from home, signed in through Cloudflare."
      open={open}
      onToggle={() => setOpen((value) => !value)}
      className="scroll-mt-20"
    >
      <RemoteAccessPanel />
    </SettingsDisclosure>
  );
}

function RemoteAccessPanel() {
  const [settings, setSettings] = useState<RemoteAccessSettings | null>(null);
  const [form, setForm] = useState<RemoteAccessForm | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadKey, setLoadKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [check, setCheck] = useState<RemoteAccessCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await sessionAwareFetch("/api/settings/remote-access", {
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(await readError(res, `Request failed (${res.status})`));
        }
        const body = (await res.json()) as RemoteAccessSettings;
        setSettings(body);
        setForm(toForm(body));
        setLoadError(null);
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return;
        setLoadError(
          err instanceof Error ? err.message : "Could not load remote access settings",
        );
      }
    })();
    return () => controller.abort();
  }, [loadKey]);

  const isDirty = useMemo(() => {
    if (!settings || !form) return false;
    const saved = toForm(settings);
    return (
      saved.enabled !== form.enabled ||
      saved.allowRequesters !== form.allowRequesters ||
      saved.tunnelPort !== form.tunnelPort ||
      saved.teamDomain.trim() !== form.teamDomain.trim() ||
      saved.audience.trim() !== form.audience.trim() ||
      splitEmails(saved.ownerEmails).join(",") !==
        splitEmails(form.ownerEmails).join(",")
    );
  }, [settings, form]);

  const runCheck = useCallback(async () => {
    setChecking(true);
    setCheckError(null);
    try {
      const res = await sessionAwareFetch("/api/settings/remote-access/check");
      if (!res.ok) {
        throw new Error(await readError(res, `Check failed (${res.status})`));
      }
      setCheck((await res.json()) as RemoteAccessCheck);
    } catch (err) {
      setCheck(null);
      setCheckError(err instanceof Error ? err.message : "Check failed");
    } finally {
      setChecking(false);
    }
  }, []);

  if (loadError) {
    return (
      <TfErrorState
        title="Could not load remote access settings"
        message={loadError}
        onRetry={() => {
          setLoadError(null);
          setLoadKey((key) => key + 1);
        }}
      />
    );
  }

  if (!settings || !form) {
    return (
      <div className="space-y-4" aria-label="Loading remote access settings" aria-busy="true">
        <SkeletonBlock className="h-4 w-64 max-w-full" />
        <SkeletonBlock className="h-11 w-full" />
        <SkeletonBlock className="h-11 w-full" />
        <SkeletonBlock className="h-24 w-full" />
      </div>
    );
  }

  const readOnly = !settings.editable;
  const port = Number.isFinite(form.tunnelPort) ? form.tunnelPort : settings.tunnelPort;
  const serviceUrl = tunnelUrl(settings.tunnelBindAddress, port);
  const notListening = settings.running.enabled && !settings.running.listening;

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!form || readOnly) return;
    setSaving(true);
    try {
      const res = await sessionAwareFetch("/api/settings/remote-access", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: form.enabled,
          tunnelPort: form.tunnelPort,
          teamDomain: form.teamDomain.trim() || null,
          audience: form.audience.trim() || null,
          ownerEmails: splitEmails(form.ownerEmails),
          allowRequesters: form.allowRequesters,
        }),
      });
      if (!res.ok) throw new Error(await readError(res, `Save failed (${res.status})`));
      const body = (await res.json()) as RemoteAccessSettings;
      setSettings(body);
      setForm(toForm(body));
      setCheck(null);
      toast.success(
        body.restartRequired
          ? "Saved. Restart TorrentFlow to apply the listener change."
          : "Saved. Changes apply right away.",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={(event) => void save(event)}
      className="space-y-5"
      data-remote-access
      aria-describedby="remote-access-intro"
    >
      <div className="flex flex-col items-start gap-2 sm:flex-row sm:justify-between sm:gap-3">
        <p
          id="remote-access-intro"
          className="min-w-0 text-xs leading-relaxed text-[var(--text-tertiary)] sm:flex-1"
        >
          Cloudflare Tunnel carries the connection and Cloudflare Access decides
          who may sign in, so TorrentFlow never stores a password. Only the owner
          emails below get in. Video playback stays on this computer.
        </p>
        <Badge
          variant={notListening ? "danger" : settings.running.enabled ? "success" : "outline"}
          className="shrink-0"
          data-remote-access-status
        >
          {notListening
            ? `Not listening on port ${settings.running.tunnelPort}`
            : settings.running.enabled
              ? `Listening on port ${settings.running.tunnelPort}`
              : "Off"}
        </Badge>
      </div>

      {settings.warnings.length ? (
        <div
          role="status"
          data-remote-access-warnings
          className="flex items-start gap-2 rounded-lg border border-[var(--warning)]/40 bg-[var(--warning)]/5 p-3"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--warning)]" aria-hidden="true" />
          <ul className="min-w-0 space-y-0.5 text-xs leading-relaxed text-[var(--text-secondary)]">
            {settings.warnings.map((warning) => (
              <li key={warning} className="break-words">{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {readOnly ? (
        <div
          role="status"
          data-remote-access-readonly
          className="flex items-start gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-muted)]/40 p-3"
        >
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
          <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
            You're connected remotely, so these settings are read-only. Change them
            on the computer running TorrentFlow — a remote session must never be
            able to widen who can get in.
          </p>
        </div>
      ) : null}

      {settings.restartRequired ? (
        <div
          role="status"
          data-remote-access-restart
          className="flex items-start gap-2 rounded-lg border border-[var(--warning)]/40 bg-[var(--warning)]/5 p-3"
        >
          <RotateCw className="mt-0.5 h-4 w-4 shrink-0 text-[var(--warning)]" aria-hidden="true" />
          <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
            <span className="font-medium text-[var(--text)]">Restart needed.</span>{" "}
            Turning remote access on or off and changing its port take effect the
            next time TorrentFlow starts. Team, AUD tag and owner emails already apply.
          </p>
        </div>
      ) : null}

      <label
        htmlFor="remote-access-enabled"
        className={cn(
          "flex min-h-11 items-start gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg-muted)]/40 p-3",
          readOnly ? "cursor-not-allowed opacity-70" : "cursor-pointer",
        )}
      >
        <Checkbox
          id="remote-access-enabled"
          aria-label="Turn on remote access"
          checked={form.enabled}
          disabled={readOnly}
          onCheckedChange={(checked) =>
            setForm((current) => current && { ...current, enabled: checked === true })
          }
          data-remote-access-enabled
        />
        <span className="pt-0.5">
          <span className="block text-sm font-medium text-[var(--text)]">
            Turn on remote access
          </span>
          <span className="mt-1 block text-xs text-[var(--text-tertiary)]">
            Opens a second listener on this computer for cloudflared only.
          </span>
        </span>
      </label>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor="remote-access-team" className="text-xs font-medium text-[var(--text-secondary)]">
            Team domain
          </label>
          <Input
            id="remote-access-team"
            value={form.teamDomain}
            disabled={readOnly}
            onChange={(event) =>
              setForm((current) => current && { ...current, teamDomain: event.target.value })
            }
            placeholder="myteam.cloudflareaccess.com"
            autoComplete="off"
            spellCheck={false}
            className={inputClass}
            data-remote-access-team
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="remote-access-port" className="text-xs font-medium text-[var(--text-secondary)]">
            Tunnel port
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id="remote-access-port"
              type="number"
              min={1024}
              max={65535}
              step={1}
              inputMode="numeric"
              value={Number.isFinite(form.tunnelPort) ? form.tunnelPort : ""}
              disabled={readOnly}
              onChange={(event) =>
                setForm((current) => current && { ...current, tunnelPort: event.target.valueAsNumber })
              }
              className={cn(inputClass, "max-w-[10rem]")}
              aria-describedby="remote-access-port-help"
              data-remote-access-port
            />
            <span className="text-xs text-[var(--text-tertiary)]">on</span>
            <Input
              id="remote-access-bind"
              value={settings.tunnelBindAddress}
              readOnly
              aria-label="Bind address (set in the settings file)"
              className={cn(inputClass, "w-auto max-w-[12rem] font-mono text-[var(--text-secondary)]")}
              data-remote-access-bind
            />
          </div>
          <p id="remote-access-port-help" className="text-xs text-[var(--text-tertiary)]">
            Not the port you open TorrentFlow on here.
          </p>
        </div>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="remote-access-audience" className="text-xs font-medium text-[var(--text-secondary)]">
          Application Audience (AUD) tag
        </label>
        <Input
          id="remote-access-audience"
          value={form.audience}
          disabled={readOnly}
          onChange={(event) =>
            setForm((current) => current && { ...current, audience: event.target.value })
          }
          placeholder="Copied from the Access application's overview"
          autoComplete="off"
          spellCheck={false}
          className={cn(inputClass, "font-mono")}
          data-remote-access-audience
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="remote-access-owners" className="text-xs font-medium text-[var(--text-secondary)]">
          Owner emails
        </label>
        <textarea
          id="remote-access-owners"
          rows={3}
          value={form.ownerEmails}
          disabled={readOnly}
          onChange={(event) =>
            setForm((current) => current && { ...current, ownerEmails: event.target.value })
          }
          placeholder="you@example.com"
          autoComplete="off"
          spellCheck={false}
          aria-describedby="remote-access-owners-help"
          className="w-full min-w-0 scroll-mb-32 rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-base text-[var(--text)] placeholder:text-[var(--text-tertiary)] focus-visible:border-[var(--primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-dim)] disabled:cursor-not-allowed disabled:opacity-60 sm:text-sm"
          data-remote-access-owners
        />
        <p id="remote-access-owners-help" className="text-xs text-[var(--text-tertiary)]">
          One per line. Everyone else Cloudflare lets in is a requester, or refused if requests are off.
        </p>
      </div>

      <label
        htmlFor="remote-access-requesters"
        className={cn(
          "flex min-h-11 items-start gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg-muted)]/40 p-3",
          readOnly ? "cursor-not-allowed opacity-70" : "cursor-pointer",
        )}
      >
        <Checkbox
          id="remote-access-requesters"
          aria-label="Let friends request titles"
          checked={form.allowRequesters}
          disabled={readOnly}
          onCheckedChange={(checked) =>
            setForm((current) => current && { ...current, allowRequesters: checked === true })
          }
          data-remote-access-requesters
        />
        <span className="pt-0.5">
          <span className="block text-sm font-medium text-[var(--text)]">
            Let friends request titles
          </span>
          <span className="mt-1 block text-xs text-[var(--text-tertiary)]">
            Other signed-in emails can search titles, ask for them and follow their own requests. Nothing else.
          </span>
        </span>
      </label>

      <div className="space-y-3 rounded-lg border border-[var(--border)] p-3" data-remote-access-steps>
        <h3 className="flex items-center gap-2 text-sm font-medium text-[var(--text)]">
          <Globe className="h-4 w-4 text-[var(--text-tertiary)]" aria-hidden="true" />
          Set it up in Cloudflare Zero Trust
        </h3>
        <ol className="list-decimal space-y-2 pl-5 text-xs leading-relaxed text-[var(--text-secondary)]">
          <li>
            Create a tunnel (Networks → Tunnels) and install <code className="font-mono">cloudflared</code> on
            this computer with the command Cloudflare shows.
          </li>
          <li>
            Add a public hostname to the tunnel with the service{" "}
            <code className="break-all font-mono text-[var(--text)]">{serviceUrl}</code>.
          </li>
          <li>
            Create a self-hosted Access application for that hostname, with a policy
            that allows only your email.
          </li>
          <li>
            Paste the team domain and the application's AUD tag here, add your email,
            turn on remote access, save, and restart TorrentFlow.
          </li>
        </ol>
      </div>

      <div className="space-y-2" aria-live="polite">
        {check ? (
          <div
            role="status"
            data-remote-access-check
            className={cn(
              "space-y-1 rounded-lg border p-3 text-xs leading-relaxed",
              check.ok
                ? "border-[var(--success)]/40 bg-[var(--success)]/5"
                : "border-[var(--warning)]/40 bg-[var(--warning)]/5",
            )}
          >
            <p className="flex items-start gap-2 font-medium text-[var(--text)]">
              {check.ok ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--success)]" aria-hidden="true" />
              ) : (
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--warning)]" aria-hidden="true" />
              )}
              {check.ok
                ? `Ready. Cloudflare published ${check.keyCount ?? 0} signing key${check.keyCount === 1 ? "" : "s"} for your team.`
                : "Not ready yet"}
            </p>
            {check.problems.length ? (
              <ul className="list-disc space-y-0.5 pl-6 text-[var(--text-secondary)]">
                {check.problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            ) : null}
            {check.keysError ? (
              <p className="break-words pl-6 text-[var(--text-tertiary)]">{check.keysError}</p>
            ) : null}
          </div>
        ) : checkError ? (
          <p role="alert" className="flex items-start gap-2 text-sm text-[var(--danger)]">
            <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{checkError}</span>
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="secondary"
          onClick={() => void runCheck()}
          disabled={checking}
          data-remote-access-run-check
        >
          {checking ? <LoadingGlyph /> : null}
          {checking ? "Checking Cloudflare…" : "Check setup"}
        </Button>
        {!readOnly ? (
          <Button type="submit" disabled={saving || !isDirty} data-remote-access-save>
            {saving ? <LoadingGlyph /> : null}
            Save remote access
          </Button>
        ) : null}
      </div>
    </form>
  );
}
