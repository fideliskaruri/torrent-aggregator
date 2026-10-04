import { useCallback, useEffect, useState } from "react";
import { get } from "@/lib/api";
import {
  ArrowUp,
  Check,
  Folder,
  HardDrive,
  Home,
  Loader2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

export interface FolderPickerEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

interface FolderPickerProps {
  open: boolean;
  /** Starting path (absolute). Empty → drives on Windows / root on Unix. */
  initialPath?: string;
  onClose: () => void;
  onSelect: (path: string) => void;
  title?: string;
}

export function FolderPicker({
  open,
  initialPath = "",
  onClose,
  onSelect,
  title = "Choose folder",
}: FolderPickerProps) {
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<FolderPickerEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const q = path ? `?path=${encodeURIComponent(path)}` : "";
      const res = await get(`/api/settings/browse-folders${q}`);
      const raw = await res.text();
      if (!raw.trim()) {
        throw new Error(
          `Empty response (${res.status}). Restart the app if this persists.`,
        );
      }
      let data: {
        error?: string;
        message?: string;
        path?: string;
        parent?: string | null;
        entries?: FolderPickerEntry[];
      };
      try {
        data = JSON.parse(raw) as typeof data;
      } catch {
        throw new Error(`Invalid server response (${res.status})`);
      }
      if (!res.ok) {
        throw new Error(
          data.message || data.error || "Failed to list folders",
        );
      }
      setCurrentPath(data.path ?? "");
      setParent(data.parent ?? null);
      setEntries(
        Array.isArray(data.entries)
          ? data.entries.filter((e) => e.isDirectory)
          : [],
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    // Folder entries are external filesystem state; fetching them when the dialog opens belongs in an effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(initialPath || "");
  }, [open, initialPath, load]);

  const canSelect = Boolean(currentPath);
  const showUp = parent !== null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        aria-label={title}
        className="flex max-h-[85dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg"
      >
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 shrink-0">
          <div className="min-w-0">
            <DialogTitle className="text-sm font-medium text-foreground truncate">
              {title}
            </DialogTitle>
            <DialogDescription className="text-xs text-subtle-foreground font-mono truncate mt-0.5">
              {currentPath || "Select a drive or folder"}
            </DialogDescription>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            className="shrink-0"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex items-center gap-1.5 border-b border-border px-3 py-2 shrink-0">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!showUp || loading}
            onClick={() => void load(parent === "" ? "" : (parent ?? ""))}
            title="Up one level"
          >
            <ArrowUp className="h-3.5 w-3.5" />
            Up
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={loading}
            onClick={() => void load("")}
            title="Root / drives"
          >
            <Home className="h-3.5 w-3.5" />
            Root
          </Button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-subtle-foreground text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading…
            </div>
          ) : error ? (
            <div className="px-4 py-8 text-center text-sm text-destructive">
              {error}
            </div>
          ) : (
            <Command
              shouldFilter={false}
              aria-label="Folders"
              className="rounded-none! bg-transparent p-0"
            >
              <CommandList className="max-h-none py-1">
                <CommandEmpty className="px-4 py-8 text-subtle-foreground">
                  No subfolders here
                </CommandEmpty>
                {entries.map((entry) => {
                  const isDrive =
                    /^[a-zA-Z]:\\?$/.test(entry.path) ||
                    /^[a-zA-Z]:$/.test(entry.name);
                  return (
                    <CommandItem
                      key={entry.path}
                      value={entry.path}
                      onSelect={() => void load(entry.path)}
                      className="min-h-[44px] cursor-pointer gap-2.5 rounded-none px-4 py-2.5 text-muted-foreground data-selected:bg-accent lg:min-h-0"
                    >
                      {isDrive ? (
                        <HardDrive className="h-4 w-4 shrink-0 text-brand-foreground" />
                      ) : (
                        <Folder className="h-4 w-4 shrink-0 text-info" />
                      )}
                      <span className="truncate font-mono text-[13px]">
                        {entry.name}
                      </span>
                    </CommandItem>
                  );
                })}
              </CommandList>
            </Command>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-4 py-3 shrink-0">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!canSelect || loading}
            onClick={() => {
              if (currentPath) onSelect(currentPath);
            }}
          >
            <Check className="h-3.5 w-3.5" />
            Use this folder
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}