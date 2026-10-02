import { useId } from "react";
import { Link } from "react-router";
import { Search } from "lucide-react";
import type { RailItem } from "@/lib/browse";
import { browseReleaseGate } from "@/lib/browse/release-status";
import { cn } from "@/lib/utils";
import {
  actionLabel,
  cleanDisplayTitle,
  viewerCardAction,
  searchAction,
  type ActionStatus,
  type CardAction,
} from "./availability";
import { AvailabilityChip } from "./availability-chip";
import { MediaPoster, MediaPosterCaption, MediaPosterSkeleton, RAIL_CARD_WIDTH } from "./media-poster-card";
import { ReleaseGateChip } from "./release-gate-chip";
import { titleHrefForItem } from "@/components/title/work-key";
import { useCapabilities } from "@/lib/capabilities";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadingGlyph } from "@/components/ui/loading";

/** Poster box width per breakpoint. Also drives the poster `<img>` `sizes`. */
const CARD_WIDTH = RAIL_CARD_WIDTH;
const CARD_SIZES = "(min-width: 1024px) 168px, (min-width: 640px) 148px, 124px";
/** A grid cell stretches to its column, which runs a little wider than a rail card. */
const GRID_SIZES = "(min-width: 1024px) 200px, (min-width: 640px) 180px, 120px";

export interface TitleCardProps {
  item: RailItem;
  status?: ActionStatus;
  /** Runs the card's primary action. The board owns what that means. */
  onAction: (item: RailItem, action: CardAction) => void;
  /** Eager-load the first screenful; everything else is lazy. */
  priority?: boolean;
  /** `rail` is a fixed-width card in a scrolling row; `grid` fills its grid column. */
  layout?: "rail" | "grid";
}

/**
 * One title in a rail.
 *
 * **The whole card opens the title page.** That is the user's rule, stated
 * plainly: *"i should be able to just click any card to see the information
 * about the show."* So the card is a real `<Link>` — poster, title text and
 * subtitle all — which is what makes middle-click, ctrl-click and "open in new
 * tab" work. An `onClick` with `router.push` looks identical and silently
 * breaks all three.
 *
 * The action itself (Get S02E01) is a *sibling* control layered over the
 * poster, never nested inside the link: interactive content inside an `<a>` is
 * invalid HTML and behaves differently in every browser. Being a sibling also
 * means a click on it never reaches the link, so pressing Get gets and
 * clicking anywhere else opens the page. The action comes from
 * {@link resolveCardAction}, so a card can never offer an action that cannot
 * succeed.
 *
 * The action row is visible by default and hover-revealed only from `md` up:
 * touch devices have no hover, and a control that only appears on a state they
 * cannot enter does not exist.
 */
