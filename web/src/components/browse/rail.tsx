import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { motion, useReducedMotion } from "framer-motion";
import type { Rail as RailModel, RailItem } from "@/lib/browse";
import type { ActionStatus, CatalogCardAction } from "@/lib/api/catalog-types";
import { cn } from "@/lib/utils";
import { nextFocusIndex, pageScrollDelta, railEdges } from "./rail-scroll";
import { TitleCard } from "./title-card";
import { RailArrow } from "./rail-arrow";
import { GRID, RAIL_HEADING } from "./rail-layout";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";

export { RailGridSkeleton, RailSkeleton } from "./rail-skeletons";

export interface RailProps {
  rail: RailModel;
  /** Position on the page — drives the entrance stagger and image priority. */
  index?: number;
  statuses?: Record<string, ActionStatus>;
  onAction: (item: RailItem, action: CatalogCardAction) => void;
  /** Where "See all" goes: the page that lists this rail in full. None when absent. */
  seeAllHref?: string;
}

/**
 * One horizontally scrolling row of titles.
 *
 * Scrolling is **per rail**, never a page-level `overflow-x` rule: per CSS
 * Overflow 3 a non-`visible` value on one axis forces the other to `auto`, so a
 * global rule turns an ancestor into a scroll container and silently breaks
 * every `position: sticky` in the app (see `globals.css` — this has already
 * cost this codebase a day). The scroller here is a leaf with a fixed content
 * height, so the same rule is harmless: its vertical padding exists precisely
 * because that axis now clips, and the hover lift and focus ring need room.
 *
 * Keyboard: cards are the tab stops, and Left/Right/Home/End move between them
 * inside the row — the standard behaviour for a carousel, and the only way to
 * reach card 14 without 13 Tab presses.
 */
export function Rail({ rail, index = 0, statuses, onAction, seeAllHref }: RailProps) {
  return (
    <RailStrip
      id={rail.id}
      title={rail.title}
      index={index}
      seeAllHref={seeAllHref}
      itemCount={rail.items.length}
    >
      {rail.items.map((item, i) => (
        <TitleCard
          key={item.id}
          item={item}
          status={statuses?.[item.id]}
          onAction={onAction}
          priority={index === 0 && i < 4}
        />
      ))}
    </RailStrip>
  );
}

/**
 * The scrolling strip under every rail: heading, See all, the scroller, edge
 * arrows and arrow-key movement between `[data-rail-card]` elements. Browse
 * rails fill it with `TitleCard`s; other shelves (recommendations) pass their
 * own `<li>` cards built on `MediaPoster`.
 */
