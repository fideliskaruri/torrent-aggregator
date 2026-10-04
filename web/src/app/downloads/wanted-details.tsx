import { WantedActions } from "@/components/wanted/wanted-actions";
import { wantedRowMatches } from "@/components/wanted/wanted-actions";
import { wantedGroupName, wantedRowLabel, type WantedGroup } from "./wanted-groups";
import type { useDownloads } from "./use-downloads";

type WantedState = ReturnType<typeof useDownloads>["wanted"];

function requestedLabels(groups: readonly WantedGroup[]): string {
  return groups.flatMap((group) => group.rows.map((row) => row.season == null ? group.title : wantedRowLabel(row)))
    .join(", ");
}

export function WantedDetails({ groups, wanted }: { groups: readonly WantedGroup[]; wanted: WantedState }) {
  if (!groups.length) return null;
  return (
    <div className="space-y-2 border-t border-border pt-2" data-wanted-details>
      <p className="text-[12px] leading-snug text-muted-foreground">
        <span className="font-medium text-foreground">Still looking:</span> {requestedLabels(groups)}
      </p>
      <div className="flex flex-col gap-2">
        {groups.map((group) => (
          <div key={group.key} className="flex flex-wrap items-center justify-between gap-2">
            <span className="min-w-0 text-[12px] text-subtle-foreground">{wantedGroupName(group)}</span>
            <WantedActions
              target={group}
              name={wantedGroupName(group)}
              pickTitle={group.name}
              looking={group.looking}
              onChanged={wanted.reload}
              onRemoved={() => wanted.setRows((current) => current.filter((row) => !wantedRowMatches(row, group)))}
              className="shrink-0"
            />
          </div>
        ))}
      </div>
    </div>
  );
}