export function TitleCard({
  item,
  status = "idle",
  onAction,
  priority = false,
  layout = "rail",
}: TitleCardProps) {
  // Future primary dates and confirmed cinema-only movies share one Browse
  // gate. Unknown evidence and series always stay open.
  const releaseGate = browseReleaseGate(item);
  const unreleased = releaseGate.gated;

  const { canDownload, canSeeTransfers } = useCapabilities();
  const titleHref = titleHrefForItem(item);
  const action = viewerCardAction(item, canDownload, titleHref);
  // Search fallback is for unavailable library rows, not unreleased catalog
  // cards — a "find it" affordance on something that does not exist yet is a
  // dead end.
  const fallbackSearch =
    !unreleased && action.kind === "blocked" ? searchAction(item) : null;
  const title = cleanDisplayTitle(item.title);
  // Theatrical-window films show "In cinemas" (or "Digital Aug 2026");
  // future-dated films show "Coming {date}". Both take priority over actions.
  const label = unreleased
    ? (releaseGate.label ?? "Coming soon")
    : actionLabel(action, status);
  const blocked = action.disabled;
  // Downloading is disabled but not a dead end: the card stays at full
  // strength and its badge keeps the accent.
  const arriving = action.kind === "downloading";

  // Every card goes to the same place: the page about this work. Null only
  // when the row has no usable title — then the card falls back to being the
  // action itself, because a title page with nothing to name is worse.
  // Unreleased cards keep the link: the title page is the library surface
  // (overview, track) — only Get/Download are withheld.

  // Only `get` is *performed*. `local`, `search` and `blocked` describe where
  // the card already goes, so they render as a caption rather than a second
  // control competing with the link underneath them. Unreleased never runs
  // either.
  const runnable = !unreleased && !blocked && action.kind === "get";

  // A row id is not unique across every surface on the page, and two elements
  // sharing an id break `aria-describedby` for whichever one loses.
  const reactId = useId();
  const describedBy =
    unreleased || blocked ? `${reactId}-reason` : undefined;
  const gatedLabel = releaseGate.label;
  const accessibleName = [
    label,
    title,
    item.subtitle,
    unreleased ? gatedLabel : blocked ? action.reason : null,
  ]
    .filter(Boolean)
    .join(", ");
  const linkName = [
    title,
    item.subtitle,
    unreleased ? gatedLabel : blocked ? action.reason : null,
  ]
    .filter(Boolean)
    .join(", ");

  const surface = (
    <MediaPoster
      variant="rail"
      src={item.posterUrl}
      title={title}
      sizes={layout === "grid" ? GRID_SIZES : CARD_SIZES}
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
          // Requesters read their request state on the card instead; the owner's
          // file and indexer badges ("Ready", "Not checked") aren't theirs.
          // A card offering "Get S02E01" or "Downloading" already says the
          // episode is not here yet; a second badge saying so would only repeat it.
          <AvailabilityChip state={item.availability} compact />
        )
      }
    />
  );
  // Solid panel rather than a scrim gradient: the text has to stay legible
  // over artwork we have never seen.
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
    // Hide-at-rest is gated to a real hover pointer. On touch (coarse / no-hover)
    // the query never matches, so the chip stays visible at every width and a
    // tablet user never faces an invisible control; mouse/trackpad keeps the
    // reveal-on-hover feel. Screen width is not a proxy for input capability.
    "[@media(hover:hover)_and_(pointer:fine)]:md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100",
    // The row is a transparent strip across the poster. Without this it would
    // swallow every click that lands beside the badge — the card would look
    // clickable and do nothing, which is the exact defect being fixed.
    "pointer-events-none",
  );

  // Unreleased: Coming lives on the top chip only. A second badge on the action
  // row would compete with it, and there is no control to reveal on hover.
  const actionRow = unreleased ? null : runnable ? (
    <span className={actionRowClass}>
      <Button
        type="button"
        variant="ghost"
        data-card-action={action.kind}
        aria-label={accessibleName}
        disabled={status === "pending"}
        onClick={(event) => {
          // Belt and braces. The button is a DOM sibling of the card link, so
          // the click cannot bubble into it — but the rails, the board and any
          // future wrapper are free to listen higher up, and pressing Get
          // must never also navigate.
          event.stopPropagation();
          event.preventDefault();
          if (status === "pending") return;
          onAction(item, action);
        }}
        // A transparent hit area around the chip: 44px tall on touch, the chip
        // itself on a desktop pointer.
        className="pointer-events-auto h-auto min-h-11 min-w-0 max-w-full cursor-pointer items-end justify-start rounded-md p-0 hover:bg-transparent disabled:cursor-default disabled:opacity-100 dark:hover:bg-transparent lg:min-h-0"
      >
        <Badge variant={quietBadge ? "default" : "solid"} className={badgeClass}>
          {badgeInner}
        </Badge>
      </Button>
    </span>
  ) : action.kind === "blocked" || arriving ? (
    <span className={actionRowClass} aria-hidden>
      <Badge variant={quietBadge ? "default" : "solid"} className={badgeClass}>
        {badgeInner}
      </Badge>
    </span>
  ) : (
    // `search` needs no caption: the whole card is already a link to the title
    // page, so a "Find it" badge would just repeat what the card does. The
    // availability chip carries the visual state on its own.
    null
  );

  // The ring is offset against the page background so it reads as a ring and
  // not as a border on the poster; the rail's vertical padding exists to keep
  // it from being clipped by the scroll container.
  const controlClass = cn(
    "block w-full rounded-lg text-left outline-none",
    "focus-visible:ring-2 focus-visible:ring-brand",
    "focus-visible:ring-offset-2 focus-visible:ring-offset-background",
  );

  const caption = (
    <MediaPosterCaption title={title} fullTitle={item.title} subtitle={item.subtitle} />
  );

  return (
    <li
      className={cn(
        "relative",
        layout === "grid" ? "min-w-0" : cn("shrink-0 snap-start", CARD_WIDTH),
      )}
      data-unreleased={unreleased ? "true" : undefined}
    >
      {/* Whole card (poster + caption) is one ≥44px target. The action chip is a
          sibling overlay so we never nest a button inside the link. */}
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
            {surface}
            {caption}
          </Link>
        ) : (
          <Button
            type="button"
            variant="ghost"
            data-rail-card
            // `aria-disabled` rather than `disabled`: a blocked card must stay
            // in the tab order and inside the rail's arrow-key run, or the row
            // develops holes a keyboard user has to jump over.
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
            {surface}
            {caption}
          </Button>
        )}

        {/* Poster-height overlay so the action chip stays on the art, not the caption. */}
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
              to={fallbackSearch.href}
              title={`Search releases for ${title}`}
              aria-label={`Search releases for ${title}`}
            >
              <Search className="size-3.5" aria-hidden />
            </Link>
          </Button>
        ) : null}
      </div>

      {/* Outside the card link on purpose: `aria-describedby` has to point
          at something a screen reader will reach on its own. */}
      {unreleased ? (
        <p id={describedBy} className="sr-only">
          {gatedLabel ?? "Coming soon"}
        </p>
      ) : blocked ? (
        <p id={describedBy} className="sr-only">
          {action.reason}
        </p>
      ) : null}
    </li>
  );
}

/**
 * Placeholder with the card's exact geometry.
 *
 * Same width and 2:3 box as the real card, so loading the rails in cannot
 * shift the page — the skeleton is not decoration, it is the layout being
 * reserved.
 */
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
