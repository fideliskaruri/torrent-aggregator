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
  listStorageRoots,
  removeStorageRoot,
  reorderStorageRoots,
  updateStorageRoot,
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
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const pending = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const next = await listStorageRoots();
      if (pending.current === 0) setRoots(next);
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

  return { roots, setRoots, load, refresh, run, pending };
}

export function StorageLocations() {
  const { roots, setRoots, load, refresh, run, pending } = useStorageRoots();
  const [dialog, setDialog] = useState<StorageDialogTarget | null>(null);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const committed = useRef<StorageRoot[]>([]);
  const latest = useRef(roots);
  latest.current = roots;
  const isPhone = useMediaQuery("(max-width: 767px)");
  const reorderable = roots.length > 1;

  async function saveOrder(next: StorageRoot[], previous: StorageRoot[]) {
    if (sameOrder(next, previous)) return;
    setRoots(next);
    const saved = await run(() => reorderStorageRoots(next.map((root) => root.id)));
    if (!saved) setRoots(previous);
  }

  function moveBy(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= roots.length) return;
    void saveOrder(move(roots, index, target), roots);
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

  return (
    <div className="space-y-3" data-storage-locations>
      <div className="space-y-1">
        <h3 className="text-sm font-medium">Storage locations</h3>
        <p className="text-xs text-subtle-foreground">
          {reorderable
            ? "New downloads go to the first location with room. If it is full or unplugged, the next one is used."
            : "Add another drive so downloads keep going when this one is full or unplugged."}
        </p>
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
          />
        ))}
      </Reorder.Group>

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

      <div className={cn("min-w-0 flex-1 space-y-1.5", !root.enabled && "opacity-60")}>
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
