import { useId } from "react";
import type { ActionStatus, CatalogCardAction } from "@/lib/api/catalog-types";
import type { RailItem } from "@/lib/browse";
import { browseReleaseGate } from "@/lib/browse/release-status";
import { cleanDisplayTitle } from "@/lib/title/display-title";
import { useCapabilities } from "@/lib/capabilities";
import { cn } from "@/lib/utils";
import {
  MediaPosterSkeleton,
  RAIL_CARD_WIDTH,
} from "./media-poster-card";
import { TitleCardArtwork } from "./title-card-artwork";

const CARD_WIDTH = RAIL_CARD_WIDTH;

export interface TitleCardProps {
  item: RailItem;
  status?: ActionStatus;
  onAction: (item: RailItem, action: CatalogCardAction) => void;
  priority?: boolean;
  layout?: "rail" | "grid";
}

export function TitleCard({
  item,
  status = "idle",
  onAction,
  priority = false,
  layout = "rail",
}: TitleCardProps) {
  const releaseGate = browseReleaseGate(item);
  const unreleased = releaseGate.gated;
  const action = item.action;
  const blocked = action.disabled;
  const { canSeeTransfers } = useCapabilities();
  const title = cleanDisplayTitle(item.title);
  const label = unreleased
    ? (releaseGate.label ?? "Coming soon")
    : action.kind === "get" && status === "pending"
      ? "Starting…"
      : action.kind === "get" && status === "error"
        ? "Try again"
        : action.kind === "get" && status === "done"
          ? "Downloading"
          : action.label;
  const reactId = useId();
  const describedBy = unreleased || blocked ? `${reactId}-reason` : undefined;
  const accessibleName = [
    label,
    title,
    item.subtitle,
    unreleased ? releaseGate.label : blocked ? action.reason : null,
  ]
    .filter(Boolean)
    .join(", ");
  const linkName = [
    title,
    item.subtitle,
    unreleased ? releaseGate.label : blocked ? action.reason : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <li
      className={cn(
        "relative",
        layout === "grid" ? "min-w-0" : cn("shrink-0 snap-start", CARD_WIDTH),
      )}
      data-unreleased={unreleased ? "true" : undefined}
    >
      <TitleCardArtwork
        item={item}
        status={status}
        onAction={onAction}
        title={title}
        linkName={linkName}
        describedBy={describedBy}
        titleHref={item.href}
        layout={layout}
        priority={priority}
        releaseGate={releaseGate}
        unreleased={unreleased}
        label={label}
        accessibleName={accessibleName}
        canSeeTransfers={canSeeTransfers}
      />
    </li>
  );
}

export function TitleCardSkeleton({ layout = "rail" }: { layout?: "rail" | "grid" }) {
  return (
    <li
      className={cn(layout === "grid" ? "min-w-0" : cn("shrink-0", CARD_WIDTH))}
      aria-hidden
    >
      <MediaPosterSkeleton variant="rail" />
    </li>
  );
}
