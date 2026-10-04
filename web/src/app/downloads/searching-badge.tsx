import { Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { wantedGroupStateLabel, wantedTooltip, type WantedGroup } from "./wanted-groups";

export function SearchingBadge({ groups }: { groups: readonly WantedGroup[] }) {
  if (!groups.length) return null;
  const searching = groups.some((group) => group.looking);
  const label = searching
    ? "Searching"
    : groups.map(wantedGroupStateLabel).find((state) => state !== "Not found yet" && state !== "Searching")
      ?? "Not found yet";
  return (
    <Badge
      variant="outline"
      title={wantedTooltip(groups)}
      data-searching-badge
      data-searching={searching || undefined}
    >
      {searching ? <Spinner className="size-3" /> : <Search aria-hidden className="size-3" />}
      {label}
    </Badge>
  );
}
