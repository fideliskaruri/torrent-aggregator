import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useMediaQuery } from "@/hooks/use-media-query";
import { formatBytes } from "@/lib/format";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { PlaybackUncheckedNote } from "@/components/tf/playback-unchecked-note";
import { PlaybackUncheckedError } from "@/lib/api/delete-refusal";
import {
  deleteCleanupItem,
  listCleanup,
  type CleanupAvailability,
  type CleanupItem,
  type CleanupScope,
} from "@/lib/api/storage";

type CleanupState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; jellyfin: CleanupAvailability; needsAdmin: boolean; message: string | null; items: CleanupItem[] };

const SCOPES: { scope: CleanupScope; label: string }[] = [
  { scope: "watched", label: "Watched episodes" },
  { scope: "whole", label: "Whole show" },
];

function freedBytes(item: CleanupItem, scope: CleanupScope) {
  return item.kind === "series" && scope === "watched" ? item.watchedBytes : item.bytes;
}

function watchedLabel(item: CleanupItem) {
  if (item.watched === "movie") return "Watched";
  const { played, total } = item.watched;
  return played >= total ? `All ${total} episodes watched` : `${played} of ${total} episodes watched`;
}

function canSelect(item: CleanupItem, scope: CleanupScope) {
  return item.deletable && freedBytes(item, scope) > 0;
}

