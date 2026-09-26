import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingsDisclosure } from "./settings-disclosure";
import { TmdbSettings } from "./tmdb-settings";
import { toast } from "@/lib/toast";

interface Source {
  id: string; kind: "torrent" | "metadata"; type: string; categories: string[];
  enabled: boolean; active: boolean; priority: number; baseUrl: string; mirrors: string[];
  timeoutMs: number; custom: boolean; credential: { configured: boolean; hint: string };
}
type Update = (id: string, values: Record<string, unknown>) => Promise<void>;

function SourceCard({ source, update, remove, move, first, last, reload }: {
  source: Source; update: Update; remove: (id: string) => Promise<void>;
  move: (id: string, delta: number) => Promise<void>; first: boolean; last: boolean; reload: () => void;
}) {
  const [url, setUrl] = useState(source.baseUrl);
  const [mirrors, setMirrors] = useState(source.mirrors.join("\n"));
  const [categories, setCategories] = useState(source.categories.join(", "));
  const [timeout, setTimeout] = useState(source.timeoutMs);
  const [credential, setCredential] = useState("");
  const [busy, setBusy] = useState(false);
  async function act(action: () => Promise<void>) {
    setBusy(true);
    try { await action(); }
    catch { toast.error("Could not update source. Check the values and try again."); }
    finally { setBusy(false); }
  }
  async function test() {
    const response = await fetch(`/api/settings/sources/${source.id}/test`, { method: "POST" });
    const result = await response.json();
    if (response.ok && result.ok) toast.success("Source responded successfully.");
    else toast.error("Source did not respond successfully. Check its URL and try again.");
  }
  return <article className="min-w-0 space-y-4 rounded-lg border border-[var(--border)] p-4" data-source={source.id} aria-busy={busy}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0"><h4 className="break-words font-medium">{source.id}</h4>
        <p className="text-xs text-[var(--text-tertiary)]">{source.type} · Priority {source.priority}{!source.active && source.enabled ? " · Credential required" : ""}</p></div>
      <label className="flex min-h-[44px] items-center gap-2 text-sm">
        <input type="checkbox" checked={source.enabled} disabled={busy}
          aria-label={`Enable ${source.id}`} data-source-enable
          onChange={e => void act(() => update(source.id, { enabled: e.target.checked }))} /> Enabled
      </label>
    </div>
    <label className="block space-y-1 text-sm">Base URL
      <Input value={url} onChange={e => setUrl(e.target.value)} aria-label={`${source.id} base URL`} data-source-url
        className="min-h-[44px] min-w-0" disabled={busy} />
    </label>
    <label className="block space-y-1 text-sm">Mirrors — one URL per line
      <textarea value={mirrors} onChange={e => setMirrors(e.target.value)} aria-label={`${source.id} mirrors`} data-source-mirrors
        rows={2} disabled={busy} className="block min-h-[44px] w-full min-w-0 rounded-md border border-[var(--border)] bg-[var(--bg)] p-2 text-sm" />
    </label>
    <div className="grid min-w-0 gap-3 sm:grid-cols-2">
      <label className="block space-y-1 text-sm">Categories
        <Input value={categories} disabled={busy} onChange={e => setCategories(e.target.value)} aria-label={`${source.id} categories`} className="min-h-[44px]" />
      </label>
      <label className="block space-y-1 text-sm">Timeout (milliseconds)
        <Input type="number" min={500} max={60000} value={timeout} disabled={busy} onChange={e => setTimeout(Number(e.target.value))}
          aria-label={`${source.id} timeout`} className="min-h-[44px]" />
      </label>
    </div>
    {source.type === "torznab" && <label className="block space-y-1 text-sm">Indexer API key {source.credential.hint}
      <Input type="password" autoComplete="new-password" value={credential} disabled={busy}
        onChange={e => setCredential(e.target.value)} aria-label={`${source.id} credential`} className="min-h-[44px]" />
    </label>}
    <div className="flex flex-wrap gap-2">
      <Button type="button" disabled={busy} data-source-save className="min-h-[44px]" onClick={() => void act(async () => {
        await update(source.id, { baseUrl: url.trim(), mirrors: mirrors.split("\n").map(v => v.trim()).filter(Boolean),
          categories: categories.split(",").map(v => v.trim()).filter(Boolean), timeoutMs: timeout,
          ...(credential ? { credential } : {}) }); setCredential(""); toast.success("Source settings saved.");
      })}>Save source</Button>
      <Button type="button" variant="secondary" disabled={busy} data-source-test className="min-h-[44px]" onClick={() => void act(test)}>Test</Button>
      <Button type="button" variant="ghost" disabled={busy || first} className="min-h-[44px]" aria-label={`Move ${source.id} up`}
        onClick={() => void act(() => move(source.id, -1))}>↑</Button>
      <Button type="button" variant="ghost" disabled={busy || last} className="min-h-[44px]" aria-label={`Move ${source.id} down`}
        onClick={() => void act(() => move(source.id, 1))}>↓</Button>
      {source.custom && <Button type="button" variant="ghost" disabled={busy} className="min-h-[44px]" data-source-remove
        onClick={() => { if (window.confirm(`Remove ${source.id}?`)) void act(() => remove(source.id)); }}>Remove</Button>}
    </div>
    {source.type === "tmdb" && <div className="border-t border-[var(--border)] pt-4"><TmdbSettings embedded onChanged={reload} /></div>}
    {busy && <p role="status" className="text-sm">Updating source…</p>}
  </article>;
}

