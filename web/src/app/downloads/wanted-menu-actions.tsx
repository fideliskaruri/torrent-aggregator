import { Fragment, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { RefreshCw, Search, Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/tf/confirm-dialog";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { openReleasePicker, PICK_RELEASE_LABEL } from "@/components/releases/release-picker-store";
import {
  stopWanted,
  wantedRemoveDescription,
  wantedRowMatches,
  tryWantedNow,
  type WantedRow,
} from "@/components/wanted/wanted-actions";
import { toast } from "@/lib/toast";
import { wantedGroupName, type WantedGroup } from "./wanted-groups";
import { IconMenuButton } from "./row-menu";

export function WantedMenuActions({
  groups,
  onChanged,
  setRows,
  includePick = true,
  label,
  triggerProps,
  children,
}: {
  groups: readonly WantedGroup[];
  onChanged: () => void | Promise<void>;
  setRows: Dispatch<SetStateAction<WantedRow[]>>;
  includePick?: boolean;
  label: string;
  triggerProps?: Record<string, string | undefined>;
  children?: ReactNode;
}) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<WantedGroup | null>(null);

  const tryNow = async (group: WantedGroup) => {
    setBusyKey(group.key);
    try {
      if (!(await tryWantedNow(group))) throw new Error("refused");
      toast.success(`Looking for ${wantedGroupName(group)} now.`);
      await onChanged();
    } catch {
      toast.error(`Couldn't start a search for ${wantedGroupName(group)}. Check that TorrentFlow is running, then try again.`);
    } finally {
      setBusyKey(null);
    }
  };

  const remove = async (group: WantedGroup) => {
    setBusyKey(group.key);
    try {
      if (!(await stopWanted(group))) throw new Error("refused");
      setRows((current) => current.filter((row) => !wantedRowMatches(row, group)));
      toast.success(`Removed ${wantedGroupName(group)}. TorrentFlow stopped looking for it.`);
      setConfirming(null);
      await onChanged();
    } catch {
      toast.error(`Couldn't remove ${wantedGroupName(group)}. Check that TorrentFlow is running, then try again.`);
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <IconMenuButton label={label} triggerProps={triggerProps} after={groups.map((group) => (
      <ConfirmDialog
        key={group.key}
        open={confirming?.key === group.key}
        onOpenChange={(open) => { if (!open) setConfirming(null); }}
        contentData={{ "data-looking-remove-dialog": true }}
        confirmData={{ "data-looking-remove-confirm": true }}
        title={`Remove ${wantedGroupName(group)}?`}
        description={wantedRemoveDescription(group)}
        variant="destructive"
        busy={confirming?.key === group.key && busyKey === group.key}
        icon={<Trash2 className="size-3.5" />}
        confirmLabel="Remove"
        onConfirm={() => void remove(group)}
      />
    ))}>
          {children}
          {children ? <DropdownMenuSeparator /> : null}
          {groups.map((group) => (
            <Fragment key={group.key}>
              {groups.length > 1 ? (
                <DropdownMenuItem disabled>{group.label ?? group.title}</DropdownMenuItem>
              ) : null}
              {includePick ? (
                <DropdownMenuItem
                  onSelect={() => openReleasePicker({
                    workKey: group.workKey,
                    title: group.name,
                    season: group.season,
                    episode: group.episode,
                    onPicked: () => void onChanged(),
                  })}
                  data-looking-pick
                >
                  <Search />
                  {PICK_RELEASE_LABEL}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem
                disabled={busyKey === group.key || group.looking}
                onSelect={() => void tryNow(group)}
                data-looking-try
              >
                <RefreshCw />
                {groups.length > 1 ? `Try now for ${group.label ?? group.title}` : "Try now"}
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                disabled={busyKey === group.key}
                onSelect={() => setConfirming(group)}
                data-looking-remove
              >
                <Trash2 />
                {groups.length > 1 ? `Remove ${group.label ?? group.title} search` : "Remove search"}
              </DropdownMenuItem>
              {groups.length > 1 ? <DropdownMenuSeparator /> : null}
            </Fragment>
          ))}
    </IconMenuButton>
  );
}
