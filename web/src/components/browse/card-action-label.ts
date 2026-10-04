import type { ActionStatus, CatalogCardAction } from "@/lib/api/catalog-types";
import type { browseReleaseGate } from "@/lib/browse/release-status";

export function cardActionLabel(
  action: CatalogCardAction,
  status: ActionStatus,
  releaseGate: ReturnType<typeof browseReleaseGate>,
): string {
  if (releaseGate.gated) return releaseGate.label ?? "Coming soon";
  if (action.kind !== "get") return action.label;
  if (status === "pending") return "Starting…";
  if (status === "error") return "Try again";
  if (status === "done") return "Downloading";
  return action.label;
}
