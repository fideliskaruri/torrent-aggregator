/**
 * What a *release row* says so a human can actually choose one.
 *
 * The watch surface deliberately narrates nothing about mechanism — while
 * someone is watching, seed counts and byte sizes are noise. A release *picker*
 * is the opposite problem: twelve prints of the same show that all read
 * "1080p · WEB-DL" are indistinguishable, so the list cannot be used to pick.
 * Here the distinguishing facts *are* the product.
 *
 * So a row gets four ordered, render-safe facts —
 *
 *   1. which episode/season it is (the strongest differentiator for a series),
 *   2. resolution,
 *   3. source tier,
 *   4. size,
 *
 * — plus a separate swarm-strength reading (see {@link seedStrength}) that says
 * whether it will actually play. Every string is curated: no indexer names, no
 * Health %, no codec/group scene noise. The row renders each fact with a real
 * separator element between them; a caller must never `join("")` these into an
 * adjacent-text-node blob like "1080pWEB-DL".
 *
 * Encapsulating the mechanism strings here (not in the card component) keeps the
 * card free of raw `torrent.seeders` / `formatBytes` plumbing and gives this one
 * pure, DOM-free module a table-driven test: `release-facts.test.ts`.
 */
import type { TorrentResult } from "@/lib/torrents/types";
import { parseResolution } from "@/lib/torrents/quality";
import { parseEpisode } from "@/lib/torrents/episodes";
import { formatBytes } from "@/lib/utils";

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
 * Which episode or season pack a release is, e.g. "S01E03", "S01 pack",
 * "Ep 12" — the single most useful differentiator when a series returns a row
 * per episode. Delegates to the shared {@link parseEpisode} so a row labels a
 * release exactly the way the rest of the app files it; the server-parsed
 * `torrent.episode` is trusted first to avoid re-parsing an already-known name.
 */
export function episodeLabel(torrent: TorrentResult): string | null {
  const info = torrent.episode ?? parseEpisode(torrent.title);
  return info.label ?? null;
}

/**
 * A human size for the release, preferring the exact byte count and falling
 * back to a source-provided label. Null when neither is known, so the row omits
 * the fact rather than printing a placeholder dash.
 */
export function sizeFact(torrent: TorrentResult): string | null {
  if (torrent.sizeBytes != null && torrent.sizeBytes > 0) {
    return formatBytes(torrent.sizeBytes);
  }
  const label = torrent.sizeLabel?.trim();
  return label ? label : null;
}

/** How healthy a release's swarm is — the thing that decides if Play works. */
export type SeedLevel = "strong" | "fair" | "weak";

export interface SeedStrength {
  count: number;
  level: SeedLevel;
  /** Accessible, spoken form: "312 seeders". */
  label: string;
}

/**
 * A release with hundreds of seeders plays instantly; a release with one may
 * never start. That difference is exactly what a chooser must show, so it is
 * surfaced as a compact three-tier reading rather than buried. Thresholds are
 * deliberately coarse — the user needs "will this play?", not a precise count
 * race between two similar releases.
 */
export function seedStrength(torrent: TorrentResult): SeedStrength {
  const count = Math.max(0, Math.round(torrent.seeders ?? 0));
  const level: SeedLevel = count >= 50 ? "strong" : count >= 5 ? "fair" : "weak";
  return { count, level, label: `${count} ${count === 1 ? "seeder" : "seeders"}` };
}

/**
 * The neutral, curated facts for a release row, in render order:
 * resolution, source, size. Episode and swarm strength render as their own,
 * more prominent elements ({@link episodeLabel}, {@link seedStrength}), so they
 * are intentionally *not* in this list. Never includes indexer names, Health,
 * codecs, or raw scene names.
 */
export function releaseFacts(torrent: TorrentResult): string[] {
  const facts: string[] = [];
  const res = resolutionLabel(torrent.title);
  if (res) facts.push(res);
  const src = sourceLabel(torrent.title);
  if (src) facts.push(src);
  const size = sizeFact(torrent);
  if (size) facts.push(size);
  return facts;
}

/**
 * A short accessible name for a release row's actions, e.g.
 * "S01E03 · 1080p · WEB-DL". Includes the episode so a screen-reader user hears
 * which release they are about to play. Falls back to "Standard" when nothing
 * describable was parsed, so a row never announces the empty string.
 */
export function releaseQualityName(torrent: TorrentResult): string {
  const parts = [episodeLabel(torrent), ...releaseFacts(torrent)].filter(
    (p): p is string => Boolean(p),
  );
  return parts.length ? parts.join(" · ") : "Standard";
}
