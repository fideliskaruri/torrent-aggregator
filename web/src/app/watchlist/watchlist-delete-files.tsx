import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/tf/confirm-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getDeletePlan, deleteLibraryFiles } from "@/lib/api/watchlist";
import type { DeletePlan, WatchlistItem } from "@/lib/api/watchlist-types";
import { toast } from "@/lib/toast";

type DeleteScope = { kind: "show" } | { kind: "season"; season: number };

function queryFor(item: WatchlistItem, scope: DeleteScope) {
  const query = new URLSearchParams({ watchListItemId: item.id, scope: scope.kind });
  if (scope.kind === "season") query.set("season", String(scope.season));
  return query.toString();
}

export function WatchlistDeleteFiles({ item, onDeleted }: { item: WatchlistItem; onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<DeleteScope>({ kind: "show" });
  const [plan, setPlan] = useState<DeletePlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setPlan(null);
    setError(null);
    void getDeletePlan(queryFor(item, scope)).then((response) => {
      if (!active) return;
      if (!response.ok || !response.data?.ok || !response.data.plan) {
        setError(response.data?.message ?? response.data?.error ?? "Could not check files. Try again.");
        return;
      }
      setPlan(response.data.plan);
    }).catch(() => {
      if (active) setError("Could not reach the server. Check that it is running and try again.");
    });
    return () => { active = false; };
  }, [item.id, open, scope]);

  const season = item.cursorSeason ?? item.fromSeason;
  const scopes: Array<{ value: string; label: string; scope: DeleteScope }> = [{ value: "show", label: "Everything", scope: { kind: "show" } }];
  if (season != null) scopes.push({ value: "season", label: `Season ${season}`, scope: { kind: "season", season } });

  async function confirm() {
    if (!plan || plan.outcome !== "deletes") return;
    setBusy(true);
    try {
      const response = await deleteLibraryFiles({
        watchListItemId: item.id,
        scope: scope.kind,
        ...(scope.kind === "season" ? { season: scope.season } : {}),
        confirm: true,
      });
      if (!response.ok || !response.data?.ok) throw response.error;
      toast.success(response.data.freedFiles ? `Deleted ${response.data.freedFiles} files` : "Removed the source record");
      setOpen(false);
      onDeleted();
    } catch {
      toast.error("Could not delete these files. Nothing else changed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return <>
    <Button type="button" variant="ghost" size="icon-sm" className="text-subtle-foreground hover:text-destructive" aria-label="Delete downloaded files" onClick={() => setOpen(true)} data-delete-files>
      <Trash2 className="size-4" />
    </Button>
    <ConfirmDialog open={open} onOpenChange={setOpen} contentData={{ "data-delete-files-dialog": true }} title="Delete downloaded files?" description={plan?.summary ?? "Review what is on disk before confirming."} variant="destructive" busy={busy} confirmDisabled={plan?.outcome !== "deletes"} confirmLabel={plan?.outcome === "deletes" ? `Delete ${plan.fileCount} file${plan.fileCount === 1 ? "" : "s"}` : plan?.outcome === "nothing-held" ? "Nothing to delete" : "Delete files"} onConfirm={() => void confirm()}>
      {scopes.length > 1 ? <Select value={scope.kind} onValueChange={(value) => {
        const selected = scopes.find((option) => option.value === value);
        if (selected) setScope(selected.scope);
      }}><SelectTrigger aria-label="What to delete"><SelectValue /></SelectTrigger><SelectContent>{scopes.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select> : null}
      <div className="rounded-md border border-border bg-muted/50 px-3 py-2 text-sm" data-delete-plan>
        {error ?? (!plan ? "Checking what is on disk…" : plan.summary)}
        {plan?.releases.length ? <ul className="mt-2 list-inside list-disc text-xs text-subtle-foreground">{plan.releases.map((release) => <li key={release.name}>{release.name}</li>)}</ul> : null}
      </div>
    </ConfirmDialog>
  </>;
}
