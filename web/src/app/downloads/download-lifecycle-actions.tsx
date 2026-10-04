import { Pause, Play, Trash2, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";

type LifecycleAction = "pause" | "resume" | "delete";

const ACTIONS: Record<LifecycleAction, { Icon: LucideIcon; label: string }> = {
  pause: { Icon: Pause, label: "Pause" },
  resume: { Icon: Play, label: "Resume" },
  delete: { Icon: Trash2, label: "Delete" },
};

export function DownloadLifecycleActions({
  mode,
  onPause,
  onResume,
  onDelete,
  canPause = true,
  canResume = true,
  showPause = true,
  showResume = true,
  pauseLabel = "Pause",
  resumeLabel = "Resume",
  deleteLabel = "Delete",
  pauseData,
  resumeData,
  deleteData,
}: {
  mode: "bulk" | "menu";
  onPause?: () => void;
  onResume?: () => void;
  onDelete: () => void;
  canPause?: boolean;
  canResume?: boolean;
  showPause?: boolean;
  showResume?: boolean;
  pauseLabel?: string;
  resumeLabel?: string;
  deleteLabel?: string;
  pauseData?: Record<string, string | undefined>;
  resumeData?: Record<string, string | undefined>;
  deleteData?: Record<string, string | undefined>;
}) {
  const actions = [
    { key: "pause" as const, callback: onPause, shown: showPause, enabled: canPause, label: pauseLabel, data: pauseData },
    { key: "resume" as const, callback: onResume, shown: showResume, enabled: canResume, label: resumeLabel, data: resumeData },
    { key: "delete" as const, callback: onDelete, shown: true, enabled: true, label: deleteLabel, data: deleteData },
  ];

  const visible = actions.filter((action) => action.shown);
  return visible.flatMap(({ key, callback, enabled, label, data }) => {
    const { Icon } = ACTIONS[key];
    const divider = mode === "menu" && key === "delete" && visible.length > 1
      ? [<DropdownMenuSeparator key="lifecycle-divider" />]
      : [];
    if (mode === "bulk") {
      return [...divider, (
        <Button key={key} type="button" size="sm" variant={key === "delete" ? "destructive" : "secondary"}
          aria-disabled={!enabled || undefined}
          onClick={() => { if (enabled) callback?.(); }}
          {...data}>
          <Icon className="h-3.5 w-3.5" />{label}
        </Button>
      )];
    }
    return [...divider, (
      <DropdownMenuItem key={key} variant={key === "delete" ? "destructive" : "default"}
        onClick={callback} {...data}>
        <Icon />{label}
      </DropdownMenuItem>
    )];
  });
}