export function SourcesSettings() {
  const [open, setOpen] = useState(false);
  const [sources, setSources] = useState<Source[] | null>(null);
  const [error, setError] = useState("");
  const [newId, setNewId] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const load = useCallback(async () => {
    setError("");
    try {
      const response = await fetch("/api/settings/sources", { cache: "no-store" });
      if (!response.ok) throw new Error();
      const body = await response.json();
      setSources(body.sources); setError(body.error ?? "");
    } catch { setError("Could not load sources. Try again."); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const update: Update = async (id, values) => {
    const response = await fetch(`/api/settings/sources/${encodeURIComponent(id)}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values),
    });
    if (!response.ok) throw new Error();
    setSources((await response.json()).sources);
  };
  async function remove(id: string) {
    const response = await fetch(`/api/settings/sources/${id}`, { method: "DELETE" });
    if (!response.ok) throw new Error();
    setSources((await response.json()).sources);
    toast.success("Source removed.");
  }
  async function move(id: string, delta: number) {
    const source = sources!.find(s => s.id === id)!;
    const group = sources!.filter(s => s.kind === source.kind);
    const neighbor = group[group.findIndex(s => s.id === id) + delta];
    if (neighbor) await update(id, { priority: Math.max(0, Math.min(10000, neighbor.priority + delta)) });
  }
  return <SettingsDisclosure id="sources-settings" title="Sources" summary="Keyless metadata, torrent indexers, and optional credentials."
    open={open} onToggle={() => setOpen(!open)}>
    <div className="min-w-0 space-y-6" data-sources-settings>
      <p className="text-sm text-[var(--text-secondary)]">TVmaze, Cinemeta and AniList work without an API key. Changes apply immediately.</p>
      {!sources && !error && <p role="status">Loading sources…</p>}
      {error && <div role="alert"><p className="text-sm text-[var(--danger)]">{error}</p>
        <Button type="button" variant="secondary" className="mt-2 min-h-[44px]" onClick={() => void load()}>Retry</Button></div>}
      {(["metadata", "torrent"] as const).map(kind => {
        const group = sources?.filter(s => s.kind === kind) ?? [];
        return <section key={kind} className="space-y-4" aria-label={`${kind} sources`}>
          <h3 className="font-semibold">{kind === "metadata" ? "Metadata" : "Torrent indexers"}</h3>
          {[...new Set(group.map(s => s.categories.join(", ")))].map(category => <div key={category} className="space-y-3">
            <h4 className="text-sm text-[var(--text-secondary)]">{category}</h4>
            {group.filter(s => s.categories.join(", ") === category).map(source =>
              <SourceCard key={source.id} source={source} update={update} remove={remove} move={move}
                first={group[0]?.id === source.id} last={group.at(-1)?.id === source.id} reload={() => void load()} />)}
          </div>)}
        </section>;
      })}
      <div className="space-y-3 border-t border-[var(--border)] pt-4" data-add-torznab>
        <h3 className="font-medium">Add a Torznab indexer</h3>
        <p className="text-sm text-[var(--text-secondary)]">Use the API endpoint from Jackett or Prowlarr. Add the credential after creating the source.</p>
        <Input aria-label="New source id" placeholder="my-indexer" value={newId} onChange={e => setNewId(e.target.value)} className="min-h-[44px]" />
        <Input aria-label="New Torznab URL" placeholder="http://localhost:9117/api/v2.0/indexers/all/results/torznab/api"
          value={newUrl} onChange={e => setNewUrl(e.target.value)} className="min-h-[44px] min-w-0" />
        <Button type="button" disabled={adding || !newId || !newUrl} className="min-h-[44px]" data-source-add onClick={() => {
          setAdding(true); void update(newId, { kind: "torrent", type: "torznab", baseUrl: newUrl,
            categories: ["movie", "series", "anime"], enabled: true, priority: 50, mirrors: [], timeoutMs: 15000, options: {} })
            .then(() => { setNewId(""); setNewUrl(""); toast.success("Indexer added."); })
            .catch(() => toast.error("Could not add source. Use a unique lowercase id and a valid HTTP(S) URL."))
            .finally(() => setAdding(false));
        }}>Add indexer</Button>
      </div>
    </div>
  </SettingsDisclosure>;
}
