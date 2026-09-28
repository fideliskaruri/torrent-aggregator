import type { Ref } from "react";
import { FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * The download folder and space limit fields.
 *
 * Settings and the first-download setup dialog render this same component, so
 * the question a new owner answers inline is exactly the one Settings asks.
 */
export function DownloadLocationFields({
  idPrefix = "",
  folder,
  onFolderChange,
  onBrowse,
  spaceGb,
  onSpaceGbChange,
  spaceInputRef,
}: {
  /** Keeps ids unique when Settings and the dialog are both mounted. */
  idPrefix?: string;
  folder: string;
  onFolderChange: (value: string) => void;
  onBrowse: () => void;
  spaceGb: string;
  onSpaceGbChange: (value: string) => void;
  spaceInputRef?: Ref<HTMLInputElement>;
}) {
  const folderId = `${idPrefix}download-folder`;
  const limitId = `${idPrefix}storage-limit`;
  return (
    <>
      <div className="min-w-0 space-y-1.5">
        <label
          htmlFor={folderId}
          className="text-xs font-medium text-[var(--text-secondary)]"
        >
          Download folder
        </label>
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            id={folderId}
            value={folder}
            onChange={(event) => onFolderChange(event.target.value)}
            className="h-11 w-full min-w-0 scroll-mb-32 font-mono text-base sm:text-sm"
            placeholder="Choose a folder or enter its path"
            autoComplete="off"
            title={folder || undefined}
          />
          <Button
            type="button"
            variant="secondary"
            className="h-11 w-full shrink-0 sm:w-auto"
            onClick={onBrowse}
          >
            <FolderOpen />
            Browse
          </Button>
        </div>
        {folder.trim() ? (
          <p
            className="break-all font-mono text-xs leading-relaxed text-[var(--text-tertiary)]"
            data-download-folder-path
          >
            {folder}
          </p>
        ) : null}
      </div>

      <div className="min-w-0 space-y-1.5">
        <label
          htmlFor={limitId}
          className="text-xs font-medium text-[var(--text-secondary)]"
        >
          Space limit
        </label>
        <div className="flex min-w-0 flex-col gap-2 sm:max-w-[14rem] sm:flex-row sm:items-center">
          <Input
            ref={spaceInputRef}
            id={limitId}
            type="number"
            min={0}
            step={1}
            inputMode="decimal"
            value={spaceGb}
            onChange={(event) => onSpaceGbChange(event.target.value)}
            className="h-11 w-full min-w-0 scroll-mb-32 text-base sm:text-sm"
            aria-describedby={`${limitId}-help`}
          />
          <span className="shrink-0 text-sm text-[var(--text-secondary)]">GB</span>
        </div>
        <p
          id={`${limitId}-help`}
          className="text-xs leading-relaxed text-[var(--text-tertiary)] break-words"
        >
          Downloads pause before going beyond this amount.
        </p>
      </div>
    </>
  );
}
