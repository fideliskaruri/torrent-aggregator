"use client";

import { useId } from "react";
import Link from "next/link";
import { Play, Search } from "lucide-react";
import type { RailItem } from "@/lib/browse";
import { cn } from "@/lib/utils";
import {
  actionLabel,
  cleanDisplayTitle,
  clampFraction,
  resolveCardAction,
  searchAction,
  type ActionStatus,
  type CardAction,
} from "./availability";
import { AvailabilityChip } from "./availability-chip";
import { PosterImage } from "./poster-image";
import { titleHrefForItem } from "@/components/title/work-key";
import { LoadingGlyph, SkeletonBlock } from "@/components/ui/loading";

/** Poster box width per breakpoint. Also drives `sizes` for `next/image`. */
const CARD_WIDTH = "w-[124px] sm:w-[148px] lg:w-[168px]";
const CARD_SIZES = "(min-width: 1024px) 168px, (min-width: 640px) 148px, 124px";

export interface TitleCardProps {
  item: RailItem;
  status?: ActionStatus;
  /** Runs the card's primary action. The board owns what that means. */
  onAction: (item: RailItem, action: CardAction) => void;
  /** Eager-load the first screenful; everything else is lazy. */
  priority?: boolean;
}

/**
 * One title in a rail.
 *
 * **The whole card opens the title page.** That is the user's rule, stated
 * plainly: *"i should be able to just click any card to see the information
 * about the show or just resume watching."* So the card is a real `<Link>` —
 * poster, title text and subtitle all — which is what makes middle-click,
 * ctrl-click and "open in new tab" work. An `onClick` with `router.push` looks
 * identical and silently breaks all three.
 *
 * The action itself (Watch / Resume / Download) is a *sibling* control layered
 * over the poster, never nested inside the link: interactive content inside an
 * `<a>` is invalid HTML and behaves differently in every browser. Being a
 * sibling also means a click on it never reaches the link, so pressing Resume
 * resumes and clicking anywhere else opens the page. The action comes from
 * {@link resolveCardAction}, so a card can never offer Watch for something
 * that cannot play.
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
}: TitleCardProps) {
  const action = resolveCardAction(item);
  const fallbackSearch = action.kind === "blocked" ? searchAction(item) : null;
  const title = cleanDisplayTitle(item.title);
  const fraction = clampFraction(item.progressFraction);
  const label = actionLabel(action, status);
  const blocked = action.disabled;

  // Every card goes to the same place: the page about this work. Null only
  // when the row has no usable title — then the card falls back to being the
  // action itself, because a title page with nothing to name is worse.
  const titleHref = titleHrefForItem(item);

  // Only `play` and `get` are *performed*. `search` and `blocked` describe
  // where the card already goes, so they render as a caption rather than a
  // second control competing with the link underneath them.
  const runnable =
    !blocked && (action.kind === "play" || action.kind === "get");

  // A row id is not unique on the page — the same episode legitimately appears
  // in Continue Watching and Ready to Play — and two elements sharing an id
  // break `aria-describedby` for whichever one loses.
  const reactId = useId();
  const describedBy = blocked ? `${reactId}-reason` : undefined;
  const accessibleName = [
    label,
    title,
    item.subtitle,
    blocked ? action.reason : null,
  ]
    .filter(Boolean)
    .join(" — ");
  const linkName = [title, item.subtitle, blocked ? action.reason : null]
    .filter(Boolean)
    .join(" — ");

  const surface = (
    <div
      className={cn(
        "relative aspect-[2/3] w-full overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-muted)]",
        "transition-[transform,border-color,box-shadow] duration-150 ease-out",
        "group-hover:border-[var(--border-strong)] group-hover:shadow-[var(--shadow-md)]",
        "motion-safe:group-hover:-translate-y-1 motion-safe:group-focus-within:-translate-y-1",
        blocked && "opacity-75",
      )}
    >
      <PosterImage
        src={item.posterUrl}
        title={title}
        sizes={CARD_SIZES}
        priority={priority}
      />

      <span className="absolute left-1.5 top-1.5 z-[1]">
        <AvailabilityChip state={item.availability} compact />
      </span>

      {fraction != null ? (
        <span className="absolute inset-x-0 bottom-0 z-[2] h-[3px] bg-[var(--border-strong)]">
          <span
            className="block h-full bg-[var(--accent)]"
            style={{ width: `${Math.round(fraction * 100)}%` }}
          />
        </span>
      ) : null}
    </div>
  );

  // Solid panel rather than a scrim gradient: the text has to stay legible
  // over artwork we have never seen.
  const badgeClass = cn(
    "inline-flex min-w-0 max-w-full items-center gap-1 rounded-[6px] border px-1.5 py-1 text-[11px] font-medium leading-none",
    blocked
      ? "border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--text-tertiary)]"
      : "border-transparent bg-[var(--accent)] text-[var(--primary-foreground)]",
  );
  const badgeInner = (
    <>
      {status === "pending" ? (
        <LoadingGlyph className="h-3 w-3" />
      ) : action.kind === "play" ? (
        <Play className="h-3 w-3 shrink-0 fill-current" aria-hidden />
      ) : null}
      <span className="truncate">{label}</span>
    </>
  );

  const actionRowClass = cn(
    "absolute inset-x-0 bottom-0 z-[3] flex items-center gap-1 px-1.5 pb-1.5 pt-6",
    "opacity-100 transition-opacity duration-150",
    "md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100",
    // The row is a transparent strip across the poster. Without this it would
    // swallow every click that lands beside the badge — the card would look
    // clickable and do nothing, which is the exact defect being fixed.
    "pointer-events-none",
    fraction != null && "pb-2.5",
  );

  const actionRow = runnable ? (
    <span className={actionRowClass}>
      <button
        type="button"
        data-card-action={action.kind}
        aria-label={accessibleName}
        disabled={status === "pending"}
        onClick={(event) => {
          // Belt and braces. The button is a DOM sibling of the card link, so
          // the click cannot bubble into it — but the rails, the board and any
          // future wrapper are free to listen higher up, and pressing Resume
          // must never also navigate.
          event.stopPropagation();
          event.preventDefault();
          if (status === "pending") return;
          onAction(item, action);
        }}
        className={cn(
          badgeClass,
          "pointer-events-auto cursor-pointer disabled:cursor-default",
        )}
      >
        {badgeInner}
      </button>
    </span>
  ) : action.kind === "blocked" ? (
    <span className={actionRowClass} aria-hidden>
      <span className={badgeClass}>{badgeInner}</span>
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
    "block w-full rounded-[var(--radius)] text-left outline-none",
    "focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
    "focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]",
  );

  const caption = (
    <div className="mt-2 min-w-0">
      <p
        title={item.title}
        className="line-clamp-2 text-[12px] font-medium leading-snug text-[var(--text)]"
      >
        {title}
      </p>
      {item.subtitle ? (
        <p className="mt-0.5 truncate text-[11px] text-[var(--text-tertiary)]">
          {item.subtitle}
        </p>
      ) : null}
    </div>
  );

  return (
    <li className={cn("relative shrink-0 snap-start", CARD_WIDTH)}>
      <div className="group relative">
        {titleHref ? (
          <Link
            href={titleHref}
            data-rail-card
            data-card-target="title"
            aria-label={linkName}
            aria-describedby={describedBy}
            className={controlClass}
          >
            {surface}
          </Link>
        ) : (
          <button
            type="button"
            data-rail-card
            // `aria-disabled` rather than `disabled`: a blocked card must stay
            // in the tab order and inside the rail's arrow-key run, or the row
            // develops holes a keyboard user has to jump over.
            aria-disabled={blocked || undefined}
            aria-describedby={describedBy}
            aria-label={accessibleName}
            onClick={() => {
              if (blocked || status === "pending") return;
              onAction(item, action);
            }}
            className={cn(controlClass, blocked && "cursor-default")}
          >
            {surface}
          </button>
        )}

        {actionRow}

        {fallbackSearch ? (
          <Link
            href={fallbackSearch.href}
            title={`Search releases for ${title}`}
            aria-label={`Search releases for ${title}`}
            className={cn(
              "absolute right-1.5 top-1.5 z-[4] inline-flex h-7 w-7 items-center justify-center rounded-md",
              "border border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--text-secondary)]",
              "transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text)]",
            )}
          >
            <Search className="h-3.5 w-3.5" aria-hidden />
          </Link>
        ) : null}
      </div>

      {/* The caption is part of the click target, not decoration under it.
          `tabIndex={-1}` because it is the *same* destination as the poster
          link: two tab stops with one accessible name is noise for a keyboard
          user, and the rail's arrow-key run counts `[data-rail-card]` only. */}
      {titleHref ? (
        <Link
          href={titleHref}
          tabIndex={-1}
          className="block rounded-[6px] outline-none"
        >
          {caption}
        </Link>
      ) : (
        caption
      )}

      {/* Outside the caption link on purpose: `aria-describedby` has to point
          at something a screen reader will reach on its own. */}
      {blocked ? (
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
 * Same width and 2:3 box as the real card, so streaming the rails in cannot
 * shift the page — the skeleton is not decoration, it is the layout being
 * reserved.
 */
export function TitleCardSkeleton() {
  return (
    <li className={cn("shrink-0", CARD_WIDTH)} aria-hidden>
      <SkeletonBlock className="aspect-[2/3] w-full rounded-[var(--radius)]" />
      <SkeletonBlock className="mt-2 h-3 w-4/5 rounded" />
      <SkeletonBlock className="mt-1.5 h-2.5 w-2/5 rounded" />
    </li>
  );
}
