import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { AlertTriangle, CheckCircle2, Lock, RotateCw } from "lucide-react";
import { get, send } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadingGlyph, SkeletonBlock } from "@/components/ui/loading";
import { TfErrorState } from "@/components/tf/error-state";
import { SettingsDisclosure } from "@/components/settings/settings-disclosure";
import { toast } from "@/lib/toast";
import { RemoteAccessFields } from "./remote-access-fields";
import { RemoteAccessGuidance } from "./remote-access-guidance";
import type {
  RemoteAccessCheck,
  RemoteAccessForm,
  RemoteAccessSettings,
} from "./remote-access-types";

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
  return value.split(/[\s,;]+/).map((email) => email.trim()).filter(Boolean);
}

function tunnelUrl(bindAddress: string, port: number): string {
  const host = bindAddress.includes(":") ? `[${bindAddress}]` : bindAddress;
  return `http://${host}:${port}`;
}

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {
    return fallback;
  }
  return fallback;
}

export function RemoteAccessSection() {
  const [open, setOpen] = useState(
    () => typeof window !== "undefined" && window.location.hash === "#remote-access",
  );
  return (
    <SettingsDisclosure id="remote-access" title="Remote access"
      summary="Use TorrentFlow away from home through Cloudflare." open={open}
      onToggle={() => setOpen((value) => !value)} className="scroll-mt-20">
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
        const response = await get<RemoteAccessSettings>("/api/settings/remote-access", {
          signal: controller.signal,
        });
        if (!response.ok || !response.data) {
          throw new Error(await readError(response, `Request failed (${response.status})`));
        }
        setSettings(response.data);
        setForm(toForm(response.data));
        setLoadError(null);
      } catch (error) {
        if ((error as Error)?.name === "AbortError") return;
        setLoadError(error instanceof Error ? error.message : "Could not load remote access settings.");
      }
    })();
    return () => controller.abort();
  }, [loadKey]);

  const isDirty = useMemo(() => {
    if (!settings || !form) return false;
    const saved = toForm(settings);
    return saved.enabled !== form.enabled ||
      saved.allowRequesters !== form.allowRequesters ||
      saved.tunnelPort !== form.tunnelPort ||
      saved.teamDomain.trim() !== form.teamDomain.trim() ||
      saved.audience.trim() !== form.audience.trim() ||
      splitEmails(saved.ownerEmails).join(",") !== splitEmails(form.ownerEmails).join(",");
  }, [settings, form]);

  const runCheck = useCallback(async () => {
    setChecking(true);
    setCheckError(null);
    try {
      const response = await get<RemoteAccessCheck>("/api/settings/remote-access/check");
      if (!response.ok || !response.data) {
        throw new Error(await readError(response, `Check failed (${response.status})`));
      }
      setCheck(response.data);
    } catch (error) {
      setCheck(null);
      setCheckError(error instanceof Error ? error.message : "Check failed");
    } finally {
      setChecking(false);
    }
  }, []);

  if (loadError) {
    return <TfErrorState title="Could not load remote access settings" message={loadError}
      onRetry={() => { setLoadError(null); setLoadKey((key) => key + 1); }} />;
  }
  if (!settings || !form) {
    return (
      <div className="space-y-4" aria-label="Loading remote access settings" aria-busy="true">
        <SkeletonBlock className="h-4 w-64 max-w-full" />
        <SkeletonBlock className="h-11 w-full" />
        <SkeletonBlock className="h-24 w-full" />
      </div>
    );
  }

  const readOnly = !settings.editable;
  const notListening = settings.running.enabled && !settings.running.listening;
  const port = Number.isFinite(form.tunnelPort) ? form.tunnelPort : settings.tunnelPort;
  const serviceUrl = tunnelUrl(settings.tunnelBindAddress, port);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (readOnly || !form) return;
    setSaving(true);
    try {
      const response = await send<RemoteAccessSettings>("/api/settings/remote-access", {
        method: "PUT",
        body: {
          enabled: form.enabled,
          tunnelPort: form.tunnelPort,
          teamDomain: form.teamDomain.trim() || null,
          audience: form.audience.trim() || null,
          ownerEmails: splitEmails(form.ownerEmails),
          allowRequesters: form.allowRequesters,
        },
      });
      if (!response.ok || !response.data) {
        throw new Error(await readError(response, `Save failed (${response.status})`));
      }
      setSettings(response.data);
      setForm(toForm(response.data));
      setCheck(null);
      toast.success(response.data.restartRequired
        ? "Saved. Restart TorrentFlow to apply the listener change."
        : "Saved. Changes apply right away.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save remote access settings.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(event) => void save(event)} className="space-y-5" data-remote-access aria-describedby="remote-access-intro">
      <div className="flex flex-col items-start gap-2 sm:flex-row sm:justify-between sm:gap-3">
        <p id="remote-access-intro" className="min-w-0 text-xs leading-relaxed text-subtle-foreground sm:flex-1">
          Cloudflare Tunnel carries the connection and Cloudflare Access decides who may sign in, so TorrentFlow never stores a password.
        </p>
        <Badge variant={notListening ? "danger" : settings.running.enabled ? "success" : "outline"} className="shrink-0" data-remote-access-status>
          {notListening ? `Not listening on port ${settings.running.tunnelPort}` :
            settings.running.enabled ? `Listening on port ${settings.running.tunnelPort}` : "Off"}
        </Badge>
      </div>
      <RemoteAccessGuidance settings={settings} readOnly={readOnly} check={check} checkError={checkError} />
      <RemoteAccessFields
        settings={settings}
        form={form}
        readOnly={readOnly}
        serviceUrl={serviceUrl}
        onChange={(patch) => setForm((current) => current ? { ...current, ...patch } : current)}
      />
      <div className="flex flex-wrap justify-end gap-2" aria-live="polite">
        <Button type="button" variant="secondary" onClick={() => void runCheck()} disabled={checking} data-remote-access-run-check>
          {checking ? <LoadingGlyph /> : null}{checking ? "Checking Cloudflare…" : "Check setup"}
        </Button>
        {!readOnly ? (
          <Button type="submit" disabled={saving || !isDirty} data-remote-access-save>
            {saving ? <LoadingGlyph /> : null}Save remote access
          </Button>
        ) : null}
      </div>
    </form>
  );
}
