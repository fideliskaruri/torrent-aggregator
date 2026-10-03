import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/tf/confirm-dialog";
import { openReleasePicker, PICK_RELEASE_LABEL } from "@/components/releases/release-picker-store";
import { useVisiblePoll } from "@/hooks/use-visible-poll";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

/** One target from GET /api/wanted that has no release yet. */
export interface WantedRow {
  workKey: string;
  title?: string | null;
  year?: number | null;
  mediaType?: string | null;
  season?: number | null;
  episode?: number | null;
  error?: string | null;
  why?: string | null;
  looking: boolean;
  nextAttemptAt?: string | null;
  /** "Pick a release yourself" for this film or episode. */
  pickLink?: string | null;
  /** "Pick a release yourself" for the episode's whole season. */
  seasonPickLink?: string | null;
}

/** What a stop or try touches: a film, a season's wanted episodes, or one episode. */
export interface WantedTarget {
  workKey: string;
  season: number | null;
  episode: number | null;
}

/** The two ways out of a wanted row that need no picker: search again now, or stop looking. */
export type WantedAction = "try-now" | "remove";

function targetQuery(t: WantedTarget): string {
  const params = new URLSearchParams({ workKey: t.workKey });
  if (t.season != null) params.set("season", String(t.season));
  if (t.episode != null) params.set("episode", String(t.episode));
  return params.toString();
}

/** Try now: search for the target at once instead of after its wait. False when the server refused. */
export async function tryWantedNow(target: WantedTarget): Promise<boolean> {
  const res = await fetch(`/api/wanted/try?${targetQuery(target)}`, { method: "POST" });
  return res.ok;
}

/** Remove: stop looking for the target, also after a restart. False when the server refused. */
export async function stopWanted(target: WantedTarget): Promise<boolean> {
  const res = await fetch(`/api/wanted?${targetQuery(target)}`, { method: "DELETE" });
  return res.ok;
}

/** What the Remove confirmation says for a target. */
export function wantedRemoveDescription(target: WantedTarget): string {
  return target.season != null && target.episode == null
    ? "TorrentFlow stops looking for these episodes, also after a restart. If a search for them is running or just finished, the episodes it started that are still downloading are removed too. Finished episodes stay."
    : "TorrentFlow stops looking for a release, also after a restart. A release it was just starting is removed too. Downloads that started earlier stay. You can download it again from its title page.";
}

/** The owner's wanted rows, polled while the page is visible. */
export function useWantedRows(enabled = true) {
  const [rows, setRows] = useState<WantedRow[]>([]);

  const load = useCallback(async () => {
    if (!enabled) return;
    try {
      const res = await fetch("/api/wanted");
      if (!res.ok) return;
      const data = (await res.json()) as { wanted?: WantedRow[] };
      setRows(data.wanted ?? []);
    } catch {
      // Keep the last rows; the next poll tries again.
    }
  }, [enabled]);

  useEffect(() => {
    void load();
  }, [load]);

  useVisiblePoll(load, { intervalMs: 3_000 });

  return { rows, setRows, reload: load };
}

/** True when a wanted row belongs to the target (a season target covers its episodes). */
export function wantedRowMatches(row: WantedRow, t: WantedTarget): boolean {
  return (
    row.workKey === t.workKey &&
    (row.season ?? null) === t.season &&
    (t.episode == null || row.episode === t.episode)
  );
}

/**
 * The way out of "Looking for a release", the same on Downloads and the title
 * page, also while it waits for an English release: pick a release yourself,
 * search again now, or remove it so TorrentFlow stops looking (also after a
 * restart, and also a search already running).
 */
export function WantedActions({
  target,
  name,
  pickTitle,
  looking,
  onChanged,
  onRemoved,
  size = "sm",
  className,
}: {
  target: WantedTarget;
  /** How the toasts and dialog name it, e.g. "Amélie (2001)" or "Show S01E02". */
  name: string;
  /** The title the release picker searches for and shows. */
  pickTitle: string;
  /** A search is running right now: Try now has nothing to start. */
  looking: boolean;
  onChanged?: () => void | Promise<void>;
  onRemoved?: () => void;
  size?: "sm" | "lg";
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const tryNow = async () => {
    setBusy(true);
    try {
      if (!(await tryWantedNow(target))) throw new Error("refused");
      toast.success(`Looking for ${name} now.`);
      await onChanged?.();
    } catch {
      toast.error(`Couldn't start a search for ${name}. Check that TorrentFlow is running, then try again.`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      if (!(await stopWanted(target))) throw new Error("refused");
      onRemoved?.();
      toast.success(`Removed ${name}. TorrentFlow stopped looking for it.`);
      setConfirming(false);
      await onChanged?.();
    } catch {
      toast.error(`Couldn't remove ${name}. Check that TorrentFlow is running, then try again.`);
    } finally {
      setBusy(false);
    }
  };

  const tryBlocked = looking || busy;

  return (
    <div className={cn("flex flex-nowrap items-center gap-2", className)} data-wanted-actions>
      <Button
        type="button"
        variant="secondary"
        size={size}
        className="max-md:min-h-11"
        onClick={() =>
          openReleasePicker({
            workKey: target.workKey,
            title: pickTitle,
            season: target.season,
            episode: target.episode,
            onPicked: () => void onChanged?.(),
          })
        }
        aria-label={`${PICK_RELEASE_LABEL} for ${name}`}
        data-looking-pick
      >
        <Search className="h-3.5 w-3.5" />
        Pick a release
      </Button>
      <Button
        type="button"
        variant="secondary"
        size={size}
        className="max-md:min-h-11"
        aria-disabled={tryBlocked}
        onClick={() => {
          if (!tryBlocked) void tryNow();
        }}
        aria-label={`Try now for ${name}`}
        data-looking-try
      >
        <RefreshCw className="h-3.5 w-3.5" />
        Try now
      </Button>
      <Button
        type="button"
        variant="ghost"
        size={size}
        className="max-md:min-h-11"
        disabled={busy}
        onClick={() => setConfirming(true)}
        aria-label={`Remove ${name}`}
        data-looking-remove
        title="Remove"
      >
        <Trash2 className="h-3.5 w-3.5" />
        <span className="max-sm:sr-only">Remove</span>
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          if (!open) setConfirming(false);
        }}
        contentData={{ "data-looking-remove-dialog": true }}
        confirmData={{ "data-looking-remove-confirm": true }}
        title={`Remove ${name}?`}
        description={wantedRemoveDescription(target)}
        variant="destructive"
        busy={confirming && busy}
        icon={<Trash2 className="h-3.5 w-3.5" />}
        confirmLabel="Remove"
        onConfirm={() => void remove()}
      />
    </div>
  );
}
