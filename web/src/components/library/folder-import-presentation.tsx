import { useCallback, type ReactNode } from "react";
import { CheckCircle2, RotateCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ImportItem, ImportResultItem } from "@/lib/library/import";
import { candidateLabel, fileName } from "@/lib/library/import";

const LEAVE = "leave";

export type CandidatePick = { workId: string; episodeId: string | null } | null;

export function ImportGroup({
  id,
  title,
  description,
  count,
  children,
}: {
  id: string;
  title: string;
  description: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={`import-${id}`} className="space-y-2" data-import-group={id}>
      <div className="flex items-baseline gap-2">
        <h3 id={`import-${id}`} className="text-[13px] font-medium text-foreground">
          {title}
        </h3>
        <Badge variant="outline">{count}</Badge>
      </div>
      <p className="text-xs text-subtle-foreground">{description}</p>
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
        {children}
      </ul>
    </section>
  );
}

export function ImportRow({ item, children }: { item: ImportItem; children?: ReactNode }) {
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

export function CandidatePicker({
  item,
  pick,
  onPick,
}: {
  item: ImportItem;
  pick: CandidatePick;
  onPick: (pick: CandidatePick) => void;
}) {
  const options = item.candidates.filter((candidate) => candidate.kind === "Film" || candidate.episodeId);
  const index = pick
    ? options.findIndex(
        (candidate) =>
          candidate.workId === pick.workId && candidate.episodeId === pick.episodeId,
      )
    : -1;

  return (
    <Select
      value={index >= 0 ? String(index) : LEAVE}
      onValueChange={(value) =>
        onPick(
          value === LEAVE
            ? null
            : {
                workId: options[Number(value)].workId,
                episodeId: options[Number(value)].episodeId,
              },
        )
      }
    >
      <SelectTrigger className="w-full max-md:min-h-11 pointer-coarse:min-h-11" aria-label={`Match for ${fileName(item.path)}`}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={LEAVE}>Leave this file alone</SelectItem>
        {options.map((candidate, optionIndex) => (
          <SelectItem
            key={`${candidate.workId}:${candidate.episodeId}`}
            value={String(optionIndex)}
          >
            {candidateLabel(candidate)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function ImportResult({
  items,
  onDone,
}: {
  items: ImportResultItem[];
  onDone: () => void;
}) {
  const imported = items.filter((item) => item.imported).length;
  const owned = items.filter((item) => !item.imported && item.alreadyInLibrary).length;
  const failed = items.filter((item) => !item.imported && !item.alreadyInLibrary);
  const focusOnMount = useCallback((node: HTMLDivElement | null) => node?.focus(), []);

  return (
    <div
      ref={focusOnMount}
      tabIndex={-1}
      className="space-y-3 rounded-lg border border-border bg-card p-4 outline-none"
      role="status"
      data-import-result
    >
      <p className="flex items-center gap-2 text-sm font-medium text-foreground">
        <CheckCircle2 className="size-4 text-success" aria-hidden />
        Import finished
      </p>
      <p className="text-[13px] text-muted-foreground">
        {imported} imported, {owned} already in your library, {failed.length} failed
      </p>
      {failed.length > 0 ? (
        <ul className="space-y-1 text-xs text-destructive">
          {[...new Set(failed.map((item) => item.error ?? "Could not import this file. Scan the folder again."))].map((message) => (
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
