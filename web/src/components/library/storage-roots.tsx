import { useId, useState, type FormEvent } from "react";
import { ArrowDown, ArrowUp, HardDrive, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { LoadingGlyph, SkeletonBlock } from "@/components/ui/loading";
import { ConfirmDialog } from "@/components/tf/confirm-dialog";
import { TfEmptyState } from "@/components/tf/empty-state";
import { TfErrorState } from "@/components/tf/error-state";
import { useApiQuery } from "@/hooks/use-api-query";
import { formatBytes } from "@/lib/format";
import {
  LIBRARY_KINDS,
  libraryRequest,
  type LibraryKind,
  type StorageRoot,
} from "@/lib/library/import";
import { toast } from "@/lib/toast";

const ROOTS_URL = "/api/library/roots";
const GB = 1024 ** 3;
const TOUCH = "max-md:min-h-11 pointer-coarse:min-h-11";

/** The storage roots list with add, remove, reorder, kinds, reserve and rescan. */
export function StorageRoots() {
  const query = useApiQuery<StorageRoot[]>(ROOTS_URL, {
    select: (json) => (json as { roots?: StorageRoot[] } | null)?.roots ?? [],
    emptyOnUnauthorized: false,
  });
  const roots = query.data;
  const [busy, setBusy] = useState<string | null>(null);
  const [removing, setRemoving] = useState<StorageRoot | null>(null);

  async function run(key: string, action: () => Promise<void>) {
    setBusy(key);
    try {
      await action();
      query.refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "That didn't work. Try again.");
    } finally {
      setBusy(null);
    }
  }

  function configure(root: StorageRoot, change: Partial<Pick<StorageRoot, "kinds" | "reserveBytes" | "priority">>) {
    return libraryRequest("PUT", `${ROOTS_URL}/${root.id}`, {
      priority: change.priority ?? root.priority,
      reserveBytes: change.reserveBytes ?? root.reserveBytes,
      enabled: root.enabled,
      kinds: change.kinds ?? root.kinds,
      expectedVersion: root.version,
    });
  }

  function move(index: number, by: -1 | 1) {
    if (!roots) return;
    const order = [...roots];
    const [root] = order.splice(index, 1);
    order.splice(index + by, 0, root);
    void run(`move:${root.id}`, async () => {
      for (const [priority, item] of order.entries())
        if (item.priority !== priority) await configure(item, { priority });
    });
  }

  if (query.error && !roots)
    return <TfErrorState title="Could not load your drives" message={query.error} onRetry={query.refetch} />;
  if (!roots)
    return (
      <div className="space-y-3" aria-busy="true" aria-label="Loading drives">
        <SkeletonBlock className="h-20 w-full" />
        <SkeletonBlock className="h-20 w-full" />
      </div>
    );

  return (
    <div className="space-y-4">
      {roots.length === 0 ? (
        <TfEmptyState
          icon={HardDrive}
          title="No drives yet"
          description="Add a folder on any drive. New downloads and imports go to the first drive that accepts their kind and has room."
          className="py-10"
        />
      ) : (
        <ol className="space-y-3" aria-label="Drives in priority order">
          {roots.map((root, index) => (
            <li key={root.id} className="space-y-3 rounded-lg border border-border bg-card p-3 sm:p-4" data-root-row>
              <div className="flex min-w-0 items-start gap-3">
                <span className="mt-0.5 font-mono text-xs text-subtle-foreground" aria-label={`Priority ${index + 1}`}>
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="break-all font-mono text-[13px] text-foreground">{root.path}</p>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-subtle-foreground">
                    {root.online ? <Badge variant="success">Online</Badge> : <Badge variant="danger">Offline</Badge>}
                    <span>
                      {root.freeBytes != null ? `${formatBytes(root.freeBytes)} free` : "Free space unknown"}
                      {`, keeps ${formatBytes(root.reserveBytes) ?? "0 B"} free`}
                    </span>
                  </div>
                  {root.lastError ? <p className="text-xs text-destructive">{root.lastError}</p> : null}
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    type="button" variant="ghost" size="icon-sm" className={TOUCH}
                    aria-label={`Move ${root.path} up`} disabled={index === 0 || busy !== null}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp aria-hidden />
                  </Button>
                  <Button
                    type="button" variant="ghost" size="icon-sm" className={TOUCH}
                    aria-label={`Move ${root.path} down`} disabled={index === roots.length - 1 || busy !== null}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown aria-hidden />
                  </Button>
                </div>
              </div>
              <KindPicker
                value={root.kinds}
                disabled={busy !== null}
                onChange={(kinds) => void run(`kinds:${root.id}`, () => configure(root, { kinds }).then(() => undefined))}
              />
              <div className="flex flex-wrap items-end gap-2">
                <ReserveField
                  key={`${root.id}:${root.version}`}
                  bytes={root.reserveBytes}
                  disabled={busy !== null}
                  onSave={(reserveBytes) =>
                    void run(`reserve:${root.id}`, () => configure(root, { reserveBytes }).then(() => undefined))}
                />
                <div className="ml-auto flex gap-2">
                  <Button
                    type="button" variant="secondary" size="sm" disabled={busy !== null}
                    onClick={() =>
                      void run(`scan:${root.id}`, async () => {
                        const result = await libraryRequest<{ online: boolean; present: number; offline: number; missing: number }>(
                          "POST", `${ROOTS_URL}/${root.id}/rescan`);
                        toast.success(result.online
                          ? `Rescanned: ${result.present} present, ${result.missing} missing`
                          : "This drive is offline. Reconnect it and rescan.");
                      })}
                  >
                    {busy === `scan:${root.id}` ? <LoadingGlyph className="size-3.5" /> : <RefreshCw aria-hidden />}
                    Rescan
                  </Button>
                  <Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={() => setRemoving(root)}>
                    <Trash2 aria-hidden />
                    Remove
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
      <AddRootForm nextPriority={roots.length} onAdded={query.refetch} />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title="Remove this drive?"
        description={`${removing?.path ?? ""} stops receiving new files. Nothing on the drive is deleted.`}
        confirmLabel="Remove drive"
        variant="destructive"
        busy={busy === `remove:${removing?.id}`}
        onConfirm={() => {
          const root = removing;
          if (!root) return;
          void run(`remove:${root.id}`, async () => {
            await libraryRequest("DELETE", `${ROOTS_URL}/${root.id}`);
            setRemoving(null);
          });
        }}
      />
    </div>
  );
}

function KindPicker({
  value,
  onChange,
  disabled,
}: {
  value: LibraryKind[];
  onChange: (kinds: LibraryKind[]) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <fieldset className="flex flex-wrap gap-x-4 gap-y-1" disabled={disabled}>
      <legend className="sr-only">Kinds this drive accepts</legend>
      {LIBRARY_KINDS.map((kind) => {
        const checked = value.includes(kind.value);
        return (
          <label key={kind.value} htmlFor={`${id}-${kind.value}`}
            className="flex min-h-11 cursor-pointer items-center gap-2 text-[13px] text-foreground md:min-h-8">
            <Checkbox
              id={`${id}-${kind.value}`}
              checked={checked}
              disabled={disabled || (checked && value.length === 1)}
              onCheckedChange={(next) =>
                onChange(next ? [...value, kind.value] : value.filter((k) => k !== kind.value))}
            />
            {kind.label}
          </label>
        );
      })}
    </fieldset>
  );
}

function ReserveField({ bytes, onSave, disabled }: { bytes: number; onSave: (bytes: number) => void; disabled?: boolean }) {
  const id = useId();
  const [value, setValue] = useState(String(Math.round(bytes / GB)));
  const parsed = Number(value);
  const valid = value.trim() !== "" && Number.isFinite(parsed) && parsed >= 0;
  const changed = valid && Math.round(parsed * GB) !== bytes;
  return (
    <form
      className="flex items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (changed) onSave(Math.round(parsed * GB));
      }}
    >
      <FormField label="Keep free (GB)" htmlFor={id} className="w-32">
        <Input id={id} inputMode="decimal" value={value} disabled={disabled}
          aria-invalid={!valid} onChange={(event) => setValue(event.target.value)} className={TOUCH} />
      </FormField>
      {changed ? <Button type="submit" size="sm" disabled={disabled}>Save</Button> : null}
    </form>
  );
}

function AddRootForm({ nextPriority, onAdded }: { nextPriority: number; onAdded: () => void }) {
  const pathId = useId();
  const reserveId = useId();
  const [path, setPath] = useState("");
  const [kinds, setKinds] = useState<LibraryKind[]>(LIBRARY_KINDS.map((k) => k.value));
  const [reserve, setReserve] = useState("50");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const reserveGb = Number(reserve);
    if (!path.trim()) return setError("Type the full path of a folder, for example D:\\Media.");
    if (!Number.isFinite(reserveGb) || reserveGb < 0) return setError("Keep free must be 0 or more GB.");
    setSaving(true);
    setError(null);
    try {
      await libraryRequest("POST", ROOTS_URL, {
        path: path.trim(), kinds, priority: nextPriority, reserveBytes: Math.round(reserveGb * GB), confirmed: true,
      });
      setPath("");
      toast.success("Drive added");
      onAdded();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not add this folder. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-3 rounded-lg border border-dashed border-border p-3 sm:p-4" data-add-root>
      <h3 className="text-[13px] font-medium text-foreground">Add a folder or drive</h3>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <FormField label="Folder path" htmlFor={pathId} className="min-w-0 flex-1">
          <Input id={pathId} value={path} placeholder="D:\Media" spellCheck={false} autoComplete="off"
            aria-invalid={error !== null} onChange={(event) => setPath(event.target.value)} className={`font-mono ${TOUCH}`} />
        </FormField>
        <FormField label="Keep free (GB)" htmlFor={reserveId} className="sm:w-32">
          <Input id={reserveId} inputMode="decimal" value={reserve} onChange={(event) => setReserve(event.target.value)} className={TOUCH} />
        </FormField>
      </div>
      <KindPicker value={kinds} onChange={setKinds} disabled={saving} />
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      <Button type="submit" size="sm" disabled={saving}>
        {saving ? <LoadingGlyph className="size-3.5" /> : <Plus aria-hidden />}
        Add drive
      </Button>
    </form>
  );
}
