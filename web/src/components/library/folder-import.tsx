import { useCallback, useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { CheckCircle2, FolderSearch, RotateCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { LoadingGlyph } from "@/components/ui/loading";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ConfirmDialog } from "@/components/tf/confirm-dialog";
import { TfEmptyState } from "@/components/tf/empty-state";
import { TfErrorState } from "@/components/tf/error-state";
import {
  IMPORT_MODES,
  candidateLabel,
  fileName,
  libraryRequest,
  type ImportItem,
  type ImportMode,
  type ImportResultItem,
  type ImportScan,
} from "@/lib/library/import";

const TOUCH = "max-md:min-h-11 pointer-coarse:min-h-11";
const LEAVE = "leave";

type Pick = { workId: string; episodeId: string | null } | null;
type GroupKey = "confident" | "needsPick" | "duplicates" | "unmatched" | "owned";

const GROUPS: { key: GroupKey; title: string; description: string }[] = [
  { key: "needsPick", title: "Needs a pick", description: "Choose the right title or episode, or leave the file alone." },
  { key: "duplicates", title: "Duplicates", description: "Choose which file to keep. The others stay where they are; nothing is deleted." },
  { key: "confident", title: "Ready", description: "These matched one title. Clear any you don't want." },
  { key: "unmatched", title: "Unmatched", description: "No title matched. These files are left alone." },
  { key: "owned", title: "Already in your library", description: "Nothing to do for these." },
];

function groupOf(item: ImportItem, duplicateIds: Set<string>): GroupKey {
  if (item.alreadyInLibrary) return "owned";
  if (duplicateIds.has(item.id)) return "duplicates";
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
  const [mode, setMode] = useState<ImportMode>("TrackInPlace");
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

  const duplicateIds = useMemo(() => new Set(scan?.duplicates.flatMap((d) => d.itemIds) ?? []), [scan]);
  const grouped = useMemo(() => {
    const map = new Map<GroupKey, ImportItem[]>(GROUPS.map((g) => [g.key, []]));
    for (const item of scan?.items ?? []) map.get(groupOf(item, duplicateIds))?.push(item);
    return map;
  }, [scan, duplicateIds]);
  const selected = Object.entries(picks).filter((entry): entry is [string, NonNullable<Pick>] => entry[1] !== null);

  async function confirm() {
    if (!scanId) return;
    setImporting(true);
    setConfirmError(null);
    try {
      const answer = await libraryRequest<{ items: ImportResultItem[] }>("POST", `/api/library/imports/${scanId}/confirm`, {
        mode,
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
            onChange={(event) => setPath(event.target.value)} className={`font-mono ${TOUCH}`} />
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
                {group.key === "duplicates"
                  ? (scan.duplicates.map((dup) => (
                      <DuplicateSet key={dup.key} items={items.filter((i) => dup.itemIds.includes(i.id))} picks={picks}
                        onKeep={(keepId) => setPicks((current) => {
                          const next = { ...current };
                          for (const id of dup.itemIds) next[id] = null;
                          const kept = items.find((i) => i.id === keepId);
                          if (kept) next[keepId] = choice(kept, 0);
                          return next;
                        })} />
                    )))
                  : items.map((item) => (
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

          <fieldset className="space-y-2 rounded-lg border border-border bg-card p-3 sm:p-4">
            <legend className="px-1 text-[13px] font-medium text-foreground">What to do with the files</legend>
            <RadioGroup value={mode} onValueChange={(value) => setMode(value as ImportMode)} className="gap-1">
              {IMPORT_MODES.map((option) => (
                <label key={option.value} htmlFor={`${pathId}-${option.value}`}
                  className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md p-2 hover:bg-muted/50">
                  <RadioGroupItem id={`${pathId}-${option.value}`} value={option.value} className="mt-0.5" />
                  <span className="space-y-0.5">
                    <span className="block text-[13px] text-foreground">{option.label}</span>
                    <span className="block text-xs text-subtle-foreground">{option.hint}</span>
                  </span>
                </label>
              ))}
            </RadioGroup>
          </fieldset>

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
        description={IMPORT_MODES.find((m) => m.value === mode)?.label ?? ""}
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
  const duplicateIds = new Set(scan.duplicates.flatMap((d) => d.itemIds));
  const picks: Record<string, Pick> = {};
  for (const item of scan.items) picks[item.id] = groupOf(item, duplicateIds) === "confident" ? choice(item, 0) : null;
  return picks;
}

function ImportGroup({ id, title, description, count, children }: {
  id: string; title: string; description: string; count: number; children: ReactNode;
}) {
  return (
    <section aria-labelledby={`import-${id}`} className="space-y-2" data-import-group={id}>
      <div className="flex items-baseline gap-2">
        <h3 id={`import-${id}`} className="text-[13px] font-medium text-foreground">{title}</h3>
        <Badge variant="outline">{count}</Badge>
      </div>
      <p className="text-xs text-subtle-foreground">{description}</p>
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">{children}</ul>
    </section>
  );
}

function ImportRow({ item, children }: { item: ImportItem; children?: ReactNode }) {
  return (
    <li className="flex min-w-0 flex-col gap-2 p-3 sm:flex-row sm:items-center" data-import-item>
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="break-all text-[13px] text-foreground">{fileName(item.path)}</p>
        {item.message ? <p className="text-xs text-subtle-foreground">{item.message}</p> : null}
      </div>
      {children ? <div className="w-full shrink-0 sm:w-72">{children}</div> : null}
    </li>
  );
}

function CandidatePicker({ item, pick, onPick }: { item: ImportItem; pick: Pick; onPick: (pick: Pick) => void }) {
  const options = item.candidates.filter((c) => c.kind === "Film" || c.episodeId);
  const index = pick ? options.findIndex((c) => c.workId === pick.workId && c.episodeId === pick.episodeId) : -1;
  return (
    <Select value={index >= 0 ? String(index) : LEAVE}
      onValueChange={(value) => onPick(value === LEAVE ? null : { workId: options[Number(value)].workId, episodeId: options[Number(value)].episodeId })}>
      <SelectTrigger className={`w-full ${TOUCH}`} aria-label={`Match for ${fileName(item.path)}`}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={LEAVE}>Leave this file alone</SelectItem>
        {options.map((candidate, i) => (
          <SelectItem key={`${candidate.workId}:${candidate.episodeId}`} value={String(i)}>{candidateLabel(candidate)}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function DuplicateSet({ items, picks, onKeep }: { items: ImportItem[]; picks: Record<string, Pick>; onKeep: (id: string) => void }) {
  const kept = items.find((i) => picks[i.id]) ?? null;
  const label = items[0]?.candidates[0] ? candidateLabel(items[0].candidates[0]) : "This item";
  return (
    <li className="space-y-1 p-3">
      <p className="text-[13px] font-medium text-foreground">{label}</p>
      <RadioGroup value={kept?.id ?? LEAVE} onValueChange={onKeep} aria-label={`Which file to keep for ${label}`} className="gap-0">
        {items.map((item) => (
          <label key={item.id} htmlFor={`keep-${item.id}`} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-1 hover:bg-muted/50">
            <RadioGroupItem id={`keep-${item.id}`} value={item.id} />
            <span className="min-w-0 space-y-0.5">
              <span className="block break-all text-[13px] text-foreground">{fileName(item.path)}</span>
              <span className="block text-xs text-subtle-foreground">{item.message}</span>
            </span>
          </label>
        ))}
        <label htmlFor={`keep-none-${items[0]?.id}`} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-1 hover:bg-muted/50">
          <RadioGroupItem id={`keep-none-${items[0]?.id}`} value={LEAVE} />
          <span className="text-[13px] text-foreground">Import none of these</span>
        </label>
      </RadioGroup>
    </li>
  );
}

function ImportResult({ items, onDone }: { items: ImportResultItem[]; onDone: () => void }) {
  const imported = items.filter((i) => i.imported).length;
  const owned = items.filter((i) => !i.imported && i.alreadyInLibrary).length;
  const failed = items.filter((i) => !i.imported && !i.alreadyInLibrary);
  const focusOnMount = useCallback((node: HTMLDivElement | null) => node?.focus(), []);
  return (
    <div ref={focusOnMount} tabIndex={-1} className="space-y-3 rounded-lg border border-border bg-card p-4 outline-none" role="status" data-import-result>
      <p className="flex items-center gap-2 text-sm font-medium text-foreground">
        <CheckCircle2 className="size-4 text-success" aria-hidden />
        Import finished
      </p>
      <p className="text-[13px] text-muted-foreground">
        {imported} imported, {owned} already in your library, {failed.length} failed
      </p>
      {failed.length > 0 ? (
        <ul className="space-y-1 text-xs text-destructive">
          {[...new Set(failed.map((f) => f.error ?? "Could not import this file. Scan the folder again."))].map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : null}
      <Button type="button" size="sm" variant="secondary" onClick={onDone}>
        <RotateCw aria-hidden />
        Import another folder
      </Button>
    </div>
  );
}
