/**
 * The one honest thing a *release* row may say about itself.
 *
 * The product forbids narrating mechanism on the results surface — no seed or
 * peer counts, no byte sizes, no Health %, no indexer names, no `SxxExx`
 * codes, no raw scene names. What remains, and what a viewer choosing between
 * two prints of the same title actually cares about, is picture quality: "4K"
 * vs "1080p", and whether it is a Blu-ray or a web rip.
 *
 * So a release contributes at most two facts — a resolution label and a source
 * tier — returned as a list so the row can render them with a real separator
 * element between each. Adjacent text nodes ("2160pWEB-DL") are the exact
 * a11y/reflow defect the results rework is closing; a caller must never
 * `join("")` these.
 *
 * Pure and DOM-free: `release-facts.test.ts` drives it as a table.
 */
import type { TorrentResult } from "@/lib/torrents/types";
import { parseResolution } from "@/lib/torrents/quality";

/** A friendly resolution label, or null when none is stated. */
export function resolutionLabel(title: string): string | null {
  const res = parseResolution(title);
  if (res == null) return null;
  if (res >= 2160) return "4K";
  return `${res}p`;
}

/**
 * Source families a viewer actually distinguishes, matched directly rather
 * than via {@link parseSourceTier}: that helper *collapses* Blu-ray and WEB-DL
 * onto the same numeric rank, so it cannot name them apart. Order matters —
 * a web rip and a web-dl both contain "web", so they share one label, and the
 * disc group is tried first.
 */
const SOURCE_LABELS: Array<[RegExp, string]> = [
  [/\b(?:blu[-_. ]?ray|bluray|bdrip|brrip|bd[-_. ]?remux|remux|uhdbd)\b/i, "Blu-ray"],
  [/\b(?:web[-_. ]?rip|webrip|web[-_. ]?dl|webdl)\b/i, "WEB-DL"],
  [/\b(?:hdtv|pdtv|sdtv|dsr|dvbs?[-_. ]?rip|tvrip)\b/i, "HDTV"],
];

/** A friendly source label, or null when the source is unknown. */
export function sourceLabel(title: string): string | null {
  for (const [re, label] of SOURCE_LABELS) {
    if (re.test(title)) return label;
  }
  // Bare "WEB" is the short form of WEB-DL, but only as scene metadata beside a
  // stated resolution — never an ordinary word like *Charlotte's Web*.
  if (parseResolution(title) != null && /\bweb\b/i.test(title)) return "WEB-DL";
  return null;
}

/**
 * The quality facts for a release, in render order. Never includes size,
 * seeders, health, indexer, or episode codes.
 */
export function releaseFacts(torrent: TorrentResult): string[] {
  const facts: string[] = [];
  const res = resolutionLabel(torrent.title);
  if (res) facts.push(res);
  const src = sourceLabel(torrent.title);
  if (src) facts.push(src);
  return facts;
}

/**
 * A short accessible name for a release row's actions, e.g. "4K · Blu-ray".
 * Falls back to "Standard" when nothing quality-bearing was parsed, so a row
 * never announces the empty string.
 */
export function releaseQualityName(torrent: TorrentResult): string {
  const facts = releaseFacts(torrent);
  return facts.length ? facts.join(" · ") : "Standard";
}
