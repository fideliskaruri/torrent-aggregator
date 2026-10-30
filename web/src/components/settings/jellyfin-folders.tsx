import { useEffect, useState } from "react";
import { Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SkeletonBlock } from "@/components/ui/loading";
import { TfErrorState } from "@/components/tf/error-state";
import {
  saveOptions,
  suggestFolders,
  verifyFolder,
  type JellyfinPathMapping,
  type JellyfinStatus,
} from "@/lib/jellyfin";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

type Row = { key: string; localPath: string; value: string; check: { ok: boolean; message: string } | null };
type Load = { status: "loading" } | { status: "error"; error: string } | { status: "ready" };

const same = (a: string, b: string) => a.replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase();

/** How each storage folder looks from the Jellyfin PC, checked against Jellyfin before saving. */
export function JellyfinFolders({ status, onSaved }: { status: JellyfinStatus; onSaved: (next: JellyfinStatus) => void }) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [rows, setRows] = useState<Row[]>([]);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const mappings = status.pathMappings;

  useEffect(() => {
    let live = true;
    suggestFolders().then((found) => {
      if (!live) return;
      setRows(found.map((item) => {
        const saved = mappings.find((mapping) => same(mapping.from, item.localPath));
        const value = saved?.to ?? item.suggestedJellyfinPath ?? "";
        return {
          key: String(item.rootId),
          localPath: item.localPath,
          value,
          check: item.verified && value === item.suggestedJellyfinPath
            ? { ok: true, message: "Jellyfin can see this folder." } : null,
        };
      }));
      setLoad({ status: "ready" });
    }).catch((error: unknown) => {
      if (live) setLoad({ status: "error", error: error instanceof Error ? error.message : "Could not load your folders." });
    });
    return () => { live = false; };
    // Suggestions are read once per open; saving keeps the rows the owner typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  const update = (key: string, change: Partial<Row>) =>
    setRows((current) => current.map((row) => row.key === key ? { ...row, ...change } : row));

  async function check(row: Row) {
    setBusy(row.key);
    try {
      update(row.key, { check: await verifyFolder(row.localPath, row.value.trim()) });
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    setBusy("save");
    const kept = mappings.filter((mapping) => !rows.some((row) => same(row.localPath, mapping.from)));
    const next: JellyfinPathMapping[] = [...kept, ...rows
      .filter((row) => row.value.trim() !== "" && !same(row.value.trim(), row.localPath))
      .map((row) => ({ from: row.localPath, to: row.value.trim() }))];
    try {
      onSaved(await saveOptions({ pathMappings: next }));
      toast.success("Folders saved.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save folders. Try again.");
    } finally {
      setBusy(null);
    }
  }

  if (load.status === "loading") {
    return <div className="space-y-2" aria-busy="true" aria-label="Loading folders">
      <SkeletonBlock className="h-4 w-48" /><SkeletonBlock className="h-11 w-full" />
    </div>;
  }
  if (load.status === "error") {
    return <TfErrorState title="Could not load your folders" message={load.error} onRetry={() => {
      setLoad({ status: "loading" });
      setAttempt((value) => value + 1);
    }} />;
  }
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground" data-jellyfin-folders-empty>
      Add a storage location first. Its folders show up here.
    </p>;
  }

  const dirty = rows.some((row) => {
    const saved = mappings.find((mapping) => same(mapping.from, row.localPath))?.to ?? "";
    return row.value.trim() !== saved && !(saved === "" && same(row.value.trim(), row.localPath));
  });

  return (
    <div className="space-y-3" data-jellyfin-folders>
      <ul className="space-y-3">
        {rows.map((row) => (
          <li key={row.key} className="space-y-2 rounded-lg border border-border bg-muted/40 p-3" data-jellyfin-folder={row.key}>
            <label htmlFor={`jf-folder-${row.key}`} className="block break-all text-xs text-subtle-foreground">
              Jellyfin sees <span className="font-medium text-foreground">{row.localPath}</span> as
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input id={`jf-folder-${row.key}`} value={row.value} placeholder="\\THISPC\Media" maxLength={2048}
                onChange={(event) => update(row.key, { value: event.target.value, check: null })}
                disabled={busy !== null} className="min-w-0 flex-1" data-jellyfin-folder-input />
              <Button type="button" variant="secondary" disabled={busy !== null || row.value.trim() === ""}
                aria-busy={busy === row.key} onClick={() => void check(row)} data-jellyfin-folder-check>
                {busy === row.key ? "Checking…" : "Check"}
              </Button>
            </div>
            {row.check ? (
              <p role="status" data-jellyfin-folder-result={row.check.ok ? "ok" : "failed"}
                className={cn("flex items-start gap-1.5 text-xs", row.check.ok ? "text-success" : "text-destructive")}>
                {row.check.ok ? <Check aria-hidden className="mt-0.5 size-3.5 shrink-0" /> : <X aria-hidden className="mt-0.5 size-3.5 shrink-0" />}
                {row.check.message}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
      <Button type="button" variant={dirty ? "default" : "secondary"} disabled={!dirty || busy !== null}
        aria-busy={busy === "save"} onClick={() => void save()} data-jellyfin-folders-save>
        {busy === "save" ? "Saving…" : "Save folders"}
      </Button>
    </div>
  );
}
