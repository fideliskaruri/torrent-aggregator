import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingsDisclosure } from "./settings-disclosure";

interface Status {
  configured: boolean;
  source: "settings" | "environment" | "none";
  hint: string;
}

export function TmdbSettings() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/settings/tmdb", { cache: "no-store" });
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
    setError("");
    setMessage("");
    try {
      const response = await fetch(`/api/settings/tmdb${action === "test" ? "/test" : ""}`, {
        method: action === "save" ? "PUT" : action === "test" ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: action === "remove" ? undefined : JSON.stringify(key.trim() ? { apiKey: key } : {}),
      });
      const body = await response.json();
      if (!response.ok) throw new Error("Request failed");
      if (action === "test") {
        setMessage(body.ok ? "TMDB connection works." : body.status === "invalid"
          ? "TMDB rejected this key. Check it and try again." : "TMDB could not be reached. Try again.");
      } else {
        setStatus(body);
        setKey("");
        setMessage(action === "save" ? "TMDB key saved. It is active now." : "Saved TMDB key removed.");
      }
    } catch {
      setError(action === "save" ? "Could not save. Enter a usable TMDB key and try again." : "Could not complete the request. Try again.");
    } finally { setBusy(false); }
  }

  return <SettingsDisclosure id="metadata-settings" title="Metadata"
    summary="Optional TMDB credentials for movie and series details."
    open={open} onToggle={() => setOpen(!open)}>
    <div className="min-w-0 space-y-4" data-tmdb-settings aria-busy={busy}>
      <p className="text-sm text-[var(--text-secondary)]">Optional — AniList and keyless sources work without it.</p>
      {!status && busy && <p role="status">Loading TMDB settings…</p>}
      {status && <p className="text-sm text-[var(--text-secondary)]" data-tmdb-status>
        {status.configured ? `${status.hint} · ${status.source === "settings" ? "Saved in Settings" : "Environment / configuration"}` : "No TMDB key configured."}
      </p>}
      <div className="space-y-2">
        <label htmlFor="tmdb-api-key" className="block text-sm font-medium">TMDB API key</label>
        <Input id="tmdb-api-key" data-tmdb-key type="password" autoComplete="new-password"
          value={key} onChange={(event) => setKey(event.target.value)} disabled={busy}
          maxLength={4096} className="min-h-[44px] w-full min-w-0" aria-describedby="tmdb-help" />
        <p id="tmdb-help" className="text-xs text-[var(--text-tertiary)]">
          Your saved key is never sent back to this page.{" "}
          <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noreferrer"
            data-tmdb-key-link className="underline underline-offset-4">Get a TMDB API key</a>
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" data-tmdb-save disabled={busy || !key.trim() || !status}
          className="min-h-[44px]" onClick={() => void update("save")}>Save</Button>
        <Button type="button" variant="secondary" data-tmdb-test disabled={busy || (!key.trim() && !status?.configured)}
          className="min-h-[44px]" onClick={() => void update("test")}>Test</Button>
        <Button type="button" variant="ghost" data-tmdb-remove disabled={busy || status?.source !== "settings"}
          className="min-h-[44px]" onClick={() => void update("remove")}>Remove</Button>
      </div>
      {busy && status && <p role="status" className="text-sm">Updating TMDB settings…</p>}
      {message && <p role="status" className="text-sm">{message}</p>}
      {error && <div role="alert" className="space-y-2 text-sm text-[var(--danger)]">
        <p>{error}</p>
        <Button type="button" variant="secondary" className="min-h-[44px]" disabled={busy} onClick={() => void load()}>Retry</Button>
      </div>}
    </div>
  </SettingsDisclosure>;
}
