import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { FolderSearch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { LoadingGlyph } from "@/components/ui/loading";
import { Progress } from "@/components/ui/progress";
import { ConfirmDialog } from "@/components/tf/confirm-dialog";
import { TfEmptyState } from "@/components/tf/empty-state";
import { TfErrorState } from "@/components/tf/error-state";
import {
  libraryRequest,
  type ImportItem,
  type ImportResultItem,
  type ImportScan,
} from "@/lib/library/import";
import {
  type CandidatePick,
  CandidatePicker,
  ImportGroup,
  ImportResult,
  ImportRow,
} from "./folder-import-presentation";

type Pick = CandidatePick;
type GroupKey = "confident" | "needsPick" | "unmatched" | "owned";

const GROUPS: { key: GroupKey; title: string; description: string }[] = [
  { key: "needsPick", title: "Needs a pick", description: "Choose the right title or episode, or leave the file alone." },
  { key: "confident", title: "Ready", description: "These matched one title. Clear any you don't want." },
  { key: "unmatched", title: "Unmatched", description: "No title matched. These files are left alone." },
  { key: "owned", title: "Already in your library", description: "Nothing to do for these." },
];

function groupOf(item: ImportItem): GroupKey {
  if (item.alreadyInLibrary) return "owned";
  if (item.group === "Confident") return "confident";
  if (item.group === "NeedsPick" && item.candidates.some((c) => c.kind === "Film" || c.episodeId)) return "needsPick";
  return "unmatched";
}

function choice(item: ImportItem, index: number): Pick {
  const candidate = item.candidates[index];
  return candidate ? { workId: candidate.workId, episodeId: candidate.episodeId } : null;
}

/** Pick a folder, scan it, review the matches and import with one mode. Nothing changes before confirm. */
export function FolderImport() {
  const pathId = useId();
  const [path, setPath] = useState("");
  const [pathError, setPathError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [scanId, setScanId] = useState<string | null>(null);
  const [scan, setScan] = useState<ImportScan | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [pollKey, setPollKey] = useState(0);
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [confirming, setConfirming] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResultItem[] | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const finished = scan?.state === "complete" || scan?.state === "failed";
  useEffect(() => {
    if (!scanId || finished) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const next = await libraryRequest<ImportScan>("GET", `/api/library/imports/${scanId}`);
        if (cancelled) return;
        setPollError(null);
        setScan(next);
        if (next.state === "complete") setPicks(defaultPicks(next));
      } catch (error) {
        if (!cancelled) setPollError(error instanceof Error ? error.message : "Lost track of the scan.");
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [scanId, finished, pollKey]);

  async function start(event: FormEvent) {
    event.preventDefault();
    if (!path.trim()) return setPathError("Type the full path of the folder to import, for example E:\\Old movies.");
    setStarting(true);
    setPathError(null);
    try {
      const accepted = await libraryRequest<{ scanId: string }>("POST", "/api/library/imports/scan", { path: path.trim() });
      setScan(null);
      setResult(null);
      setScanId(accepted.scanId);
    } catch (error) {
      setPathError(error instanceof Error ? error.message : "Could not scan this folder. Try again.");
    } finally {
      setStarting(false);
    }
  }

  function reset() {
    setScanId(null);
    setScan(null);
    setResult(null);
    setPicks({});
    setPollError(null);
  }

  const grouped = useMemo(() => {
    const map = new Map<GroupKey, ImportItem[]>(GROUPS.map((g) => [g.key, []]));
    for (const item of scan?.items ?? []) map.get(groupOf(item))?.push(item);
    return map;
  }, [scan]);
  const selected = Object.entries(picks).filter((entry): entry is [string, NonNullable<Pick>] => entry[1] !== null);

  async function confirm() {
    if (!scanId) return;
    setImporting(true);
    setConfirmError(null);
    try {
      const answer = await libraryRequest<{ items: ImportResultItem[] }>("POST", `/api/library/imports/${scanId}/confirm`, {
        items: selected.map(([itemId, pick]) => ({ itemId, workId: pick.workId, episodeId: pick.episodeId })),
      });
      setResult(answer.items);
      setConfirming(false);
    } catch (error) {
      setConfirmError(error instanceof Error ? error.message : "The import didn't start. Try again.");
    } finally {
      setImporting(false);
    }
  }

  if (result) return <ImportResult items={result} onDone={reset} />;

  return (
    <div className="space-y-4">
      <form onSubmit={(event) => void start(event)} className="flex flex-col gap-3 sm:flex-row sm:items-end" data-import-form>
        <FormField label="Folder to import" htmlFor={pathId} className="min-w-0 flex-1">
          <Input id={pathId} value={path} placeholder="E:\Old movies" spellCheck={false} autoComplete="off"
            aria-invalid={pathError !== null} aria-describedby={pathError ? `${pathId}-error` : undefined}
            onChange={(event) => setPath(event.target.value)} className="font-mono max-md:min-h-11 pointer-coarse:min-h-11" />
        </FormField>
        <Button type="submit" size="sm" disabled={starting || (scanId !== null && !finished)}>
          {starting ? <LoadingGlyph className="size-3.5" /> : <FolderSearch aria-hidden />}
          Scan folder
        </Button>
      </form>
      {pathError ? <p id={`${pathId}-error`} role="alert" className="text-xs text-destructive">{pathError}</p> : null}

      {pollError && !scan ? (
        <TfErrorState title="Could not follow the scan" message={pollError} onRetry={() => setPollKey((k) => k + 1)} />
      ) : null}

      {scanId && !finished && !pollError ? (
        <div className="space-y-2 rounded-lg border border-border bg-card p-4" role="status" aria-live="polite" data-scan-progress>
          <div className="flex items-center justify-between gap-2 text-[13px]">
            <span className="flex items-center gap-2 text-foreground"><LoadingGlyph className="size-3.5" />Scanning</span>
            <span className="text-subtle-foreground">
              {scan && scan.total > 0 ? `${scan.scanned} of ${scan.total} videos` : "Looking for videos"}
            </span>
          </div>
          <Progress value={scan && scan.total > 0 ? (scan.scanned / scan.total) * 100 : 0} aria-label="Scan progress" />
          <p className="text-xs text-subtle-foreground">Nothing changes until you confirm.</p>
        </div>
      ) : null}

      {scan?.state === "failed" ? (
        <TfErrorState title="The scan stopped" message={scan.error ?? "Scan the folder again."} onRetry={() => void start({ preventDefault() {} } as FormEvent)} />
      ) : null}

      {scan?.state === "complete" && scan.items.length === 0 ? (
        <TfEmptyState icon={FolderSearch} title="No videos in this folder"
          description="Only video files are imported. Choose a folder that holds films or episodes." className="py-10" />
      ) : null}

      {scan?.state === "complete" && scan.items.length > 0 ? (
        <div className="space-y-4" data-import-review>
          <p className="text-[13px] text-subtle-foreground">
            Found {scan.items.length} {scan.items.length === 1 ? "video" : "videos"}. Nothing changes until you confirm.
          </p>
          {GROUPS.map((group) => {
            const items = grouped.get(group.key) ?? [];
            if (items.length === 0) return null;
            return (
              <ImportGroup key={group.key} id={group.key} title={group.title} description={group.description} count={items.length}>
                {items.map((item) => (
                      <ImportRow key={item.id} item={item}>
                        {group.key === "confident" || group.key === "needsPick" ? (
                          <CandidatePicker item={item} pick={picks[item.id] ?? null}
                            onPick={(pick) => setPicks((current) => ({ ...current, [item.id]: pick }))} />
                        ) : null}
                      </ImportRow>
                    ))}
              </ImportGroup>
            );
          })}

          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" disabled={selected.length === 0} onClick={() => setConfirming(true)} data-import-confirm>
              Import {selected.length} {selected.length === 1 ? "file" : "files"}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={reset}>Cancel</Button>
            {selected.length === 0 ? (
              <span className="text-xs text-subtle-foreground">Pick at least one file to import.</span>
            ) : null}
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => { setConfirming(open); if (!open) setConfirmError(null); }}
        title={`Import ${selected.length} ${selected.length === 1 ? "file" : "files"}?`}
        description="Files stay at their current paths and are added to your library."
        confirmLabel="Import"
        busy={importing}
        onConfirm={() => void confirm()}
      >
        {confirmError ? <p role="alert" className="text-xs text-destructive">{confirmError}</p> : null}
      </ConfirmDialog>
    </div>
  );
}

function defaultPicks(scan: ImportScan): Record<string, Pick> {
  const picks: Record<string, Pick> = {};
  for (const item of scan.items) picks[item.id] = groupOf(item) === "confident" ? choice(item, 0) : null;
  return picks;
}
