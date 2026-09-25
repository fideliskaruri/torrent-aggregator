/**
 * Rail scrolling and keyboard-navigation maths.
 *
 * Kept out of the component so the arrow-visibility and roving-focus rules can
 * be tested without a browser: both are the kind of off-by-one logic that is
 * invisible in review and obvious in use (an arrow that stays lit at the end of
 * a row, focus that dead-ends on the last card).
 */

export interface ScrollMetrics {
  scrollLeft: number;
  clientWidth: number;
  scrollWidth: number;
}

export interface RailEdges {
  atStart: boolean;
  atEnd: boolean;
  /** False when the content fits: neither arrow should appear at all. */
  scrollable: boolean;
}

/**
 * Sub-pixel slack. Fractional layout widths and momentum scrolling routinely
 * leave `scrollLeft + clientWidth` a fraction short of `scrollWidth`, which
 * would keep the right arrow lit forever at the true end of the row.
 */
const EDGE_EPSILON = 2;

export function railEdges({
  scrollLeft,
  clientWidth,
  scrollWidth,
}: ScrollMetrics): RailEdges {
  const scrollable = scrollWidth - clientWidth > EDGE_EPSILON;
  if (!scrollable) return { atStart: true, atEnd: true, scrollable: false };
  return {
    atStart: scrollLeft <= EDGE_EPSILON,
    atEnd: scrollLeft + clientWidth >= scrollWidth - EDGE_EPSILON,
    scrollable: true,
  };
}

/**
 * How far one arrow press moves. Slightly less than a full viewport so a card
 * from the previous screenful stays visible and the row keeps its sense of
 * place.
 */
export function pageScrollDelta(clientWidth: number): number {
  return Math.max(160, Math.round(clientWidth * 0.85));
}

/**
 * Roving focus within a rail: the next card index for `key`, or null when the
 * key is not ours to handle.
 *
 * Deliberately clamps instead of wrapping — wrapping from the last card to the
 * first scrolls the row a screen-width in the direction opposite to the one the
 * user pressed, which reads as a bug.
 */
export function nextFocusIndex(
  current: number,
  count: number,
  key: string,
): number | null {
  if (count <= 0) return null;
  const clamp = (n: number) => Math.min(Math.max(n, 0), count - 1);
  switch (key) {
    case "ArrowRight":
      return clamp(current + 1);
    case "ArrowLeft":
      return clamp(current - 1);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