export function RailStrip({
  id,
  title,
  index = 0,
  seeAllHref,
  itemCount,
  className,
  children,
}: {
  id: string;
  title: ReactNode;
  index?: number;
  seeAllHref?: string;
  itemCount: number;
  className?: string;
  children: ReactNode;
}) {
  // The scroll container is the ScrollArea viewport, not the list inside it.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const viewport = useCallback(
    () =>
      rootRef.current?.querySelector<HTMLElement>(
        '[data-slot="scroll-area-viewport"]',
      ) ?? null,
    [],
  );
  const [edges, setEdges] = useState({
    atStart: true,
    atEnd: true,
    scrollable: false,
  });
  const reduceMotion = useReducedMotion();

  const measure = useCallback(() => {
    const el = viewport();
    if (!el) return;
    setEdges(
      railEdges({
        scrollLeft: el.scrollLeft,
        clientWidth: el.clientWidth,
        scrollWidth: el.scrollWidth,
      }),
    );
  }, [viewport]);

  useEffect(() => {
    const el = viewport();
    const list = el?.querySelector("ul");
    if (!el || !list) return;
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    // Posters arrive after first paint and the viewport can change under us, so
    // a one-shot measurement would leave the arrows lying about the row.
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    observer.observe(list);
    return () => {
      el.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [measure, viewport, itemCount]);

  const scrollByPage = useCallback(
    (direction: 1 | -1) => {
      const el = viewport();
      if (!el) return;
      el.scrollBy({
        left: direction * pageScrollDelta(el.clientWidth),
        behavior: reduceMotion ? "auto" : "smooth",
      });
    },
    [reduceMotion, viewport],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLUListElement>) => {
      const el = event.currentTarget;
      const cards = Array.from(
        el.querySelectorAll<HTMLElement>("[data-rail-card]"),
      );
      if (cards.length === 0) return;
      const active = document.activeElement as HTMLElement | null;
      const current = cards.findIndex(
        (card) => card === active || card.contains(active),
      );
      if (current === -1) return;
      const next = nextFocusIndex(current, cards.length, event.key);
      if (next == null || next === current) {
        // Still swallow the arrow at the ends: letting it scroll the page while
        // focus stays put reads as the row being broken.
        if (next != null) event.preventDefault();
        return;
      }
      event.preventDefault();
      cards[next].focus();
      cards[next].scrollIntoView({
        block: "nearest",
        inline: "nearest",
        behavior: reduceMotion ? "auto" : "smooth",
      });
    },
    [reduceMotion],
  );

  if (itemCount === 0) return null;
  const label = typeof title === "string" ? title : "titles";

  return (
    <motion.section
      aria-labelledby={`rail-${id}`}
      data-rail={id}
      className={cn("group/rail relative py-4 sm:py-5", className)}
      initial={false}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: reduceMotion ? 0 : 0.18,
        delay: reduceMotion ? 0 : Math.min(index, 4) * 0.04,
        ease: "easeOut",
      }}
    >
      <div className="mb-2.5 flex items-center justify-between gap-3">
        <h2 id={`rail-${id}`} className={RAIL_HEADING}>
          {title}
        </h2>
        {seeAllHref ? (
          <Link
            to={seeAllHref}
            aria-label={`See all ${label.toLowerCase()}`}
            data-rail-see-all
            // 44 px tall on touch without pushing the row apart: the negative
            // margin gives back what the target adds.
            className="-my-3 inline-flex min-h-11 shrink-0 items-center rounded-sm px-1 text-[12px] text-brand-foreground underline-offset-4 outline-none transition-colors hover:text-brand hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 lg:my-0 lg:min-h-0"
          >
            See all
          </Link>
        ) : null}
      </div>

      <div className="relative">
        {/* `-my-3` cancels the padding that gives the hover lift and focus
            ring room inside a viewport that clips both axes. The horizontal
            bar sits in that bottom padding and only shows on hover. */}
        <ScrollArea
          ref={rootRef}
          data-rail-scroller
          className={cn(
            "-my-3",
            "[&>[data-slot=scroll-area-viewport]]:snap-x [&>[data-slot=scroll-area-viewport]]:scroll-pl-1",
            "[&>[data-slot=scroll-area-viewport]]:overscroll-x-contain",
          )}
        >
        <ul
          onKeyDown={onKeyDown}
          className="flex gap-2.5 py-3 sm:gap-3"
        >
          {children}
        </ul>
        <ScrollBar orientation="horizontal" />
        </ScrollArea>

        {edges.scrollable ? (
          <>
            <RailArrow
              direction="left"
              hidden={edges.atStart}
              onClick={() => scrollByPage(-1)}
            />
            <RailArrow
              direction="right"
              hidden={edges.atEnd}
              onClick={() => scrollByPage(1)}
            />
          </>
        ) : null}
      </div>
    </motion.section>
  );
}

/**
 * One rail's titles as a wrapping grid: a genre page, where the point is to
 * see the whole list rather than a row of it. Cards are the tab stops in
 * reading order, so no arrow-key handling is needed.
 */
export function RailGrid({
  rail,
  statuses,
  onAction,
}: Omit<RailProps, "index" | "seeAllHref">) {
  if (rail.items.length === 0) return null;
  return (
    <section
      aria-labelledby={`rail-${rail.id}`}
      data-rail={rail.id}
      data-rail-grid
      className="py-4 sm:py-5"
    >
      <h2 id={`rail-${rail.id}`} className={cn(RAIL_HEADING, "mb-3")}>
        {rail.title}
      </h2>
      <ul className={GRID}>
        {rail.items.map((item, i) => (
          <TitleCard
            key={item.id}
            item={item}
            layout="grid"
            status={statuses?.[item.id]}
            onAction={onAction}
            priority={i < 6}
          />
        ))}
      </ul>
    </section>
  );
}
