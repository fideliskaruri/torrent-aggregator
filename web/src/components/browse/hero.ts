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
import { browseReleaseGate } from "@/lib/browse/release-status";

export interface HeroPick {
  item: RailItem;
  /** The rail it came from, so the hero can name the reason it is featured. */
  railId: string;
  eyebrow: string;
}

/** Rails good enough to lead the page, best first. */
const HERO_RAIL_PRIORITY = ["because-you-are-watching"];

/** Already on this machine, so it only leads when nothing else can. */
const HERO_LAST_RESORT = "your-library";

// "Library" is the list of titles you add and track (the nav's Library, the
// title page's "Add to library"), so the rail of files on disk never borrows it.
const EYEBROW_BY_RAIL: Record<string, string> = {
  "your-library": "Downloaded",
};

/**
 * The featured item: the first title you can get now, never one in cinemas or
 * not out yet (the same `browseReleaseGate` that draws the cards' chips).
 *
 * Preference order is Because you're watching, then the rails in page order
 * (popular first), then the Downloaded rail. Rails are stable for the day, so
 * the hero is too. Returns null only when there is genuinely nothing, which is
 * the new-install case the empty state handles.
 */
export function pickHeroItem(
  rails: readonly Rail[],
  now: Date = new Date(),
): HeroPick | null {
  const ordered = [
    ...HERO_RAIL_PRIORITY.flatMap((id) => rails.filter((r) => r.id === id)),
    ...rails.filter(
      (r) => !HERO_RAIL_PRIORITY.includes(r.id) && r.id !== HERO_LAST_RESORT,
    ),
    ...rails.filter((r) => r.id === HERO_LAST_RESORT),
  ];
  for (const rail of ordered) {
    const item = rail.items.find((i) => !browseReleaseGate(i, now).gated);
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
