"use client";

import { FormEvent, useRef } from "react";
import { FolderOpen, HardDrive } from "lucide-react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LoadingGlyph } from "@/components/ui/loading";

interface FirstRunSetupProps {
  open: boolean;
  folder: string;
  storageCapGb: string;
  saving: boolean;
  error: string | null;
  folderWarning?: string | null;
  onFolderChange: (value: string) => void;
  onStorageCapChange: (value: string) => void;
  onBrowse: () => void;
  onSkip: () => void;
  onSave: (event: FormEvent<HTMLFormElement>) => void;
}

export function FirstRunSetup({
  open,
  folder,
  storageCapGb,
  saving,
  error,
  folderWarning,
  onFolderChange,
  onStorageCapChange,
  onBrowse,
  onSkip,
  onSave,
}: FirstRunSetupProps) {
  const folderRef = useRef<HTMLInputElement>(null);
  const cap = Number(storageCapGb);
  const canSave = Boolean(folder.trim()) && Number.isFinite(cap) && cap > 0;

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && open) onSkip();
      }}
    >
      <AlertDialogContent
        className="max-w-lg gap-5 p-5 sm:p-6"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          folderRef.current?.focus();
        }}
      >
        <AlertDialogHeader className="gap-2">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--accent-dim)] text-[var(--accent-text)] ring-1 ring-[var(--accent-ring)]">
            <HardDrive className="h-5 w-5" />
          </div>
          <AlertDialogTitle className="text-lg">
            Choose where your library lives
          </AlertDialogTitle>
          <AlertDialogDescription className="leading-relaxed">
            TorrentFlow needs a permanent folder and a storage limit before it
            can save anything. These are yours to choose, so the app will not
            guess.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <form onSubmit={onSave} className="space-y-5">
          <div className="space-y-2">
            <div className="flex min-h-11 items-center justify-between gap-3">
              <label
                htmlFor="first-run-download-folder"
                className="text-sm font-medium text-[var(--text)]"
              >
                Download folder
              </label>
              <Button type="button" variant="secondary" onClick={onBrowse}>
                <FolderOpen className="h-4 w-4" />
                Browse
              </Button>
            </div>
            <Input
              ref={folderRef}
              id="first-run-download-folder"
              className="h-11 font-mono"
              value={folder}
              onChange={(event) => onFolderChange(event.target.value)}
              placeholder="D:\Media\TorrentFlow or /media/torrentflow"
              autoComplete="off"
            />
            {folderWarning ? (
              <p
                role="status"
                className="text-xs leading-relaxed text-[var(--warning)]"
              >
                {folderWarning}
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <label
              htmlFor="first-run-storage-cap"
              className="text-sm font-medium text-[var(--text)]"
            >
              Storage cap
            </label>
            <div className="flex items-center gap-2">
              <Input
                id="first-run-storage-cap"
                type="number"
                inputMode="decimal"
                min={0}
                step={1}
                className="h-11 min-w-0"
                value={storageCapGb}
                onChange={(event) => onStorageCapChange(event.target.value)}
                aria-describedby="first-run-storage-cap-help"
              />
              <span className="shrink-0 text-sm text-[var(--text-secondary)]">
                GB
              </span>
            </div>
            <p
              id="first-run-storage-cap-help"
              className="text-xs leading-relaxed text-[var(--text-tertiary)]"
            >
              New downloads pause before crossing this limit. Entering 0 keeps
              setup incomplete.
            </p>
          </div>

          {error ? (
            <p role="alert" className="text-sm text-[var(--danger)]">
              {error}
            </p>
          ) : null}

          <AlertDialogFooter>
            <AlertDialogCancel type="button" onClick={onSkip}>
              Skip for now
            </AlertDialogCancel>
            <Button type="submit" size="lg" disabled={!canSave || saving}>
              {saving ? <LoadingGlyph className="h-4 w-4" /> : null}
              Save and continue
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
