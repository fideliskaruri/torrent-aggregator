/**
 * Release names in, *works* out.
 *
 * A top-100 feed is a list of files. `House of the Dragon S03E05 480p
 * x264-mSD`, `House of the Dragon S03E05 1080p HEVC x265-MeGusta` and
 * `House.of.the.Dragon.S03E04.2160p.MAX.WEB-DL` are three files and one
 * show, and a browse rail that printed all three would be a directory listing
 * wearing a Netflix costume.
 *
 * The hard part — deciding which release belongs to which film or series — is
 * already solved in `src/lib/torrents/work-identity.ts`, and it is solved
 * *there* because getting it wrong has a long history in this repo: five
 * distinct Dune works merged into one card, a plain `Breaking Bad` release
 * that keyed as a work called "Breaking", scene groups eaten out of real
 * titles by a bare-space delimiter. None of that logic is reimplemented here.
 * This module groups by `workIdentity().key`, sums popularity, and decides
 * nothing about identity at all.
 *
 * ## Popularity is a sum, health is a maximum
 *
 * A show with five releases in the top 100 is more popular than one with a
 * single entry, so the *ordering* signal is the sum of a work's seeders. But
 * `CatalogEntry.seeders` is documented as a health hint shown before a click,
 * and "42,000 seeders" would be a lie about any single thing the user could
 * actually download. So the two are kept apart: `totalSeeders` ranks,
 * `peakSeeders` — the best single release — is what gets stored and shown.
 */
import { workIdentity } from "@/lib/torrents/work-identity";
import {
  isSeriesMediaType,
  normalizeMediaType,
  type MediaType,
} from "@/lib/metadata/media-type";
import type { FeedRelease } from "./feeds";

/** One film or series, assembled from every release of it in the feeds. */
export interface CatalogWork {
  /** `workIdentity().key`. Opaque; never parsed back apart. */
  workKey: string;
  title: string;
  year: number | null;
  mediaType: MediaType;
  /** Sum of seeders over every release of this work — the popularity signal. */
  totalSeeders: number;
  /** Best single release's seeders — the health hint, and never a sum. */
  peakSeeders: number;
  /** The most-seeded release name, so a detail page can pre-rank instantly. */
  bestRelease: string;
  /** How many releases of this work appeared across the feeds. */
  releaseCount: number;
}

/** A release paired with the media type its feed asserts. */
export interface TypedRelease {
  release: FeedRelease;
  /** What the feed's category claims. Normalised before use. */
  mediaType: MediaType;
}

/**
 * Names that are not a work.
 *
 * A top-100 list is user-uploaded, so it contains the occasional bundle
 * ("BAFTA Best Pictures (1947 - 2021)") and the occasional name that survives
 * cleaning as punctuation. The rule class here is deliberately narrow —
 * *structurally* unusable names only, never a blocklist of titles — because
 * anything cleverer would start deciding that real films are not real.
 *
 * A name is unusable when it carries no letter at all (so the card would read
 * as a code), or is a single character (so the card would read as a typo).
 * Everything else is shown: a slightly ugly real title beats a missing row.
 */
export function isRenderableWorkName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length < 2) return false;
  return /\p{L}/u.test(trimmed);
}

/**
 * The media type of a work, given what its feed claims and what its releases
 * declare.
 *
 * The feed's category is the default. It is overridden in exactly one
 * direction: a release that declares season/episode structure is a series,
 * whatever bucket it was filed under, because the release name is
 * self-describing and a category is a human's coarse guess. The reverse is not
 * true — the *absence* of an episode marker is not evidence of a film, since
 * season packs, specials and miniseries all lack one — so a film-shaped
 * release inside a TV feed keeps the feed's answer.
 *
 * Both branches go through `src/lib/metadata/media-type.ts`; nothing here
 * compares a media type string inline.
 */
export function resolveWorkMediaType(
  declared: string | null | undefined,
  isSeries: boolean,
): MediaType | null {
  const normalized = normalizeMediaType(declared);
  if (isSeries && !isSeriesMediaType(normalized)) return "tv";
  return normalized;
}

/**
 * Collapse releases into works, most popular first.
 *
 * Input may span several feeds; that is the point. 205 and 208 carry the same
 * shows at different resolutions, and a work's popularity is only correct once
 * both have been counted into it.
 */
