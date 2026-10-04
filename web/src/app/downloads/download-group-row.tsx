import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import type { SeriesGroup } from "./grouping";
import { rollupChip } from "./release-display";
import { DownloadGroupSummary } from "./download-group-summary";
import { groupMenuItems } from "./row-menu";
import { downloadTitleHref } from "./download-links";
import type { ClientTorrent } from "./types";
import type { WantedGroup } from "./wanted-groups";
import { WantedMenuActions } from "./wanted-menu-actions";
import type { useDownloads } from "./use-downloads";

type WantedState = ReturnType<typeof useDownloads>["wanted"];

export function DownloadGroupRow({
  group,
  selected,
  onToggleGroupSelect,
  onOpenDetails,
  onActionMany,
  onDeleteRequest,
  wantedGroups = [],
  wantedState,
}: {
  group: SeriesGroup<ClientTorrent>;
  selected: Set<string>;
  onToggleGroupSelect: (transferIds: string[]) => void;
  onOpenDetails: (key: string, opener?: EventTarget | null) => void;
  onActionMany: (act: "pause" | "resume", transfers: ClientTorrent[]) => void;
  onDeleteRequest: (torrents: ClientTorrent[]) => void;
  wantedGroups: readonly WantedGroup[];
  wantedState: WantedState;
}) {
  const head = group.torrents[0];
  const transferIds = group.torrents.map((torrent) => torrent.transferId);
  const selectedCount = transferIds.filter((id) => selected.has(id)).length;
  const allSelected = transferIds.length > 0 && selectedCount === transferIds.length;
  const chip = rollupChip(group);
  return (
    <div className={cn(
      "grid grid-cols-[auto_minmax(0,1fr)] items-start gap-2 px-3 py-2.5 transition-colors max-md:pl-4 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center sm:gap-3",
      allSelected ? "bg-brand-dim" : "hover:bg-muted/60",
    )} data-download-group data-group-key={group.key}
      data-group-error={group.status === "error" || chip.failing ? "true" : undefined}>
      <Checkbox checked={allSelected ? true : selectedCount > 0 ? "indeterminate" : false}
        onCheckedChange={() => onToggleGroupSelect(transferIds)}
        aria-label={`Select all of ${group.title}`} className="shrink-0 max-md:z-[1]"/>
      <DownloadGroupSummary group={group} titleHref={downloadTitleHref(head)} posterUrl={head.posterUrl}
        wantedGroups={wantedGroups} />
      <div className="col-start-2 flex items-center justify-end gap-2 sm:col-start-auto lg:gap-1">
        <Button type="button" variant="secondary" size="sm"
          onClick={(event) => onOpenDetails(group.key, event.currentTarget)}
          aria-label={`Open downloads for ${group.title}`} data-group-details>
          Details<ChevronRight className="h-3.5 w-3.5"/>
        </Button>
        <WantedMenuActions groups={wantedGroups} onChanged={wantedState.reload} setRows={wantedState.setRows}
          label={`More actions for ${group.title}`} triggerProps={{ "data-group-more": "" }}>
          {groupMenuItems({ torrents: group.torrents, onActionMany, onDeleteRequest })}
        </WantedMenuActions>
      </div>
    </div>
  );
}
