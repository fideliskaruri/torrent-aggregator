import { Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { wantedTooltip, type WantedGroup } from "./wanted-groups";

export function SearchingBadge({ groups, label }: { groups: readonly WantedGroup[]; label?: string }) {
  if (!groups.length) return null;
  const searching = groups.some((group) => group.looking);
  const statusLabel = groups.find((group) => group.looking)?.statusLabel ?? groups[0].statusLabel;
  return (
    <Badge
      variant="outline"
      title={wantedTooltip(groups)}
      data-searching-badge
      data-searching={searching || undefined}
    >
      {searching ? <Spinner className="size-3" /> : <Search aria-hidden className="size-3" />}
      {label ?? statusLabel}
    </Badge>
  );
}
