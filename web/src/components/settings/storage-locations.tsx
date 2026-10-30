import { useCallback, useEffect, useRef, useState } from "react";
import { Reorder, useDragControls } from "framer-motion";
import { ArrowDown, ArrowUp, GripVertical, MoreHorizontal, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useMediaQuery } from "@/hooks/use-media-query";
import { formatBytes } from "@/lib/format";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import {
  listJellyfinOrphanPaths,
  listStorageRoots,
  removeRootFromJellyfin,
  removeStorageRoot,
  reorderStorageRoots,
  syncRootToJellyfin,
  updateStorageRoot,
  type JellyfinOrphanPath,
  type StorageRoot,
  type StorageStatus,
} from "@/lib/api/storage";
import { StorageLocationDialog, type StorageDialogTarget } from "./storage-location-dialog";
import { CleanupSheet } from "./cleanup-sheet";

const POLL_MS = 10_000;

const STATUS: Record<StorageStatus, { label: string; className: string }> = {
  online: { label: "Online", className: "bg-success/15 text-success" },
  offline: { label: "Offline", className: "bg-destructive/15 text-destructive" },
  full: { label: "Full", className: "bg-warning/15 text-warning" },
  review: { label: "Check needed", className: "bg-warning/15 text-warning" },
  off: { label: "Off", className: "bg-muted text-muted-foreground" },
};

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready" };

