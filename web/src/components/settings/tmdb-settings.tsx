import { useCallback, useEffect, useState } from "react";
import { get, send } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SettingsDisclosure } from "./settings-disclosure";
import { toast } from "@/lib/toast";

interface Status {
  configured: boolean;
  source: "settings" | "environment" | "none";
  hint: string;
}

export function TmdbSettings({ embedded = false, onChanged }: { embedded?: boolean; onChanged?: () => void }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const response = await get("/api/settings/tmdb", { cache: "no-store" });
      if (!response.ok) throw new Error("Could not load TMDB settings.");
      setStatus(await response.json());
    } catch {
      setError("Could not load TMDB settings. Try again.");
    } finally { setBusy(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function update(action: "save" | "test" | "remove") {
    if (action === "remove" && !window.confirm("Remove the saved TMDB key? Any environment key will be used instead.")) return;
    setBusy(true);
    try {
      const response = await send(`/api/settings/tmdb${action === "test" ? "/test" : ""}`, {
        method: action === "save" ? "PUT" : action === "test" ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: action === "remove" ? undefined : JSON.stringify(key.trim() ? { apiKey: key } : {}),
      });
      const body = await response.json();
      if (!response.ok) throw new Error("Request failed");
      if (action === "test") {
        if (body.ok) toast.success("TMDB connection works.");
        else toast.error(body.status === "invalid"
          ? "TMDB rejected this key. Check it and try again." : "TMDB could not be reached. Try again.");
      } else {
        setStatus(body);
        setKey("");
        onChanged?.();
        toast.success(action === "save" ? "TMDB key saved. It is active now." : "Saved TMDB key removed.");
      }
    } catch {
      toast.error(action === "save" ? "Could not save. Enter a usable TMDB key and try again." : "Could not complete the request. Try again.");
    } finally { setBusy(false); }
  }

  const content = <div className="min-w-0 space-y-4" data-tmdb-settings aria-busy={busy}>
      <p className="text-sm text-muted-foreground">Optional. AniList and keyless sources work without it.</p>
      {!status && busy && <p role="status">Loading TMDB settings…</p>}
      {status && <p className="text-sm text-muted-foreground" data-tmdb-status>
        {status.configured ? `${status.hint} · ${status.source === "settings" ? "Saved in Settings" : "Environment / configuration"}` : "No TMDB key configured."}
      </p>}
      <div className="space-y-2">
        <Label htmlFor="tmdb-api-key">TMDB API key</Label>
        <Input id="tmdb-api-key" data-tmdb-key type="password" autoComplete="new-password"
          value={key} onChange={(event) => setKey(event.target.value)} disabled={busy}
          maxLength={4096} className="w-full min-w-0" aria-describedby="tmdb-help" />
        <p id="tmdb-help" className="text-xs text-subtle-foreground">
          Your saved key is never sent back to this page.{" "}
          <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noreferrer"
            data-tmdb-key-link className="underline underline-offset-4">Get a TMDB API key</a>
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" data-tmdb-save aria-label="Save TMDB key" disabled={busy || !key.trim() || !status}
          onClick={() => void update("save")}>Save</Button>
        <Button type="button" variant="secondary" data-tmdb-test aria-label="Test TMDB key" disabled={busy || (!key.trim() && !status?.configured)}
          onClick={() => void update("test")}>Test</Button>
        <Button type="button" variant="ghost" data-tmdb-remove aria-label="Remove saved TMDB key" disabled={busy || status?.source !== "settings"}
          onClick={() => void update("remove")}>Remove</Button>
      </div>
      {busy && status && <p role="status" className="text-sm">Updating TMDB settings…</p>}
      {error && <div role="alert" className="space-y-2 text-sm text-destructive">
        <p>{error}</p>
        <Button type="button" variant="secondary" disabled={busy} onClick={() => void load()}>Retry</Button>
      </div>}
    </div>;
  return embedded ? content : <SettingsDisclosure id="metadata-settings" title="Metadata"
    summary="Optional TMDB credentials for movie and series details."
    open={open} onToggle={() => setOpen(!open)}>{content}</SettingsDisclosure>;
}
