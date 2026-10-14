import { useCallback, useState, type ReactNode } from "react";
import { CheckCircle2, ChevronDown, RotateCw } from "lucide-react";
import { PosterImage } from "@/components/browse/poster-image";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ImportCandidate, ImportItem, ImportResultItem } from "@/lib/library/import";
import { candidateLabel, fileName } from "@/lib/library/import";
import {
  episodeCode,
  importStatus,
  pickable,
  shelfSummary,
  topPick,
  type ImportPick,
  type ImportShelf,
} from "@/lib/library/import-shelves";
import { cn } from "@/lib/utils";

const LEAVE = "leave";

export type CandidatePick = ImportPick;

/** A titled block of shelves. `collapsible` blocks start closed and say how much they hold. */
export function ImportSection({
  id,
  title,
  count,
  collapsible = false,
  children,
}: {
  id: string;
  title: string;
  count: string;
  collapsible?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(!collapsible);
  const list = <ul className="space-y-2">{children}</ul>;
  if (!collapsible) {
    return (
      <section aria-labelledby={`import-${id}`} className="space-y-2" data-import-group={id}>
        <h3 id={`import-${id}`} className="flex items-baseline gap-2 text-[13px] font-medium text-foreground">
          {title}
          <span className="font-normal text-subtle-foreground tabular-nums">{count}</span>
        </h3>
        {list}
      </section>
    );
  }
  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <section aria-labelledby={`import-${id}`} className="space-y-2" data-import-group={id}>
        <h3 id={`import-${id}`}>
          <CollapsibleTrigger className="group flex min-h-9 w-full items-center gap-2 rounded-md text-left text-[13px] font-medium text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
            <ChevronDown aria-hidden className="size-4 shrink-0 text-subtle-foreground transition-transform group-data-[state=closed]:-rotate-90 motion-reduce:transition-none" />
            {title}
            <span className="font-normal text-subtle-foreground tabular-nums">{count}</span>
          </CollapsibleTrigger>
        </h3>
        <CollapsibleContent>{list}</CollapsibleContent>
      </section>
    </Collapsible>
  );
}

/**
 * One title the scan found, with every file that belongs to it: a film and
 * its file, or a show with its files grouped by season. The checkbox takes or
 * leaves every ready file at once; files that need a pick open by default.
 */
export function ImportShelfCard({
  shelf,
  picks,
  onPick,
}: {
  shelf: ImportShelf;
  picks: Record<string, ImportPick>;
  onPick: (itemId: string, pick: ImportPick) => void;
}) {
  const selectable = shelf.items.filter((item) => {
    const status = importStatus(item);
    return status === "ready" || status === "needsPick";
  });
  const chosen = selectable.filter((item) => picks[item.id] != null).length;
  const ready = shelf.items.filter((item) => importStatus(item) === "ready");
  const single = shelf.items.length === 1;
  const [open, setOpen] = useState(shelf.counts.needsPick > 0 && !single);
  const label = shelf.year ? `${shelf.title} (${shelf.year})` : shelf.title;

  function toggleAll(take: boolean) {
    for (const item of take ? ready : selectable) onPick(item.id, take ? topPick(item) : null);
  }

  return (
    <li className="overflow-hidden rounded-lg border border-border bg-card" data-import-shelf={shelf.key}>
      <div className="flex gap-3 p-3">
        <div className="relative aspect-[2/3] w-12 shrink-0 self-start overflow-hidden rounded-md bg-muted sm:w-14">
          <PosterImage src={shelf.posterUrl} title={shelf.title} sizes="56px" />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground" title={label}>
                {shelf.title}
                {shelf.year ? <span className="ml-1.5 font-normal text-subtle-foreground tabular-nums">{shelf.year}</span> : null}
              </p>
              <p className="text-xs text-subtle-foreground">{shelfSummary(shelf)}</p>
            </div>
            {!single && selectable.length > 0 && (ready.length > 0 || chosen > 0) ? (
              <label className="flex min-h-9 shrink-0 cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                <span className="tabular-nums">{chosen} of {selectable.length}</span>
                <Checkbox
                  checked={chosen === 0 ? false : chosen === selectable.length ? true : "indeterminate"}
                  onCheckedChange={(value) => toggleAll(value === true)}
                  aria-label={`Import ${label}`}
                  data-import-shelf-toggle
                />
              </label>
            ) : null}
          </div>
          <ShelfFlags shelf={shelf} />
          {single ? (
            <FileRow item={shelf.items[0]} shelf={shelf} pick={picks[shelf.items[0].id] ?? null} onPick={onPick} bare />
          ) : (
            <Collapsible open={open} onOpenChange={setOpen}>
              <CollapsibleTrigger className="group -ml-1 inline-flex min-h-8 items-center gap-1 rounded-md px-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50" data-import-shelf-files>
                <ChevronDown aria-hidden className="size-3.5 transition-transform group-data-[state=closed]:-rotate-90 motion-reduce:transition-none" />
                {open ? "Hide files" : `Show ${shelf.items.length} files`}
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-3 pt-2">
                {shelf.seasons.map((season) => (
                  <div key={season.number ?? "none"} className="space-y-1">
                    {shelf.seasons.length > 1 || season.number != null ? (
                      <h4 className="text-xs font-medium text-muted-foreground">
                        {season.number != null ? `Season ${season.number}` : "No season in the name"}
                      </h4>
                    ) : null}
                    <ul className="divide-y divide-border rounded-md border border-border">
                      {season.items.map((item) => (
                        <FileRow key={item.id} item={item} shelf={shelf} pick={picks[item.id] ?? null} onPick={onPick} />
                      ))}
                    </ul>
                  </div>
                ))}
              </CollapsibleContent>
            </Collapsible>
          )}
        </div>
      </div>
    </li>
  );
}