export function collapseToWorks(items: readonly TypedRelease[]): CatalogWork[] {
  const works = new Map<string, CatalogWork>();

  for (const { release, mediaType: declared } of items) {
    const name = release.name?.trim();
    if (!name) continue;

    const identity = workIdentity(name);
    if (!isRenderableWorkName(identity.name)) continue;

    const mediaType = resolveWorkMediaType(declared, identity.isSeries);
    // A work we cannot name a type for is dropped rather than defaulted. The
    // media type drives the search category a card links to, and guessing it
    // sends the user to a category that cannot contain what they clicked.
    if (!mediaType) continue;

    const seeders = Math.max(0, release.seeders);
    const existing = works.get(identity.key);
    if (!existing) {
      works.set(identity.key, {
        workKey: identity.key,
        title: identity.name,
        year: identity.year,
        mediaType,
        totalSeeders: seeders,
        peakSeeders: seeders,
        bestRelease: name,
        releaseCount: 1,
      });
      continue;
    }

    existing.totalSeeders += seeders;
    existing.releaseCount += 1;
    if (seeders > existing.peakSeeders) {
      existing.peakSeeders = seeders;
      existing.bestRelease = name;
    }
  }

  return [...works.values()].sort(compareByPopularity);
}

/**
 * Most popular first, with a total order.
 *
 * The tie-breaks matter more than they look: without them two works with equal
 * seeders swap places between refreshes, the rail reorders under the user for
 * no reason, and every stored `rank` churns. Title last makes the order
 * deterministic even for two brand-new releases at zero seeders.
 */
function compareByPopularity(a: CatalogWork, b: CatalogWork): number {
  if (b.totalSeeders !== a.totalSeeders) return b.totalSeeders - a.totalSeeders;
  if (b.peakSeeders !== a.peakSeeders) return b.peakSeeders - a.peakSeeders;
  return a.title.localeCompare(b.title);
}

/**
 * Every key the seed title could plausibly have in the catalog.
 *
 * A seed harvested from playback progress is a display title with no episode
 * marker ("House of the Dragon"), so `workIdentity` keys it as a *film*; the
 * same show arrives from a feed as a *series*. Both spellings are produced so
 * the seed can be recognised — and excluded — whichever way round it is.
 */
export function seedWorkKeys(seedTitle: string): Set<string> {
  return new Set<string>([
    workIdentity(seedTitle).key,
    workIdentity(`${seedTitle} S01E01`).key,
  ]);
}

/**
 * Works that go with a seed title — "Because you're watching X".
 *
 * A bespoke recommender is an explicit non-goal, and pretending to have one
 * would be the same class of dishonesty as claiming an availability nobody
 * checked. So this is exactly what it says on the row: other popular works of
 * the same kind. Two cheap rules, both of which the row's own heading already
 * admits to:
 *
 *  - **Same media type.** Following a series with a film is a category error;
 *    the seed's own type is the only affinity signal available for free.
 *  - **Adjacent popularity**, when the seed is itself in the pool. Something
 *    with a comparable audience is a better neighbour than the single biggest
 *    title on the internet, which every other row is already showing. When the
 *    seed is *not* in the pool — the usual case, since a personal library
 *    rarely intersects a top-100 — the pool's own popularity order stands, and
 *    no relationship is implied beyond "popular, and the same kind of thing".
 *
 * The seed is matched by work key rather than by title text, so it removes the
 * *work*, not merely a string that looks like it.
 */
/**
 * The minimum a thing needs to expose to be placed on a "Because you're
 * watching…" row. Deliberately not {@link CatalogWork}: the row is re-derived
 * from entries already in the cache, which no longer carry a popularity sum.
 */
export interface RelatableWork {
  workKey: string;
  mediaType: string;
}

export function pickRelated<T extends RelatableWork>(
  pool: readonly T[],
  seedTitle: string,
  seedMediaType: MediaType | null,
  limit: number,
  alreadyOnScreen: ReadonlySet<string> = new Set<string>(),
): T[] {
  const seedKeys = seedWorkKeys(seedTitle);
  const seedIndex = pool.findIndex((work) => seedKeys.has(work.workKey));

  const candidates = pool
    .map((work, index) => ({ work, index }))
    .filter(({ work }) => !seedKeys.has(work.workKey))
    .filter(({ work }) =>
      seedMediaType ? normalizeMediaType(work.mediaType) === seedMediaType : true,
    );

  // Whether a candidate is already rendered on another discovery rail. This
  // outranks every other signal: the pool is simply "popular things of this
  // kind", so without it this row is the row beneath it, reordered — which is
  // how it actually shipped, and it read as a bug rather than a suggestion.
  const onScreen = (entry: { work: T }) =>
    alreadyOnScreen.has(entry.work.workKey) ? 1 : 0;

  candidates.sort((a, b) => {
    const byUnseen = onScreen(a) - onScreen(b);
    if (byUnseen !== 0) return byUnseen;

    if (seedIndex >= 0) {
      const byDistance =
        Math.abs(a.index - seedIndex) - Math.abs(b.index - seedIndex);
      // Ties (one neighbour either side) resolve towards the more popular of
      // the two, so the order is total and does not churn between refreshes.
      if (byDistance !== 0) return byDistance;
    }

    return a.index - b.index;
  });

  return candidates.slice(0, limit).map(({ work }) => work);
}
