/**
 * What the hero says, and which item it says it about.
 *
 * The rail payload carries no synopsis — there is no field for one, and there
 * is no honest way to invent one — so the hero's paragraph is written from the
 * facts we do hold: availability, how far in you are, and whether the thing is
 * on disk. That is genuinely more useful than a catalog blurb here, and it can
 * never be wrong about the one thing the page is for.
 *
 * Pure and DOM-free: `browse-ui.test.ts` drives it as a table.
 */
import type { Rail, RailItem } from "@/lib/browse";
import { progressPercent } from "./availability";

export interface HeroPick {
  item: RailItem;
  /** The rail it came from, so the hero can name the reason it is featured. */
  railId: string;
  eyebrow: string;
}

/** Rails good enough to lead the page, best first. */
const HERO_RAIL_PRIORITY = ["continue-watching", "ready-to-play", "next-up"];

const EYEBROW_BY_RAIL: Record<string, string> = {
  "continue-watching": "Continue watching",
  "ready-to-play": "Ready to play",
  "next-up": "Next up",
  "my-library": "From your library",
};

/**
 * The featured item.
 *
 * Preference order is "what you were doing" → "what plays instantly" → "what is
 * coming" → whatever exists. Within a rail the first item wins, because every
 * builder already orders by recency. Returns null only when there is genuinely
 * nothing, which is the new-install case the empty state handles.
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
 * The short facts line above the hero title: episode marker, how far in, and
 * anything else worth one glance. Empty entries are dropped rather than left as
 * bare separators.
 */
export function heroFacts(item: RailItem): string[] {
  const facts: string[] = [];
  if (item.subtitle) facts.push(item.subtitle);
  const percent = progressPercent(item.progressFraction);
  if (percent != null && percent < 100) facts.push(`${percent}% watched`);
  return facts;
}
