import { useId } from "react";
import { Link } from "react-router";
import type { ActionStatus, CatalogCardAction } from "@/lib/api/catalog-types";
import type { RailItem } from "@/lib/browse";
import { browseReleaseGate } from "@/lib/browse/release-status";
import { useCapabilities } from "@/lib/capabilities";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadingGlyph } from "@/components/ui/loading";
import { AvailabilityChip } from "./availability-chip";
import { MediaPoster, MediaPosterCaption, MediaPosterSkeleton, RAIL_CARD_WIDTH } from "./media-poster-card";
import { ReleaseGateChip } from "./release-gate-chip";
import { cardActionLabel } from "./card-action-label";

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
  const title = item.title;
  const label = cardActionLabel(action, status, releaseGate);
  const reactId = useId();
  const describedBy = unreleased || blocked ? `${reactId}-reason` : undefined;
  const accessibleName = [
    title,
    item.subtitle,
    unreleased ? releaseGate.label : blocked ? action.reason : null,
  ]
    .filter(Boolean)
    .join(", ");
  const actionName = [label, accessibleName].filter(Boolean).join(", ");
  const quietBadge = (blocked && action.kind !== "downloading") || unreleased;
  const badgeClass = cn(
    "min-w-0 justify-start py-1 leading-none",
    quietBadge && "bg-card text-subtle-foreground",
  );
  const badgeInner = (
    <>
      {status === "pending" ? <LoadingGlyph className="h-3 w-3" /> : null}
      <span className="truncate">{label}</span>
    </>
  );
  const actionRowClass = cn(
    "absolute inset-x-0 bottom-0 z-[3] flex items-center gap-1 px-1.5 pb-1.5 pt-6",
    "opacity-100 transition-opacity duration-150",
    "[@media(hover:hover)_and_(pointer:fine)]:md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100",
    "pointer-events-none",
  );
  const runnable = !unreleased && !blocked && action.kind === "get";
  const cardVisual = (
    <>
      <MediaPoster
        variant="rail"
        src={item.posterUrl}
        title={title}
        sizes={
          layout === "grid"
            ? "(min-width: 1024px) 200px, (min-width: 640px) 180px, 120px"
            : "(min-width: 1024px) 168px, (min-width: 640px) 148px, 124px"
        }
        priority={priority}
        gated={unreleased}
        dimmed={blocked && action.kind !== "downloading"}
        className={cn(
          "transition-[transform,border-color,box-shadow] duration-150 ease-out",
          "group-hover:border-input group-hover:shadow-md",
          "motion-safe:group-hover:-translate-y-1 motion-safe:group-focus-within:-translate-y-1",
        )}
        chip={
          unreleased ? (
            <ReleaseGateChip gate={releaseGate} data-card-coming />
          ) : action.kind === "get" || action.kind === "downloading" || !canSeeTransfers ? null : (
            <AvailabilityChip state={item.availability} compact />
          )
        }
      />
      <MediaPosterCaption title={title} fullTitle={item.title} subtitle={item.subtitle} />
    </>
  );
  const actionRow = unreleased ? null : runnable ? (
    <span className={actionRowClass}>
      <Button
        type="button"
        variant="ghost"
        data-card-action={action.kind}
        aria-label={actionName}
        disabled={status === "pending"}
        onClick={(event) => {
          event.stopPropagation();
          event.preventDefault();
          if (status !== "pending") onAction(item, action);
        }}
        className="pointer-events-auto h-auto min-h-11 min-w-0 max-w-full cursor-pointer items-end justify-start rounded-md p-0 hover:bg-transparent disabled:cursor-default disabled:opacity-100 dark:hover:bg-transparent lg:min-h-0"
      >
        <Badge variant={quietBadge ? "default" : "solid"} className={badgeClass}>
          {badgeInner}
        </Badge>
      </Button>
    </span>
  ) : action.kind === "search" || action.kind === "request" ? (
    <span className={actionRowClass}>
      <Button
        asChild
        variant="ghost"
        data-card-action={action.kind}
        className="pointer-events-auto h-auto min-h-11 min-w-0 max-w-full items-end justify-start rounded-md p-0 hover:bg-transparent dark:hover:bg-transparent lg:min-h-0"
      >
        <Link to={action.href} aria-label={actionName}>
          <Badge variant={quietBadge ? "default" : "solid"} className={badgeClass}>
            {badgeInner}
          </Badge>
        </Link>
      </Button>
    </span>
  ) : action.kind === "blocked" || action.kind === "downloading" || action.kind === "local" ? (
    <span className={actionRowClass} aria-hidden>
      <Badge variant={quietBadge ? "default" : "solid"} className={badgeClass}>
        {badgeInner}
      </Badge>
    </span>
  ) : null;

  return (
    <li
      className={cn(
        "relative",
        layout === "grid" ? "min-w-0" : cn("shrink-0 snap-start", CARD_WIDTH),
      )}
      data-unreleased={unreleased ? "true" : undefined}
    >
      <div className="group relative">
        <Link
          to={item.href}
          data-rail-card
          data-card-target="title"
          aria-label={accessibleName}
          aria-describedby={describedBy}
          className="block min-h-[44px] w-full rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          {cardVisual}
        </Link>
        {actionRow ? (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-[3]">
            <div className="relative aspect-[2/3] w-full">{actionRow}</div>
          </div>
        ) : null}
        {unreleased ? (
          <p id={describedBy} className="sr-only">
            {releaseGate.label ?? "Coming soon"}
          </p>
        ) : blocked ? (
          <p id={describedBy} className="sr-only">
            {action.reason}
          </p>
        ) : null}
      </div>
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
