/**
 * What the hero says, and which item it says it about.
 *
 * The rail payload carries no synopsis — there is no field for one, and there
 * is no honest way to invent one — so the hero's facts line is written from
 * the facts we do hold. It can never be wrong about the one thing the page is
 * for.
 *
 * Pure and DOM-free: `browse-ui.test.ts` drives it as a table.
 */
import type { Rail, RailItem } from "@/lib/browse";

export interface HeroPick {
  item: RailItem;
  /** The rail it came from, so the hero can name the reason it is featured. */
  railId: string;
  eyebrow: string;
}

/** Rails good enough to lead the page, best first. */
const HERO_RAIL_PRIORITY = ["your-library"];

// "Library" is the list of titles you add and track (the nav's Library, the
// title page's "Add to library"), so the rail of files on disk never borrows it.
const EYEBROW_BY_RAIL: Record<string, string> = {
  "your-library": "Downloaded",
};

/**
 * The featured item.
 *
 * Preference order is "what is already here" → whatever exists. Within a rail
 * the first item wins, because every builder already orders by recency.
 * Returns null only when there is genuinely nothing, which is the new-install
 * case the empty state handles.
 */
export function pickHeroItem(rails: readonly Rail[]): HeroPick | null {
  for (const railId of HERO_RAIL_PRIORITY) {
    const rail = rails.find((r) => r.id === railId);
    const item = rail?.items[0];
    if (rail && item) return { item, railId: rail.id, eyebrow: eyebrowFor(rail) };
  }
  for (const rail of rails) {
    const item = rail.items[0];
    if (item) return { item, railId: rail.id, eyebrow: eyebrowFor(rail) };
  }
  return null;
}

function eyebrowFor(rail: Rail): string {
  return EYEBROW_BY_RAIL[rail.id] ?? rail.title;
}

/**
 * The short facts line above the hero title: the episode marker and anything
 * else worth one glance. Empty entries are dropped rather than left as bare
 * separators.
 */
export function heroFacts(item: RailItem): string[] {
  const facts: string[] = [];
  if (item.subtitle) facts.push(item.subtitle);
  return facts;
}