export function CleanupSheet({
  open,
  onOpenChange,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}) {
  const isPhone = useMediaQuery("(max-width: 767px)");
  const [state, setState] = useState<CleanupState>({ status: "loading" });
  const [scope, setScope] = useState<CleanupScope>("watched");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [retry, setRetry] = useState<{ message: string; items: CleanupItem[] } | null>(null);

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const data = await listCleanup();
      setState({
        status: "ready",
        jellyfin: data.jellyfin,
        needsAdmin: data.needsAdmin === true,
        message: data.message ?? null,
        items: data.items,
      });
    } catch (error) {
      setState({ status: "error", message: (error as Error).message });
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setSelected(new Set());
    void load();
  }, [open, load]);

  const items = state.status === "ready" ? state.items : [];
  const chosen = useMemo(
    () => items.filter((item) => selected.has(item.workId) && canSelect(item, scope)),
    [items, selected, scope],
  );
  const total = chosen.reduce((sum, item) => sum + freedBytes(item, scope), 0);
  const hasSeries = items.some((item) => item.kind === "series");

  function toggle(workId: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(workId);
      else next.delete(workId);
      return next;
    });
  }

  async function remove(list: CleanupItem[] = chosen, deleteAnyway = false) {
    setDeleting(true);
    const failed: string[] = [];
    const unchecked: CleanupItem[] = [];
    let uncheckedMessage = "";
    let freed = 0;
    let done = 0;
    for (const item of list) {
      try {
        const result = await deleteCleanupItem(item, scope, deleteAnyway);
        freed += result.freedBytes;
        if (result.failedFiles > 0)
          failed.push(`Some files in ${item.title} could not be deleted. Close any player using them and try again.`);
        else done += 1;
      } catch (error) {
        if (error instanceof PlaybackUncheckedError) {
          unchecked.push(item);
          uncheckedMessage = error.message;
        } else failed.push((error as Error).message);
      }
    }
    setDeleting(false);
    if (unchecked.length > 0) setRetry({ message: uncheckedMessage, items: unchecked });
    else {
      setConfirming(false);
      setRetry(null);
    }
    if (done > 0 || freed > 0)
      toast.success(`Freed ${formatBytes(freed) ?? "0 B"}${done > 0 ? ` from ${done} ${done === 1 ? "title" : "titles"}` : ""}.`);
    if (failed.length > 0) toast.error(failed.join(" "));
    if (done > 0 || freed > 0 || failed.length > 0) {
      onDeleted?.();
      void load();
    }
    setSelected(new Set(unchecked.map((item) => item.workId)));
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={isPhone ? "bottom" : "right"}
        className={cn("gap-0 p-0", isPhone ? "max-h-[85dvh] rounded-t-xl" : "w-full sm:max-w-md")}
        data-cleanup-sheet
      >
        <SheetHeader className="border-b border-border p-4">
          <SheetTitle>Free up space</SheetTitle>
          <SheetDescription>Titles you have watched in Jellyfin. Pick what to delete from disk.</SheetDescription>
        </SheetHeader>

        {state.status === "ready" && hasSeries && state.jellyfin === "ok" ? (
          <div className="border-b border-border px-4 py-3">
            <div role="radiogroup" aria-label="For series, delete" className="flex gap-1 rounded-lg bg-muted p-1">
              {SCOPES.map((option) => (
                <button
                  key={option.scope}
                  type="button"
                  role="radio"
                  aria-checked={scope === option.scope}
                  onClick={() => setScope(option.scope)}
                  className={cn(
                    "min-h-11 flex-1 rounded-md px-3 text-sm transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none sm:min-h-9",
                    scope === option.scope ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <CleanupBody state={state} scope={scope} selected={selected} onToggle={toggle} onRetry={() => void load()} />
        </div>

        {items.length > 0 ? (
          <SheetFooter className="flex-row items-center justify-between gap-3 border-t border-border p-4">
            <p className="text-sm tabular-nums text-muted-foreground" aria-live="polite">
              {chosen.length > 0 ? `${formatBytes(total) ?? "0 B"} from ${chosen.length} selected` : "Nothing selected"}
            </p>
            <Button type="button" variant="destructive" disabled={chosen.length === 0} onClick={() => setConfirming(true)}>
              Delete
            </Button>
          </SheetFooter>
        ) : null}
      </SheetContent>

      <AlertDialog
        open={confirming}
        onOpenChange={(value) => {
          if (deleting) return;
          setConfirming(value);
          if (!value) setRetry(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {retry
                ? `Delete ${retry.items.length === 1 ? retry.items[0].title : `${retry.items.length} titles`} anyway?`
                : `Delete ${chosen.length} ${chosen.length === 1 ? "title" : "titles"}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {retry
                ? retry.items.length === 1 ? "Nothing has been deleted yet." : "Nothing has been deleted for these titles yet."
                : `This removes ${formatBytes(total)} of files from disk. You can download them again later.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {retry ? <PlaybackUncheckedNote message={retry.message} /> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleting}
              onClick={(event) => {
                event.preventDefault();
                void (retry ? remove(retry.items, true) : remove());
              }}
            >
              {deleting ? "Deleting…" : retry ? "Delete anyway" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  );
}

function CleanupBody({
  state,
  scope,
  selected,
  onToggle,
  onRetry,
}: {
  state: CleanupState;
  scope: CleanupScope;
  selected: Set<string>;
  onToggle: (workId: string, checked: boolean) => void;
  onRetry: () => void;
}) {
  if (state.status === "loading") return <p className="p-4 text-sm text-subtle-foreground">Checking what you have watched…</p>;

  if (state.status === "error")
    return (
      <div className="space-y-2 p-4" role="alert">
        <p className="text-sm text-destructive">{state.message}</p>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );

  if (state.jellyfin !== "ok" || state.needsAdmin)
    return (
      <div className="space-y-2 p-4" role={state.needsAdmin ? "alert" : undefined}>
        <p className="text-sm">
          {state.needsAdmin
            ? state.message ?? "Sign in with an admin account so TorrentFlow can see what everyone is watching."
            : state.jellyfin === "off"
            ? "Connect Jellyfin to see what you have already watched."
            : "Jellyfin is not answering, so watched titles can't be listed. Check that it is running."}
        </p>
        <Button asChild variant="link" size="sm" className="px-0">
          <Link to="/settings#jellyfin-settings">Open Jellyfin settings</Link>
        </Button>
      </div>
    );

  if (state.items.length === 0)
    return <p className="p-4 text-sm text-subtle-foreground">Nothing watched is taking up space right now.</p>;

  return (
    <ul className="divide-y divide-border">
      {state.items.map((item) => {
        const selectable = canSelect(item, scope);
        const id = `cleanup-${item.workId}`;
        const offline = item.roots.filter((root) => !root.online).map((root) => root.label);
        return (
          <li key={item.workId} className={cn("flex items-center gap-3 px-4 py-3", !selectable && "opacity-60")}>
            <Checkbox
              id={id}
              checked={selectable && selected.has(item.workId)}
              disabled={!selectable}
              onCheckedChange={(checked) => onToggle(item.workId, checked === true)}
            />
            {item.poster ? (
              <img src={item.poster} alt="" className="h-14 w-10 shrink-0 rounded object-cover" loading="lazy" />
            ) : (
              <div className="h-14 w-10 shrink-0 rounded bg-muted" aria-hidden />
            )}
            <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer space-y-0.5">
              <span className="block truncate text-sm font-medium">
                {item.title}
                {item.year ? <span className="font-normal text-subtle-foreground"> ({item.year})</span> : null}
              </span>
              <span className="block text-xs text-subtle-foreground">
                {offline.length > 0 ? `On ${offline.join(", ")}, which is offline` : watchedLabel(item)}
              </span>
            </label>
            <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
              {formatBytes(freedBytes(item, scope)) ?? "0 B"}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
