/**
 * Collapsing a list of *releases* into a list of *works*.
 *
 * A rail shows things you can decide to watch, and "Dune: Part Two" is one
 * such thing whether you grabbed the 1080p print, the 2160p print, or both.
 * `Ready to Play` has always collapsed; `Recently Added` emitted one card per
 * grab, so the same film could occupy two, three or four slots of a twenty
 * slot rail and push out four other films.
 *
 * ## The key is the full work identity, never the display name
 *
 * `workIdentity()` returns an opaque key that already encodes kind, name and —
 * for films — year: `film:dune part two:2024`. Keying on the *name* alone
 * would merge *Dune* (1984) into *Dune* (2021), which is the same
 * borrowed-identity failure the work-identity module exists to forbid. So the
 * key is passed through whole and never parsed back apart.
 *
 * ## Which member survives
 *
 * Three properties matter to the rail and they are ranked, not blended:
 *
 *  1. **Explicit representative preference.** Some callers know a release is
 *     the better playable representative of the work, independent of recency.
 *  2. **Artwork.** A collapse that drops the only member with a poster trades
 *     a duplicate for a blank tile, which is a worse rail than the one it
 *     replaced.
 *  3. **Recency.** These rails are ordered newest-first, so the surviving
 *     member must carry the group's newest timestamp or the card sinks below
 *     things that arrived before it.
 *
 * This module has no database dependency on purpose: it is the rule, and the
 * rule is testable without a Prisma client or a running server.
 */
import { workIdentity } from "@/lib/torrents/work-identity";

export const UNKNOWN_WORK_TITLE = "Unknown title";

/** One release, as the collapser needs to see it. */
export interface CollapsibleRelease<T> {
  /**
   * The raw release/torrent name. Identity is derived from this, never from a
   * cleaned display title — cleaning is lossy and two spellings of one work
   * must not key apart.
   */
  name: string;
  /** Newest-first ordering signal. */
  sortAt: Date;
  /**
   * Whether this member already carries artwork. Rails whose rows have no
   * artwork column pass `false` for every member, which reduces the rule to
   * "newest wins" — the correct answer when nobody has a poster.
   */
  hasArtwork?: boolean;
  /**
   * Prefer this member as the work's representative before artwork/recency
   * tiebreaks. This is not an ordering timestamp; callers should keep `sortAt`
   * truthful and state representative intent here.
   */
  prefer?: boolean;
  /** Whatever the caller wants back out. */
  value: T;
}

/** One work, plus how many releases collapsed into it. */
export interface CollapsedWork<T> {
  /** `workIdentity().key`. Opaque; never parsed back apart or displayed. */
  workKey: string;
  /** The visible card title, derived from the same release name as `workKey`. */
  title: string;
  /** The surviving member: has artwork if any member did, and is the newest. */
  value: T;
  /** The surviving member's release name — the identity source. */
  name: string;
  /** How many releases of this work were seen. `1` for most cards. */
  releaseCount: number;
}

/**
 * Collapse releases to works, newest first, order-stable within ties.
 *
 * The output preserves the order in which each work was *first* seen, so a
 * caller that queried `orderBy: createdAt desc` gets its recency ordering back
 * unchanged. A name that yields no usable identity key falls back to the name
 * itself, so an unparseable release still gets a card rather than vanishing.
 * The visible title is derived here too, because grouping on one parser and
 * printing through another is how `Ready to Play` could collapse one way while
 * `Continue Watching` put `S01E02` on a card.
 */
export function collapseReleasesByWork<T>(
  releases: readonly CollapsibleRelease<T>[],
): CollapsedWork<T>[] {
  const byWork = new Map<
    string,
    CollapsedWork<T> & { sortAt: Date; hasArtwork: boolean; prefer: boolean }
  >();

  for (const release of releases) {
    const name = release.name?.trim();
    if (!name) continue;

    const display = browseWorkDisplay(name);
    const key = display.key;
    const hasArtwork = release.hasArtwork === true;
    const prefer = release.prefer === true;
    const existing = byWork.get(key);

    if (!existing) {
      byWork.set(key, {
        workKey: key,
        title: display.title,
        value: release.value,
        name,
        releaseCount: 1,
        sortAt: release.sortAt,
        hasArtwork,
        prefer,
      });
      continue;
    }

    existing.releaseCount += 1;

    // Representative preference outranks artwork, which outranks recency. A
    // caller that knows which member can best play the work should not have to
    // forge a timestamp to beat a newer single file.
    const winsOnPreference = prefer && !existing.prefer;
    const tiedOnPreference = prefer === existing.prefer;
    const winsOnArtwork = tiedOnPreference && hasArtwork && !existing.hasArtwork;
    const tiedOnArtwork = tiedOnPreference && hasArtwork === existing.hasArtwork;
    const winsOnRecency =
      tiedOnArtwork && release.sortAt.getTime() > existing.sortAt.getTime();

    if (winsOnPreference || winsOnArtwork || winsOnRecency) {
      existing.value = release.value;
      existing.name = name;
      existing.title = display.title;
      existing.sortAt = release.sortAt;
      existing.hasArtwork = hasArtwork;
      existing.prefer = prefer;
    }
  }

  return [...byWork.values()].map(
    ({ workKey, title, value, name, releaseCount }) => ({
      workKey,
      title,
      value,
      name,
      releaseCount,
    }),
  );
}

/**
 * The rail-facing identity for one release name.
 *
 * `workIdentity()` deliberately falls back to the trimmed release when the
 * structural cut leaves no name. That is safe for search grouping, where losing
 * a release would be worse than keeping a noisy label, but it is not safe for a
 * browse card: a bare `S01E02` is an episode coordinate, not a work. Keep the
 * card so progress is not hidden, but print an explicit unknown title instead
 * of promoting the coordinate into the title slot.
 */
export function browseWorkDisplay(name: string): { key: string; title: string } {
  const trimmed = name.trim();
  const identity = workIdentity(trimmed);
  const derived = identity.name.trim();

  if (derived && !isEpisodeOnlyLabel(derived)) {
    return { key: identity.key || fallbackWorkKey(trimmed), title: derived };
  }

  const fallback =
    trimmed && !isEpisodeOnlyLabel(trimmed) ? trimmed : UNKNOWN_WORK_TITLE;
  return { key: fallbackWorkKey(trimmed), title: fallback };
}

function fallbackWorkKey(name: string): string {
  return `release:${name.toLowerCase().replace(/\s+/g, " ").trim()}`;
}

function isEpisodeOnlyLabel(value: string): boolean {
  const label = value
    .toLowerCase()
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /^(?:s\d{1,3}\s*e\d{1,4}|\d{1,3}x\d{1,4}|e(?:p(?:isode)?)?\s*\d{1,4}|episode\s+\d{1,4})$/.test(
    label,
  );
}
