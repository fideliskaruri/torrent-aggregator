/**
 * The "X" in "Because you're watching X".
 *
 * The row only exists when there genuinely *is* an X. Inventing one — picking
 * a popular title and telling the user they are watching it — is the same
 * class of lie as claiming an availability nobody checked, and it is the
 * easier one to tell, because nothing in the UI would look wrong.
 *
 * So the seed comes from rows the user created by doing something:
 *
 *  1. **The thing they are part-way through.** `PlaybackProgress` with no
 *     `completedAt`, most recently touched. Strongest possible signal: they
 *     are, right now, watching it.
 *  2. **The thing they most recently added to their library.** A monitored
 *     `WatchListItem` is an explicit statement of interest, and it carries a
 *     stored `mediaType`, which progress rows do not.
 *
 * Nothing else qualifies. A finished film from a year ago is not what someone
 * is watching, and a download in the client is not a preference.
 */
import prisma from "@/lib/prisma";
import { normalizeMediaType, type MediaType } from "@/lib/metadata/media-type";
import { isSlopTitle } from "@/lib/metadata/slop";
import { workIdentity } from "@/lib/torrents/work-identity";

/** What the rail is seeded with. */
export interface CatalogSeed {
  /** The title as the user's own row spells it — this is printed in the heading. */
  title: string;
  /**
   * Null only when nothing in the source row states or implies one. A
   * `WatchListItem` stores it outright; a `PlaybackProgress` row does not, but
   * a season or episode number on it is a statement of the same fact, and
   * a row that carries neither is genuinely unknown rather than a film.
   */
  mediaType: MediaType | null;
}

/**
 * The seed for a user, or null when they have not done anything yet.
 *
 * Returns null rather than a fallback: on a brand-new install there is no
 * honest answer, and the rail is omitted.
 */
export async function readWatchSeed(userId: string): Promise<CatalogSeed | null> {
  const watching = await prisma.playbackProgress.findFirst({
    where: { userId, completedAt: null },
    orderBy: { updatedAt: "desc" },
    select: {
      title: true,
      season: true,
      episode: true,
      watchListItemId: true,
    },
  });

  if (watching?.title?.trim()) {
    let title = seedTitleOf(watching.title);
    // A progress row whose title is only an episode coordinate — created from a
    // raw magnet named "…S01E05…" or a bare file name — reduces to something
    // like "S01E05", and "Because you're watching S01E05" is a heading no
    // product would ship. When that happens, the row's linked library item
    // carries the real show name; prefer it. This is I9: the rail must expose
    // the show's TITLE, never an SxxExx code.
    if (isUnusableSeedTitle(title) && watching.watchListItemId) {
      const linked = await prisma.watchListItem.findUnique({
        where: { id: watching.watchListItemId },
        select: { title: true },
      });
      const linkedTitle = linked?.title?.trim();
      if (linkedTitle) {
        const cleaned = seedTitleOf(linkedTitle);
        if (!isUnusableSeedTitle(cleaned)) title = cleaned;
      }
    }
    return {
      title,
      mediaType: await progressMediaType(watching),
    };
  }

  const library = await prisma.watchListItem.findFirst({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    select: { title: true, mediaType: true },
  });

  if (library?.title?.trim()) {
    return {
      title: seedTitleOf(library.title),
      mediaType: normalizeMediaType(library.mediaType),
    };
  }

  return null;
}

/**
 * The media type of a progress row, from the two places it can be known.
 *
 * A progress row has no media type column, but it is not therefore type-blind:
 * a season or episode number on it is the same fact stated differently, and it
 * is a *recorded* fact rather than an inference from the filename. Taking it
 * matters because the picker filters the rail by type — without it, "Because
 * you're watching House of the Dragon" fills up with films, which reads as a
 * recommender that has not understood the question.
 *
 * The reverse does not hold. A row with no episode numbers is a film *or* a
 * miniseries *or* a series someone opened by file path, so the answer stays
 * null and the picker declines to filter rather than guessing.
 */
async function progressMediaType(row: {
  season: number | null;
  episode: number | null;
  watchListItemId: string | null;
}): Promise<MediaType | null> {
  if (row.season !== null || row.episode !== null) {
    return SERIES_MEDIA_TYPE;
  }

  // No episode structure, but the row may point at the library row that states
  // the type outright. One indexed lookup.
  if (row.watchListItemId) {
    const linked = await prisma.watchListItem.findUnique({
      where: { id: row.watchListItemId },
      select: { mediaType: true },
    });
    return normalizeMediaType(linked?.mediaType);
  }

  return null;
}

/**
 * The media type an episode-numbered row has, resolved through the shared
 * vocabulary rather than written as a bare string literal — the same rule the
 * rest of the catalog follows, so a change to that vocabulary reaches here.
 */
const SERIES_MEDIA_TYPE = normalizeMediaType("tv");

/**
 * The seed title, reduced to the *work* it names.
 *
 * Library and progress rows usually hold a catalog title already, but a
 * progress row can be created from a raw release name by a manually-added
 * magnet, and "Because you're watching
 * Severance.S02E05.1080p.ATVP.WEB-DL.DDP5.1.Atmos" is a heading no product
 * would ship. `workIdentity` is the same reduction the rails already use, so
 * the heading and the exclusion below agree by construction.
 */
function seedTitleOf(raw: string): string {
  const trimmed = raw.trim();
  return workIdentity(trimmed).name || trimmed;
}

/**
 * True when a reduced seed title is not usable as a rail heading — it is a
 * placeholder or a bare episode coordinate ("S01E05", "Episode 5") rather than
 * the name of a work. The rule class is shared with the browse rails via
 * `@/lib/metadata/slop`, so the heading and the rest of the catalog agree about
 * what counts as a real title.
 */
function isUnusableSeedTitle(title: string): boolean {
  return isSlopTitle(title);
}
