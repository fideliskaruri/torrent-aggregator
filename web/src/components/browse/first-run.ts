/**
 * What the browse page says when it has little or nothing to show.
 *
 * A fresh install is not an edge case — it is everyone's first thirty seconds,
 * and `GET /api/browse` correctly answers `{"rails":[]}` because there is no
 * library, no history and nothing on disk. A Netflix-style home is defined
 * almost entirely by its rails, so zero rails renders as a blank page that
 * reads "broken" or "still loading" rather than "new".
 *
 * The answer is to show the page's own structure while it is still empty: the
 * real rail titles, in the real order, each with the one sentence that says
 * what puts something in it and the route that gets you there. The user learns
 * the shape of the product from the shape of the page, and every link is a
 * page that already exists.
 *
 * Pure and DOM-free so `browse-ui.test.ts` can drive it as a table — the rail
 * ids here have to keep matching the data layer's, and a table is how that
 * stays true.
 */

export interface RailPreview {
  /** Must match the rail id emitted by the data layer. */
  id: string;
  /** Must match the rail's own title, so the empty page teaches the real one. */
  title: string;
  /** One line: what puts something here. */
  blurb: string;
  href: string;
  cta: string;
}

/**
 * The personal rail, in the order `BrowseService` emits it.
 *
 * Kept as data rather than JSX so the ids stay next to the data layer's: a
 * rail renamed there and not here would otherwise show a first-run page
 * describing a rail that no longer exists.
 */
export const RAIL_PREVIEWS: readonly RailPreview[] = [
  {
    id: "your-library",
    title: "Downloaded",
    blurb: "Series and films that are downloaded and ready to open, newest first.",
    href: "/downloads",
    cta: "Open downloads",
  },
] as const;

/** The minimum a rail-like object has to expose to be counted. */
export interface CountableRail {
  id: string;
  items: readonly unknown[];
}

/**
 * Which rails have nothing in them.
 *
 * Used for the *partially* empty page — some rails populated, some not. The
 * board omits an empty rail rather than drawing a title over blank space,
 * because a rail heading is a promise of contents and an empty one is both a
 * broken promise and pure vertical noise between two rows that do have
 * something. But silently omitting it also teaches nothing, so the page ends
 * with a compact note naming what is not showing yet and why — below the real
 * content, where it cannot interrupt it.
 *
 * Returns previews in the canonical rail order, not the payload's, so the note
 * reads the same regardless of which rails happened to survive.
 */
export function missingRailPreviews(
  rails: readonly CountableRail[],
): RailPreview[] {
  const populated = new Set(
    rails.filter((rail) => rail.items.length > 0).map((rail) => rail.id),
  );
  return RAIL_PREVIEWS.filter((preview) => !populated.has(preview.id));
}

/** True when the payload has no card in any rail — the first-run case. */
export function isFirstRun(rails: readonly CountableRail[]): boolean {
  return !rails.some((rail) => rail.items.length > 0);
}
