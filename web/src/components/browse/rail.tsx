import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import type { Rail as RailModel, RailItem } from "@/lib/browse";
import { cn } from "@/lib/utils";
import type { ActionStatus, CardAction } from "./availability";
import { nextFocusIndex, pageScrollDelta, railEdges } from "./rail-scroll";
import { TitleCard, TitleCardSkeleton } from "./title-card";
import { Button } from "@/components/ui/button";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";

export interface RailProps {
  rail: RailModel;
  /** Position on the page — drives the entrance stagger and image priority. */
  index?: number;
  statuses?: Record<string, ActionStatus>;
  onAction: (item: RailItem, action: CardAction) => void;
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
export function Rail({ rail, index = 0, statuses, onAction }: RailProps) {
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
  }, [measure, viewport, rail.items.length]);

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

  if (rail.items.length === 0) return null;

  return (
    <motion.section
      aria-labelledby={`rail-${rail.id}`}
      data-rail={rail.id}
      className="group/rail relative py-4 sm:py-5"
      initial={false}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: reduceMotion ? 0 : 0.18,
        delay: reduceMotion ? 0 : Math.min(index, 4) * 0.04,
        ease: "easeOut",
      }}
    >
      <h2
        id={`rail-${rail.id}`}
        className="mb-2.5 text-[13px] font-medium text-muted-foreground"
      >
        {rail.title}
      </h2>

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
          {rail.items.map((item, i) => (
            <TitleCard
              key={item.id}
              item={item}
              status={statuses?.[item.id]}
              onAction={onAction}
              priority={index === 0 && i < 4}
              persistentAction={rail.id === "continue-watching"}
            />
          ))}
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
 * Desktop-only edge control — Netflix-style fade + chevron, not a tall pill.
 *
 * The old bordered box sat beside the item-count and read as broken chrome
 * ("24" stacked over a chevron). Touch devices swipe the row; arrows stay out
 * of the tab order because cards already handle Left/Right.
 */
function RailArrow({
  direction,
  hidden,
  onClick,
}: {
  direction: "left" | "right";
  hidden: boolean;
  onClick: () => void;
}) {
  const Icon = direction === "left" ? ChevronLeft : ChevronRight;
  return (
    <div
      aria-hidden
      data-rail-arrow={direction}
      className={cn(
        "pointer-events-none absolute inset-y-0 z-[1] hidden w-12 items-center md:flex",
        "transition-opacity duration-150",
        direction === "left"
          ? "left-0 justify-start bg-gradient-to-r from-background via-background/80 to-transparent pl-1"
          : "right-0 justify-end bg-gradient-to-l from-background via-background/80 to-transparent pr-1",
        hidden
          ? "opacity-0"
          : "opacity-0 group-hover/rail:opacity-100 group-focus-within/rail:opacity-100",
      )}
    >
      <Button
        type="button"
        variant="outline"
        size="icon"
        tabIndex={-1}
        onClick={onClick}
        className={cn(
          "rounded-full bg-card/90 text-muted-foreground shadow-sm backdrop-blur-sm hover:text-foreground dark:bg-card/90",
          !hidden && "pointer-events-auto",
        )}
      >
        <Icon aria-hidden />
      </Button>
    </div>
  );
}

/** A rail-shaped placeholder, used while the payload streams in. */
export function RailSkeleton({ cards = 6 }: { cards?: number }) {
  return (
    <section className="py-4 sm:py-5" aria-hidden>
      <Skeleton className="mb-2.5 h-3.5 w-40 rounded" />
      <ul className="flex gap-2.5 overflow-hidden sm:gap-3">
        {Array.from({ length: cards }, (_, i) => (
          <TitleCardSkeleton key={i} />
        ))}
      </ul>
    </section>
  );
}
