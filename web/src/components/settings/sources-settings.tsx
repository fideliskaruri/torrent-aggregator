import { useCallback, useEffect, useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { SettingsDisclosure } from "./settings-disclosure";
import { TmdbSettings } from "./tmdb-settings";
import { toast } from "@/lib/toast";
import { readJsonBody } from "@/lib/api-json";
import { cn } from "@/lib/utils";
import { SkeletonBlock } from "@/components/ui/loading";
import { PageQueryBoundary } from "@/components/tf/page-query-boundary";

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
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const fieldId = useId();
  // Only TMDB can be switched on and still be inactive: it is skipped until it
  // has a usable key. The switch alone would say "on", so say what is missing.
  const needsKey = source.enabled && !source.active;
  async function act(action: () => Promise<void>) {
    setBusy(true);
    setTestResult(null);
    try { await action(); }
    catch { toast.error("Could not update source. Check the values and try again."); }
    finally { setBusy(false); }
  }
  async function test() {
    setTestResult(null);
    let response: Response;
    try {
      response = await fetch(`/api/settings/sources/${encodeURIComponent(source.id)}/test`, { method: "POST" });
    } catch (err) {
      const message = err instanceof Error && err.message && !/failed to fetch/i.test(err.message)
        ? err.message : "Couldn't reach TorrentFlow to run the test. Try again.";
      setTestResult({ ok: false, message });
      toast.error(message);
      return;
    }
    const result = await readJsonBody<{ ok?: boolean; message?: string | null; error?: string }>(response);
    if (response.ok && result?.ok) {
      setTestResult({ ok: true, message: "Source responded successfully." });
      toast.success("Source responded successfully.");
      return;
    }
    const message = result?.message?.trim() || result?.error?.trim()
      || "The test did not pass. Check this source's settings and try again.";
    setTestResult({ ok: false, message });
    toast.error(message);
  }
  // A compact row (name, on/off, anything missing) with the full form on
  // demand: twelve always-open forms made this panel thousands of pixels tall.
  return <article className="min-w-0 rounded-lg border border-border" data-source={source.id} aria-busy={busy}>
    <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
      {/* Phones put the name on one line and the controls on the next, so
          every row lines up the same way whether or not it has a badge. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 sm:flex-nowrap sm:px-4">
        <div className="flex min-w-0 basis-full items-center gap-3 sm:basis-auto sm:flex-1">
          <div className="min-w-0 flex-1">
            <h4 className="break-words font-medium">{source.id}</h4>
            <p className="text-xs text-subtle-foreground">{source.type} · Priority {source.priority}</p>
          </div>
          {needsKey && <Badge variant="accent" data-source-status="credential-required">Needs API key</Badge>}
        </div>
        <div className="flex min-h-[44px] items-center gap-2">
          <Switch id={`${fieldId}-enabled`} checked={source.enabled} disabled={busy}
            aria-label={`Enable ${source.id}`} data-source-enable
            onCheckedChange={v => void act(() => update(source.id, { enabled: v === true }))} />
          <Label htmlFor={`${fieldId}-enabled`} className="font-normal">Enabled</Label>
        </div>
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className="group/details -mr-1.5 ml-auto"
            aria-label={`Details for ${source.id}`} data-source-details>
            Details
            <ChevronDown aria-hidden="true"
              className="transition-transform group-data-[state=open]/details:rotate-180 motion-reduce:transition-none" />
          </Button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent className="min-w-0 space-y-4 border-t border-border p-3 sm:p-4">
        <FormField label="Base URL" htmlFor={`${fieldId}-url`}>
          <Input id={`${fieldId}-url`} value={url} onChange={e => setUrl(e.target.value)} aria-label={`${source.id} base URL`} data-source-url
            className="min-w-0" disabled={busy} />
        </FormField>
        <FormField label="Mirrors, one URL per line" htmlFor={`${fieldId}-mirrors`}>
          <Textarea id={`${fieldId}-mirrors`} value={mirrors} onChange={e => setMirrors(e.target.value)} aria-label={`${source.id} mirrors`} data-source-mirrors
            rows={2} disabled={busy} className="min-w-0" />
        </FormField>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <FormField label="Categories" htmlFor={`${fieldId}-categories`}>
            <Input id={`${fieldId}-categories`} value={categories} disabled={busy} onChange={e => setCategories(e.target.value)} aria-label={`${source.id} categories`} />
          </FormField>
          <FormField label="Timeout (milliseconds)" htmlFor={`${fieldId}-timeout`}>
            <Input id={`${fieldId}-timeout`} type="number" min={500} max={60000} value={timeout} disabled={busy} onChange={e => setTimeout(Number(e.target.value))}
              aria-label={`${source.id} timeout`} />
          </FormField>
        </div>
        {source.type === "torznab" && <FormField label={`Indexer API key ${source.credential.hint}`.trim()} htmlFor={`${fieldId}-credential`}>
          <Input id={`${fieldId}-credential`} type="password" autoComplete="new-password" value={credential} disabled={busy}
            onChange={e => setCredential(e.target.value)} aria-label={`${source.id} credential`} />
        </FormField>}
        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={busy} data-source-save aria-label={`Save ${source.id}`} onClick={() => void act(async () => {
            await update(source.id, { baseUrl: url.trim(), mirrors: mirrors.split("\n").map(v => v.trim()).filter(Boolean),
              categories: categories.split(",").map(v => v.trim()).filter(Boolean), timeoutMs: timeout,
              ...(credential ? { credential } : {}) }); setCredential(""); toast.success("Source settings saved.");
          })}>Save</Button>
          <Button type="button" variant="secondary" disabled={busy} data-source-test aria-label={`Test ${source.id}`}
            onClick={() => void act(test)}>Test</Button>
          <Button type="button" variant="ghost" disabled={busy || first} aria-label={`Move ${source.id} up`}
            onClick={() => void act(() => move(source.id, -1))}>↑</Button>
          <Button type="button" variant="ghost" disabled={busy || last} aria-label={`Move ${source.id} down`}
            onClick={() => void act(() => move(source.id, 1))}>↓</Button>
          {source.custom && <Button type="button" variant="ghost" disabled={busy} data-source-remove aria-label={`Remove ${source.id}`}
            onClick={() => { if (window.confirm(`Remove ${source.id}?`)) void act(() => remove(source.id)); }}>Remove</Button>}
        </div>
        {!busy && testResult && <p role={testResult.ok ? "status" : "alert"} data-source-test-result={testResult.ok ? "ok" : "failed"}
          className={`text-sm ${testResult.ok ? "text-success" : "text-destructive"}`}>{testResult.message}</p>}
        {source.type === "tmdb" && <div className="border-t border-border pt-4"><TmdbSettings embedded onChanged={reload} /></div>}
      </CollapsibleContent>
    </Collapsible>
    {/* Announced, not drawn: a line of text appearing under a compact row on
        every switch toggle would make the whole list jump. */}
    {busy && <p role="status" className="sr-only">Updating source…</p>}
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
      <p className="text-sm text-muted-foreground">
        TVmaze, Cinemeta and AniList work without an API key. Turning a source on or off, or moving it, applies
        immediately. Other changes apply when you press Save.
      </p>
      <PageQueryBoundary
        query={{ data: sources, loading: !sources && !error, error: error || null, refetch: () => void load() }}
        errorTitle="Could not load sources"
        refreshErrorTitle="Some sources need attention"
        skeleton={(visible) => (
          <div className={cn("space-y-3", !visible && "invisible")} role="status" aria-label="Loading sources">
            {Array.from({ length: 3 }, (_, i) => <SkeletonBlock key={i} className="h-16 w-full" />)}
          </div>
        )}
      >
      {(loaded) => (["metadata", "torrent"] as const).map(kind => {
        const group = loaded.filter(s => s.kind === kind);
        return <section key={kind} className="space-y-4" aria-label={`${kind} sources`}>
          <h3 className="font-semibold">{kind === "metadata" ? "Metadata" : "Torrent indexers"}</h3>
          {[...new Set(group.map(s => s.categories.join(", ")))].map(category => <div key={category} className="space-y-3">
            <h4 className="text-sm text-muted-foreground first-letter:uppercase">{category}</h4>
            {group.filter(s => s.categories.join(", ") === category).map(source =>
              <SourceCard key={source.id} source={source} update={update} remove={remove} move={move}
                first={group[0]?.id === source.id} last={group.at(-1)?.id === source.id} reload={() => void load()} />)}
          </div>)}
        </section>;
      })}
      </PageQueryBoundary>
      <div className="space-y-3 border-t border-border pt-4" data-add-torznab>
        <h3 className="font-medium">Add a Torznab indexer</h3>
        <p className="text-sm text-muted-foreground">Use the API endpoint from Jackett or Prowlarr. Add the credential after creating the source.</p>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <FormField label="New source id" htmlFor="new-source-id" hint="Lowercase, unique">
            <Input id="new-source-id" aria-label="New source id" placeholder="my-indexer" value={newId} onChange={e => setNewId(e.target.value)} />
          </FormField>
          <FormField label="New Torznab URL" htmlFor="new-torznab-url">
            <Input id="new-torznab-url" aria-label="New Torznab URL" placeholder="http://localhost:9117/api/v2.0/indexers/all/results/torznab/api"
              value={newUrl} onChange={e => setNewUrl(e.target.value)} className="min-w-0" />
          </FormField>
        </div>
        <Button type="button" disabled={adding || !newId || !newUrl} data-source-add onClick={() => {
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
