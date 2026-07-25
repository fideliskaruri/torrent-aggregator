"use client";

import { useCallback, useEffect, useState } from "react";
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
      const res = await fetch(`/api/settings/browse-folders${q}`);
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

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const canSelect = Boolean(currentPath);
  const showUp = parent !== null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <button
        type="button"
        className="absolute inset-0 bg-black/60"
        aria-label="Close"
        onClick={onClose}
      />
      <div className="relative z-10 flex w-full sm:max-w-lg max-h-[85dvh] flex-col rounded-t-2xl sm:rounded-2xl surface shadow-md overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3 shrink-0">
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-[var(--text)] truncate">
              {title}
            </h3>
            <p className="text-[11px] text-[var(--text-tertiary)] font-mono truncate mt-0.5">
              {currentPath || "Select a drive or folder"}
            </p>
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

        <div className="flex items-center gap-1.5 border-b border-[var(--border)] px-3 py-2 shrink-0">
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
            <div className="flex items-center justify-center gap-2 py-16 text-[var(--text-tertiary)] text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading…
            </div>
          ) : error ? (
            <div className="px-4 py-8 text-center text-sm text-[var(--danger)]">
              {error}
            </div>
          ) : entries.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-[var(--text-tertiary)]">
              No subfolders here
            </div>
          ) : (
            <ul className="py-1">
              {entries.map((entry) => {
                const isDrive =
                  /^[a-zA-Z]:\\?$/.test(entry.path) ||
                  /^[a-zA-Z]:$/.test(entry.name);
                return (
                  <li key={entry.path}>
                    <button
                      type="button"
                      onClick={() => void load(entry.path)}
                      className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] transition-colors"
                    >
                      {isDrive ? (
                        <HardDrive className="h-4 w-4 shrink-0 text-[var(--accent-text)]" />
                      ) : (
                        <Folder className="h-4 w-4 shrink-0 text-[var(--info)]" />
                      )}
                      <span className="truncate font-mono text-[13px]">
                        {entry.name}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--border)] px-4 py-3 shrink-0">
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
      </div>
    </div>
  );
}
