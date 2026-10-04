import { useCallback, useEffect, useState } from "react";
import { get, send } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SettingsDisclosure } from "./settings-disclosure";
import { readJsonBody } from "@/lib/api-json";
import { toast } from "@/lib/toast";

interface Status {
  serverUrl: string | null;
  userId: string | null;
  configured: boolean;
}

function serverMessage(body: unknown, fallback: string): string {
  const data = (body && typeof body === "object" ? body : {}) as { error?: unknown; message?: unknown; detail?: unknown };
  for (const value of [data.error, data.message, data.detail])
    if (typeof value === "string" && value.trim() && value.length < 200) return value.trim();
  return fallback;
}

export function JellyfinSettings() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [url, setUrl] = useState("");
  const [user, setUser] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const apply = (next: Status) => {
    setStatus(next);
    setUrl(next.serverUrl ?? "");
    setUser(next.userId ?? "");
    setKey("");
  };
  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const response = await get("/api/settings/jellyfin", { cache: "no-store" });
      const body = await readJsonBody<Status>(response);
      if (!response.ok || !body) throw new Error();
      apply(body);
    } catch {
      setError("Could not load Jellyfin settings. Check that TorrentFlow is running, then try again.");
    } finally { setBusy(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const draft = () => ({ serverUrl: url.trim(), userId: user.trim(), ...(key.trim() ? { apiKey: key.trim() } : {}) });

  async function save() {
    setBusy(true);
    setResult(null);
    try {
      const response = await send("/api/settings/jellyfin", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft()),
      });
      const body = await readJsonBody(response);
      if (!response.ok || !body) throw new Error(serverMessage(body, "Could not save. Check the server URL, API key and user, then try again."));
      apply(body as Status);
      toast.success("Jellyfin connected. Watch progress shows on your titles now.");
    } catch (failure) {
      toast.error(failure instanceof Error && failure.message ? failure.message : "Could not save. Try again.");
    } finally { setBusy(false); }
  }

  async function test() {
    setBusy(true);
    setResult(null);
    try {
      const response = await send("/api/settings/jellyfin/test", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft()),
      });
      const body = await readJsonBody<{ ok: boolean; message: string }>(response);
      setResult(response.ok && body ? body
        : { ok: false, message: serverMessage(body, "Could not test the connection. Check the server URL and try again.") });
    } catch {
      setResult({ ok: false, message: "Could not test the connection. Check that TorrentFlow is running, then try again." });
    } finally { setBusy(false); }
  }

  async function disconnect() {
    if (!window.confirm("Disconnect Jellyfin? Watch progress stops showing. Nothing in Jellyfin changes.")) return;
    setBusy(true);
    setResult(null);
    try {
      const response = await send("/api/settings/jellyfin", { method: "DELETE" });
      const body = await readJsonBody<Status>(response);
      if (!response.ok || !body) throw new Error();
      apply(body);
      toast.success("Jellyfin disconnected.");
    } catch {
      toast.error("Could not disconnect Jellyfin. Try again.");
    } finally { setBusy(false); }
  }

  const ready = !!url.trim() && !!user.trim() && (!!key.trim() || !!status?.configured);
  return <SettingsDisclosure id="jellyfin-settings" title="Jellyfin"
    summary={status?.configured ? `Connected to ${status.serverUrl}` : "Optional. Show what you have watched in Jellyfin."}
    open={open} onToggle={() => setOpen(!open)}>
    <div className="min-w-0 space-y-4" data-jellyfin-settings aria-busy={busy}>
      <p className="text-sm text-muted-foreground">
        TorrentFlow only reads watch progress from Jellyfin. It never changes your Jellyfin server.
      </p>
      {!status && busy && <p role="status">Loading Jellyfin settings…</p>}
      <div className="space-y-2">
        <Label htmlFor="jellyfin-url">Server URL</Label>
        <Input id="jellyfin-url" data-jellyfin-url type="url" inputMode="url" placeholder="http://localhost:8096"
          value={url} onChange={(event) => setUrl(event.target.value)} disabled={busy} maxLength={2048} className="w-full min-w-0" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="jellyfin-key">API key</Label>
        <Input id="jellyfin-key" data-jellyfin-key type="password" autoComplete="new-password"
          placeholder={status?.configured ? "Saved. Enter a new key to replace it." : ""}
          value={key} onChange={(event) => setKey(event.target.value)} disabled={busy} maxLength={4096}
          className="w-full min-w-0" aria-describedby="jellyfin-key-help" />
        <p id="jellyfin-key-help" className="text-xs text-subtle-foreground">
          Create one in Jellyfin under Dashboard, API keys. Your saved key is never sent back to this page.
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="jellyfin-user">User ID</Label>
        <Input id="jellyfin-user" data-jellyfin-user value={user} onChange={(event) => setUser(event.target.value)}
          disabled={busy} maxLength={200} className="w-full min-w-0" aria-describedby="jellyfin-user-help" />
        <p id="jellyfin-user-help" className="text-xs text-subtle-foreground">
          The Jellyfin user whose watch progress to show. Find the ID in the address bar of that user's profile page.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" data-jellyfin-save disabled={busy || !ready || !status} onClick={() => void save()}>Save</Button>
        <Button type="button" variant="secondary" data-jellyfin-test disabled={busy || !ready} onClick={() => void test()}>Test</Button>
        <Button type="button" variant="ghost" data-jellyfin-disconnect disabled={busy || !status?.configured}
          onClick={() => void disconnect()}>Disconnect</Button>
      </div>
      {result && <p role="status" data-jellyfin-result
        className={result.ok ? "text-sm text-foreground" : "text-sm text-destructive"}>{result.message}</p>}
      {error && <div role="alert" className="space-y-2 text-sm text-destructive">
        <p>{error}</p>
        <Button type="button" variant="secondary" disabled={busy} onClick={() => void load()}>Retry</Button>
      </div>}
    </div>
  </SettingsDisclosure>;
}
