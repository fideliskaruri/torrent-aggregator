import { Link } from "react-router";
import { Search } from "lucide-react";
import type { ActionStatus, CatalogCardAction } from "@/lib/api/catalog-types";
import type { RailItem } from "@/lib/browse";
import { cn } from "@/lib/utils";
import { AvailabilityChip } from "./availability-chip";
import { MediaPoster, MediaPosterCaption } from "./media-poster-card";
import { ReleaseGateChip } from "./release-gate-chip";
import type { browseReleaseGate } from "@/lib/browse/release-status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadingGlyph } from "@/components/ui/loading";

export function TitleCardArtwork({
  item,
  status,
  onAction,
  title,
  linkName,
  describedBy,
  titleHref,
  layout,
  priority,
  releaseGate,
  unreleased,
  label,
  accessibleName,
  canSeeTransfers,
}: {
  item: RailItem;
  status: ActionStatus;
  onAction: (item: RailItem, action: CatalogCardAction) => void;
  title: string;
  linkName: string;
  describedBy?: string;
  titleHref: string | null;
  layout: "rail" | "grid";
  priority: boolean;
  releaseGate: ReturnType<typeof browseReleaseGate>;
  unreleased: boolean;
  label: string;
  accessibleName: string;
  canSeeTransfers: boolean;
}) {
  const action = item.action;
  const blocked = action.disabled;
  const arriving = action.kind === "downloading";
  const fallbackSearch =
    !unreleased && action.kind === "blocked" ? item.searchHref : null;
  const quietBadge = (blocked && !arriving) || unreleased;
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
  const controlClass = cn(
    "block w-full rounded-lg text-left outline-none",
    "focus-visible:ring-2 focus-visible:ring-brand",
    "focus-visible:ring-offset-2 focus-visible:ring-offset-background",
  );
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
        dimmed={blocked && !arriving}
        className={cn(
          "transition-[transform,border-color,box-shadow] duration-150 ease-out",
          "group-hover:border-input group-hover:shadow-md",
          "motion-safe:group-hover:-translate-y-1 motion-safe:group-focus-within:-translate-y-1",
        )}
        chip={
          unreleased ? (
            <ReleaseGateChip gate={releaseGate} data-card-coming />
          ) : action.kind === "get" || arriving || !canSeeTransfers ? null : (
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
        aria-label={accessibleName}
        disabled={status === "pending"}
        onClick={(event) => {
          event.stopPropagation();
          event.preventDefault();
          if (status === "pending") return;
          onAction(item, action);
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
        <Link to={action.href} aria-label={accessibleName}>
          <Badge variant={quietBadge ? "default" : "solid"} className={badgeClass}>
            {badgeInner}
          </Badge>
        </Link>
      </Button>
    </span>
  ) : action.kind === "blocked" || arriving || action.kind === "local" ? (
    <span className={actionRowClass} aria-hidden>
      <Badge variant={quietBadge ? "default" : "solid"} className={badgeClass}>
        {badgeInner}
      </Badge>
    </span>
  ) : null;

  return (
    <div className="group relative">
      {titleHref ? (
        <Link
          to={titleHref}
          data-rail-card
          data-card-target="title"
          aria-label={linkName}
          aria-describedby={describedBy}
          className={cn(controlClass, "block min-h-[44px]")}
        >
          {cardVisual}
        </Link>
      ) : (
        <Button
          type="button"
          variant="ghost"
          data-rail-card
          aria-disabled={blocked || unreleased || undefined}
          aria-describedby={describedBy}
          aria-label={accessibleName}
          onClick={() => {
            if (unreleased || blocked || status === "pending") return;
            onAction(item, action);
          }}
          className={cn(
            "h-auto whitespace-normal border-0 p-0 font-normal hover:bg-transparent dark:hover:bg-transparent",
            controlClass,
            "min-h-[44px]",
            (blocked || unreleased) && "cursor-default",
          )}
        >
          {cardVisual}
        </Button>
      )}
      {actionRow ? (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-[3]">
          <div className="relative aspect-[2/3] w-full">{actionRow}</div>
        </div>
      ) : null}
      {fallbackSearch ? (
        <Button
          asChild
          variant="outline"
          size="icon-sm"
          className="absolute right-1.5 top-1.5 z-[4] size-11 bg-card text-muted-foreground hover:text-foreground lg:size-7 dark:bg-card"
        >
          <Link
            to={fallbackSearch}
            title={`Search releases for ${title}`}
            aria-label={`Search releases for ${title}`}
          >
            <Search className="size-3.5" aria-hidden />
          </Link>
        </Button>
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
  );
}
