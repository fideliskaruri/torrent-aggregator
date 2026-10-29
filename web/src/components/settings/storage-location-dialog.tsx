import { useEffect, useState } from "react";
import { FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { FolderPicker } from "@/components/settings/folder-picker";
import { toast } from "@/lib/toast";
import {
  addStorageRoot,
  LIBRARY_KINDS,
  updateStorageRoot,
  type LibraryKind,
  type StorageRoot,
} from "@/lib/api/storage";

export type StorageDialogTarget = { mode: "add" } | { mode: "edit"; root: StorageRoot };

const GB = 1024 ** 3;
const ALL_KINDS = LIBRARY_KINDS.map((entry) => entry.kind);

function toGb(bytes: number | null) {
  return bytes && bytes > 0 ? String(Math.round(bytes / GB)) : "";
}

function toBytes(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const gb = Number(trimmed);
  return Number.isFinite(gb) && gb > 0 ? Math.round(gb * GB) : Number.NaN;
}

export function StorageLocationDialog({
  target,
  onClose,
  onSaved,
  run,
}: {
  target: StorageDialogTarget | null;
  onClose: () => void;
  onSaved: () => void;
  run: (work: () => Promise<unknown>) => Promise<boolean>;
}) {
  const root = target?.mode === "edit" ? target.root : null;
  const [path, setPath] = useState("");
  const [kinds, setKinds] = useState<LibraryKind[]>(ALL_KINDS);
  const [keepFree, setKeepFree] = useState("");
  const [useAtMost, setUseAtMost] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!target) return;
    setPath(root?.path ?? "");
    setKinds(root?.kinds ?? ALL_KINDS);
    setKeepFree(toGb(root?.reserveSetting ?? null));
    setUseAtMost(toGb(root?.maxAllocatedBytes ?? null));
  }, [target, root]);

  const reserve = toBytes(keepFree);
  const cap = toBytes(useAtMost);
  const invalid =
    kinds.length === 0 || Number.isNaN(reserve) || Number.isNaN(cap) || (!root && !path.trim());

  function toggleKind(kind: LibraryKind, checked: boolean) {
    setKinds((current) =>
      checked ? ALL_KINDS.filter((entry) => entry === kind || current.includes(entry)) : current.filter((entry) => entry !== kind),
    );
  }

  async function save() {
    setSaving(true);
    const ok = await run(async () => {
      if (root) {
        await updateStorageRoot(root, {
          kinds,
          reserveBytes: reserve ?? 0,
          maxAllocatedBytes: cap,
          enabled: root.enabled,
        });
        return;
      }
      const added = await addStorageRoot(path.trim(), kinds);
      if (added && (reserve !== null || cap !== null)) {
        await updateStorageRoot(added, {
          kinds,
          reserveBytes: reserve ?? 0,
          maxAllocatedBytes: cap,
          enabled: true,
        });
      }
      toast.success(`Added ${path.trim()}`);
    });
    setSaving(false);
    if (ok) onSaved();
  }

  return (
    <>
      <Dialog open={target !== null && !pickerOpen} onOpenChange={(open) => (!open ? onClose() : undefined)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{root ? "Edit location" : "Add location"}</DialogTitle>
            <DialogDescription className="break-all">
              {root ? root.path : "Pick a folder on any drive. New locations go to the end of the list."}
            </DialogDescription>
          </DialogHeader>

          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!invalid && !saving) void save();
            }}
          >
            {root ? null : (
              <FormField label="Folder" htmlFor="storage-path">
                <div className="flex gap-2">
                  <Input
                    id="storage-path"
                    value={path}
                    onChange={(event) => setPath(event.target.value)}
                    placeholder="E:\\Media"
                    autoComplete="off"
                  />
                  <Button type="button" variant="outline" onClick={() => setPickerOpen(true)}>
                    <FolderOpen aria-hidden />
                    Browse
                  </Button>
                </div>
              </FormField>
            )}

            <fieldset className="space-y-2">
              <legend className="text-xs text-subtle-foreground">Stores</legend>
              <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                {LIBRARY_KINDS.map(({ kind, label }) => (
                  <label key={kind} className="flex min-h-11 items-center gap-2 text-sm sm:min-h-0">
                    <Checkbox
                      checked={kinds.includes(kind)}
                      onCheckedChange={(checked) => toggleKind(kind, checked === true)}
                    />
                    {label}
                  </label>
                ))}
              </div>
              {kinds.length === 0 ? (
                <p className="text-xs text-destructive">Pick at least one kind of media.</p>
              ) : null}
            </fieldset>

            <div className="grid grid-cols-2 gap-4">
              <FormField label="Keep free (GB)" htmlFor="storage-keep-free" hint="Leave empty for automatic.">
                <Input
                  id="storage-keep-free"
                  inputMode="numeric"
                  value={keepFree}
                  onChange={(event) => setKeepFree(event.target.value)}
                  placeholder="Automatic"
                  aria-invalid={Number.isNaN(reserve)}
                />
              </FormField>
              <FormField label="Use at most (GB)" htmlFor="storage-cap" hint="Leave empty for no limit.">
                <Input
                  id="storage-cap"
                  inputMode="numeric"
                  value={useAtMost}
                  onChange={(event) => setUseAtMost(event.target.value)}
                  placeholder="No limit"
                  aria-invalid={Number.isNaN(cap)}
                />
              </FormField>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={invalid || saving}>
                {root ? "Save" : "Add location"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <FolderPicker
        open={pickerOpen}
        initialPath={path}
        title="Choose a storage folder"
        onClose={() => setPickerOpen(false)}
        onSelect={(selected) => {
          setPath(selected);
          setPickerOpen(false);
        }}
      />
    </>
  );
}