function ShelfFlags({ shelf }: { shelf: ImportShelf }) {
  const flags: ReactNode[] = [];
  if (shelf.counts.needsPick > 0)
    flags.push(<Badge key="pick" variant="accent">{shelf.counts.needsPick} {shelf.counts.needsPick === 1 ? "needs" : "need"} a pick</Badge>);
  if (shelf.counts.owned > 0 && shelf.counts.owned < shelf.items.length)
    flags.push(<Badge key="owned">{shelf.counts.owned} already in library</Badge>);
  if (shelf.counts.unmatched > 0 && shelf.counts.unmatched < shelf.items.length)
    flags.push(<Badge key="unmatched">{shelf.counts.unmatched} not recognised</Badge>);
  return flags.length > 0 ? <div className="flex flex-wrap gap-1.5">{flags}</div> : null;
}

function FileRow({
  item,
  shelf,
  pick,
  onPick,
  bare = false,
}: {
  item: ImportItem;
  shelf: ImportShelf;
  pick: ImportPick;
  onPick: (itemId: string, pick: ImportPick) => void;
  bare?: boolean;
}) {
  const status = importStatus(item);
  const code = shelf.kind === "Film" ? null : episodeCode(item, pick);
  const name = fileName(item.path);
  const note = status === "needsPick" || status === "unmatched" ? item.message : null;
  const Tag = bare ? "div" : "li";
  return (
    <Tag
      className={cn(
        "grid min-w-0 grid-cols-[minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 sm:grid-cols-[minmax(0,1fr)_15rem]",
        bare ? "pt-1" : "px-2.5 py-2",
      )}
      data-import-item={item.id}
    >
      <div className="flex min-w-0 items-baseline gap-2">
        {code ? <span className="w-14 shrink-0 text-xs font-medium text-foreground tabular-nums">{code}</span> : null}
        <span className="min-w-0">
          <span className="block truncate text-xs text-muted-foreground" title={item.path}>{name}</span>
          {note ? <span className="block text-xs text-subtle-foreground">{note}</span> : null}
        </span>
      </div>
      <div className="min-w-0 sm:justify-self-end">
        {status === "needsPick" ? (
          <CandidatePicker item={item} shelf={shelf} pick={pick} onPick={(next) => onPick(item.id, next)} />
        ) : status === "ready" ? (
          <label className="inline-flex min-h-9 cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <Checkbox checked={pick != null} onCheckedChange={(value) => onPick(item.id, value === true ? topPick(item) : null)}
              aria-label={`Import ${name}`} />
            Import
          </label>
        ) : (
          <span className="text-xs text-subtle-foreground">{status === "owned" ? "In your library" : "Left alone"}</span>
        )}
      </div>
    </Tag>
  );
}

/** Inside a shelf the title is already on screen, so its own episodes read "Season 1, episode 3". */
function pickLabel(candidate: ImportCandidate, shelf: ImportShelf): string {
  if (candidate.episodeId && `work:${candidate.workId}` === shelf.key)
    return `Season ${candidate.season}, episode ${candidate.episode}`;
  return candidateLabel(candidate);
}

export function CandidatePicker({
  item,
  shelf,
  pick,
  onPick,
}: {
  item: ImportItem;
  shelf: ImportShelf;
  pick: CandidatePick;
  onPick: (pick: CandidatePick) => void;
}) {
  const options = pickable(item);
  const index = pick
    ? options.findIndex((candidate) => candidate.workId === pick.workId && candidate.episodeId === pick.episodeId)
    : -1;

  return (
    <Select
      value={index >= 0 ? String(index) : LEAVE}
      onValueChange={(value) => {
        const option = value === LEAVE ? undefined : options[Number(value)];
        onPick(option ? { workId: option.workId, episodeId: option.episodeId } : null);
      }}
    >
      <SelectTrigger className="h-9 w-full text-xs sm:w-60 max-md:min-h-11 pointer-coarse:min-h-11" aria-label={`Match for ${fileName(item.path)}`}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={LEAVE}>Leave this file alone</SelectItem>
        {options.map((candidate, optionIndex) => (
          <SelectItem key={`${candidate.workId}:${candidate.episodeId}`} value={String(optionIndex)}>
            {pickLabel(candidate, shelf)}
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