function move<T>(items: T[], from: number, to: number): T[] {
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

function sameOrder(a: StorageRoot[], b: StorageRoot[]) {
  return a.length === b.length && a.every((root, index) => root.id === b[index].id);
}

export function useStorageRoots() {
  const [roots, setRoots] = useState<StorageRoot[]>([]);
  const [orphans, setOrphans] = useState<JellyfinOrphanPath[]>([]);
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const pending = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const [next, stale] = await Promise.all([
        listStorageRoots(),
        listJellyfinOrphanPaths().catch(() => null),
      ]);
      if (pending.current === 0) setRoots(next);
      if (stale) setOrphans(stale);
      setLoad({ status: "ready" });
    } catch (error) {
      setLoad((current) =>
        current.status === "ready" ? current : { status: "error", message: (error as Error).message },
      );
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const run = useCallback(
    async (work: () => Promise<unknown>) => {
      pending.current += 1;
      try {
        await work();
        return true;
      } catch (error) {
        toast.error((error as Error).message);
        return false;
      } finally {
        pending.current -= 1;
        await refresh();
      }
    },
    [refresh],
  );

  return { roots, setRoots, orphans, load, refresh, run, pending };
}

export function StorageLocations() {
  const { roots, setRoots, orphans, load, refresh, run, pending } = useStorageRoots();
  const [dialog, setDialog] = useState<StorageDialogTarget | null>(null);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const committed = useRef<StorageRoot[]>([]);
  const latest = useRef(roots);
  latest.current = roots;
  const isPhone = useMediaQuery("(max-width: 767px)");
  const reorderable = roots.length > 1;

  const orderWrites = useRef<Promise<void>>(Promise.resolve());

  // Writes run one at a time in the order made, so the last move always wins. Polling stays paused
  // until the queue drains; a failure reloads the saved order instead of rolling back to a stale copy.
  function saveOrder(next: StorageRoot[], previous: StorageRoot[]) {
    if (sameOrder(next, previous)) return;
    setRoots(next);
    pending.current += 1;
    const ids = next.map((root) => root.id);
    orderWrites.current = orderWrites.current.then(async () => {
      try {
        await reorderStorageRoots(ids);
      } catch (error) {
        toast.error((error as Error).message);
      } finally {
        pending.current -= 1;
      }
      if (pending.current === 0) await refresh();
    });
  }

  function moveBy(index: number, delta: number) {
    const target = index + delta;
    const current = latest.current;
    if (target < 0 || target >= current.length) return;
    const next = move(current, index, target);
    latest.current = next;
    saveOrder(next, current);
  }

  if (load.status === "loading" && roots.length === 0) {
    return <p className="text-sm text-subtle-foreground">Loading storage locations…</p>;
  }

  if (load.status === "error") {
    return (
      <div className="space-y-2" role="alert">
        <p className="text-sm text-destructive">{load.message}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => void refresh()}>
          Try again
        </Button>
      </div>
    );
  }

  const adminMessage = needsAdminMessage(roots);
  return (
    <div className="space-y-3" data-storage-locations>
      <div className="space-y-1">
        <h3 className="text-sm font-medium">Storage locations</h3>
        <p className="text-xs text-subtle-foreground">
          {reorderable
            ? "New downloads go to the first location with room. If it is full or unplugged, the next one is used."
            : "Add another drive so downloads keep going when this one is full or unplugged."}
        </p>
        {adminMessage ? (
          <p className="text-xs text-warning" data-root-jellyfin="needs-admin">
            {adminMessage}
          </p>
        ) : null}
      </div>

      <Reorder.Group
        axis="y"
        values={roots}
        onReorder={setRoots}
        className="divide-y divide-border overflow-hidden rounded-lg border border-border"
        as="ol"
      >
        {roots.map((root, index) => (
          <StorageRow
            key={root.id}
            root={root}
            index={index}
            count={roots.length}
            reorderable={reorderable}
            isPhone={isPhone}
            onDragStart={() => {
              committed.current = roots;
              pending.current += 1;
            }}
            onDragEnd={() => {
              pending.current -= 1;
              void saveOrder(latest.current, committed.current);
            }}
            onMove={(delta) => moveBy(index, delta)}
            onEdit={() => setDialog({ mode: "edit", root })}
            onConfirm={() =>
              void run(() =>
                updateStorageRoot(root, {
                  kinds: root.kinds,
                  reserveBytes: root.reserveSetting,
                  maxAllocatedBytes: root.maxAllocatedBytes,
                  enabled: root.enabled,
                  confirmIdentity: true,
                }),
              )
            }
            onToggle={() =>
              void run(() =>
                updateStorageRoot(root, {
                  kinds: root.kinds,
                  reserveBytes: root.reserveSetting,
                  maxAllocatedBytes: root.maxAllocatedBytes,
                  enabled: !root.enabled,
                }),
              )
            }
            onRemove={() =>
              void run(async () => {
                await removeStorageRoot(root);
                toast.success(`Removed ${root.path}`);
              })
            }
            stillInJellyfin={orphans.some((orphan) => orphan.rootId === root.id)}
            onJellyfinSync={() =>
              run(async () => {
                const status = await syncRootToJellyfin(root.id);
                if (status.state === "indexed" || status.state === "registered")
                  toast.success(
                    status.libraries.length > 0
                      ? `${root.path} is in Jellyfin: ${status.libraries.join(", ")}`
                      : `${root.path} is in Jellyfin`,
                  );
                else toast.info(status.message ?? `Jellyfin has not added ${root.path} yet. Try again in a minute.`);
              })
            }
            onJellyfinRemove={() =>
              run(async () => toast.success(await removeRootFromJellyfin(root.id)))
            }
          />
        ))}
      </Reorder.Group>

      <RemovedInJellyfin
        orphans={orphans.filter((orphan) => orphan.state === "removed-root")}
        onRemove={(rootId) => run(async () => toast.success(await removeRootFromJellyfin(rootId)))}
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => setDialog({ mode: "add" })}>
          <Plus aria-hidden />
          Add location
        </Button>
        <Button type="button" variant="link" size="sm" onClick={() => setCleanupOpen(true)}>
          Free up space
        </Button>
      </div>

      <StorageLocationDialog
        target={dialog}
        onClose={() => setDialog(null)}
        onSaved={() => {
          setDialog(null);
          void refresh();
        }}
        run={run}
      />
      <CleanupSheet open={cleanupOpen} onOpenChange={setCleanupOpen} onDeleted={() => void refresh()} />
    </div>
  );
}

function StorageRow({
  root,
  index,
  count,
  reorderable,
  isPhone,
  onDragStart,
  onDragEnd,
  onMove,
  onEdit,
  onConfirm,
  onToggle,
  onRemove,
  stillInJellyfin,
  onJellyfinSync,
  onJellyfinRemove,
}: {
  root: StorageRoot;
  index: number;
  count: number;
  reorderable: boolean;
  isPhone: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onMove: (delta: number) => void;
  onEdit: () => void;
  onConfirm: () => void;
  onToggle: () => void;
  onRemove: () => void;
  stillInJellyfin: boolean;
  onJellyfinSync: () => Promise<boolean>;
  onJellyfinRemove: () => Promise<boolean>;
}) {
  const controls = useDragControls();
  const status = STATUS[root.status];
  const total = root.totalBytes ?? 0;
  const used = total > 0 && root.freeBytes !== null ? total - root.freeBytes : 0;
  const usedPercent = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const reservePercent = total > 0 ? Math.min(100 - usedPercent, (root.reserveBytes / total) * 100) : 0;
  const showArrows = reorderable && !isPhone;

  return (
    <Reorder.Item
      value={root}
      dragListener={false}
      dragControls={controls}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className="flex items-center gap-2 bg-card px-2 py-3 sm:gap-3 sm:px-3"
      data-storage-root={root.id}
    >
      {reorderable && !isPhone ? (
        <button
          type="button"
          aria-label={`Drag to reorder ${root.path}`}
          className="flex size-8 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-subtle-foreground hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none active:cursor-grabbing"
          onPointerDown={(event) => controls.start(event)}
        >
          <GripVertical className="size-4" aria-hidden />
        </button>
      ) : null}
      {reorderable ? (
        <span className="w-4 shrink-0 text-center text-sm tabular-nums text-subtle-foreground">{index + 1}</span>
      ) : null}

      <div className="min-w-0 flex-1 space-y-1.5">
        <div className={cn("space-y-1.5", !root.enabled && "opacity-60")}>
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium" title={root.path}>
              {root.path}
            </span>
            <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-xs font-medium", status.className)}>
              {status.label}
            </span>
          </div>
          {total > 0 ? (
            <div
              className="relative h-1.5 overflow-hidden rounded-full bg-muted"
              role="meter"
              aria-label={`${root.path} space used`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={usedPercent}
            >
              <div
                className={cn("absolute inset-y-0 left-0 rounded-full", root.status === "full" ? "bg-warning" : "bg-foreground/50")}
                style={{ width: `${usedPercent}%` }}
              />
              <div
                className="absolute inset-y-0 bg-foreground/15"
                style={{ left: `${usedPercent}%`, width: `${reservePercent}%` }}
              />
            </div>
          ) : null}
          <p className="text-xs text-subtle-foreground">{describe(root)}</p>
        </div>
        <JellyfinLine root={root} stillInJellyfin={stillInJellyfin} onSync={onJellyfinSync} onRemove={onJellyfinRemove} />
      </div>

      {showArrows ? (
        <div className="flex shrink-0">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Move ${root.path} up`}
            disabled={index === 0}
            onClick={() => onMove(-1)}
          >
            <ArrowUp aria-hidden />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Move ${root.path} down`}
            disabled={index === count - 1}
            onClick={() => onMove(1)}
          >
            <ArrowDown aria-hidden />
          </Button>
        </div>
      ) : null}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={`More for ${root.path}`}>
            <MoreHorizontal aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {root.status === "review" ? (
            <DropdownMenuItem onSelect={onConfirm}>This is the right drive</DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={onEdit}>Edit</DropdownMenuItem>
          {reorderable && isPhone ? (
            <>
              <DropdownMenuItem disabled={index === 0} onSelect={() => onMove(-1)}>
                Move up
              </DropdownMenuItem>
              <DropdownMenuItem disabled={index === count - 1} onSelect={() => onMove(1)}>
                Move down
              </DropdownMenuItem>
            </>
          ) : null}
          <DropdownMenuItem onSelect={onToggle}>{root.enabled ? "Turn off" : "Turn on"}</DropdownMenuItem>
          {count > 1 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={onRemove}>
                Remove
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </Reorder.Item>
  );
}

function describe(root: StorageRoot): string {
  if (root.status === "offline")
    return "Unplugged or unreachable. Downloads for this drive wait and resume when it is back.";
  if (root.status === "review")
    return "A different drive is mounted here. Confirm it if you swapped drives on purpose.";
  if (root.status === "off") return "Turned off. New downloads skip this location.";
  const parts: string[] = [];
  const free = formatBytes(root.freeBytes);
  const total = formatBytes(root.totalBytes);
  if (free && total) parts.push(`${free} free of ${total}.`);
  const keep = formatBytes(root.reserveBytes);
  if (keep) parts.push(`Keeps ${keep} free${root.reserveSetting === 0 ? " (automatic)" : ""}.`);
  const cap = formatBytes(root.maxAllocatedBytes);
  if (cap) parts.push(`Uses at most ${cap}.`);
  return parts.join(" ");
}

const INLINE_ACTION =
  "-my-3 inline-flex min-h-11 items-center rounded-sm px-1 text-xs font-medium text-brand-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60 lg:my-0 lg:min-h-0";

function useBusy(action: () => Promise<boolean>) {
  const [busy, setBusy] = useState(false);
  const go = useCallback(async () => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }, [action]);
  return [busy, go] as const;
}

/**
 * Where this location stands in Jellyfin, with the one action that fixes it.
 * Silent when Jellyfin isn't connected or library sync is off: the Jellyfin
 * settings say that once, not every drive row.
 */
function JellyfinLine({
  root,
  stillInJellyfin,
  onSync,
  onRemove,
}: {
  root: StorageRoot;
  stillInJellyfin: boolean;
  onSync: () => Promise<boolean>;
  onRemove: () => Promise<boolean>;
}) {
  const [syncing, sync] = useBusy(onSync);
  const [removing, remove] = useBusy(onRemove);
  const jellyfin = root.jellyfin;
  if (!jellyfin) return null;

  if (!root.enabled && stillInJellyfin)
    return (
      <p className="flex flex-wrap items-center gap-x-2 text-xs text-subtle-foreground" data-root-jellyfin="stale">
        Still in Jellyfin.
        <button type="button" className={INLINE_ACTION} disabled={removing} onClick={() => void remove()}>
          {removing ? "Removing…" : "Remove from Jellyfin"}
        </button>
      </p>
    );

  if (jellyfin.state === "indexed" || jellyfin.state === "registered")
    return (
      <p className="text-xs text-subtle-foreground" data-root-jellyfin={jellyfin.state}>
        {jellyfin.libraries.length > 0 ? `In Jellyfin: ${jellyfin.libraries.join(", ")}` : "In Jellyfin"}
      </p>
    );

  if (jellyfin.state === "failed")
    return (
      <p className="flex flex-wrap items-center gap-x-2 text-xs text-warning" data-root-jellyfin="failed">
        <span className="min-w-0">{jellyfin.message ?? "Jellyfin did not take this folder."}</span>
        <button type="button" className={INLINE_ACTION} disabled={syncing} onClick={() => void sync()}>
          {syncing ? "Trying…" : "Try again"}
        </button>
      </p>
    );

  if (jellyfin.state === "pending" && root.enabled)
    return (
      <p className="flex flex-wrap items-center gap-x-2 text-xs text-subtle-foreground" data-root-jellyfin="pending">
        {/* A message means something else must happen first (reconnect, confirm, checking), which Add can't fix. */}
        <span className="min-w-0">{jellyfin.message ?? "Not in Jellyfin yet."}</span>
        {jellyfin.message ? null : (
          <button type="button" className={INLINE_ACTION} disabled={syncing} onClick={() => void sync()}>
            {syncing ? "Adding…" : "Add to Jellyfin"}
          </button>
        )}
      </p>
    );

  // A missing admin login applies to every location, so the list says it once above the rows.
  return null;
}

const isAdminMessage = (message: string) => /admin/i.test(message);

/** The one admin-login message, if any enabled location is blocked on it. */
function needsAdminMessage(roots: StorageRoot[]) {
  return (
    roots.find((root) => root.enabled && root.jellyfin?.state === "off" && root.jellyfin.message &&
      isAdminMessage(root.jellyfin.message))?.jellyfin?.message ?? null
  );
}

/** Folders Jellyfin still scans from storage locations that were removed here. */
function RemovedInJellyfin({
  orphans,
  onRemove,
}: {
  orphans: JellyfinOrphanPath[];
  onRemove: (rootId: string) => Promise<boolean>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  if (orphans.length === 0) return null;
  const byRoot = new Map<string, JellyfinOrphanPath[]>();
  for (const orphan of orphans) byRoot.set(orphan.rootId, [...(byRoot.get(orphan.rootId) ?? []), orphan]);

  return (
    <div className="space-y-2 rounded-lg border border-border p-3" data-jellyfin-orphans>
      <p className="text-sm font-medium">Removed locations still in Jellyfin</p>
      <ul className="space-y-2">
        {[...byRoot].map(([rootId, paths]) => (
          <li key={rootId} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <span className="min-w-0 text-xs text-subtle-foreground">
              {paths.map((path) => (
                <span key={path.path} className="block truncate" title={path.path}>
                  {path.path} <span className="text-muted-foreground">in {path.libraryName}</span>
                </span>
              ))}
            </span>
            <button
              type="button"
              className={INLINE_ACTION}
              disabled={busy === rootId}
              onClick={async () => {
                setBusy(rootId);
                try {
                  await onRemove(rootId);
                } finally {
                  setBusy(null);
                }
              }}
            >
              {busy === rootId ? "Removing…" : "Remove from Jellyfin"}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
