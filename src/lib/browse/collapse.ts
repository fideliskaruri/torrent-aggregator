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
 * Two properties matter to the rail and they are ranked, not blended:
 *
 *  1. **Artwork.** A collapse that drops the only member with a poster trades
 *     a duplicate for a blank tile, which is a worse rail than the one it
 *     replaced.
 *  2. **Recency.** These rails are ordered newest-first, so the surviving
 *     member must carry the group's newest timestamp or the card sinks below
 *     things that arrived before it.
 *
 * This module has no database dependency on purpose: it is the rule, and the
 * rule is testable without a Prisma client or a running server.
 */
import { workIdentity } from "@/lib/torrents/work-identity";

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
  /** Whatever the caller wants back out. */
  value: T;
}

/** One work, plus how many releases collapsed into it. */
export interface CollapsedWork<T> {
  /** `workIdentity().key`. Opaque; never parsed back apart or displayed. */
  workKey: string;
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
 */
export function collapseReleasesByWork<T>(
  releases: readonly CollapsibleRelease<T>[],
): CollapsedWork<T>[] {
  const byWork = new Map<string, CollapsedWork<T> & { sortAt: Date; hasArtwork: boolean }>();

  for (const release of releases) {
    const name = release.name?.trim();
    if (!name) continue;

    const key = workIdentity(name).key || name.toLowerCase();
    const hasArtwork = release.hasArtwork === true;
    const existing = byWork.get(key);

    if (!existing) {
      byWork.set(key, {
        workKey: key,
        value: release.value,
        name,
        releaseCount: 1,
        sortAt: release.sortAt,
        hasArtwork,
      });
      continue;
    }

    existing.releaseCount += 1;

    // Artwork outranks recency: a poster is the difference between a card and
    // a blank tile, while a few seconds of ordering is invisible.
    const winsOnArtwork = hasArtwork && !existing.hasArtwork;
    const tiedOnArtwork = hasArtwork === existing.hasArtwork;
    const winsOnRecency =
      tiedOnArtwork && release.sortAt.getTime() > existing.sortAt.getTime();

    if (winsOnArtwork || winsOnRecency) {
      existing.value = release.value;
      existing.name = name;
      existing.sortAt = release.sortAt;
      existing.hasArtwork = hasArtwork;
    }
  }

  return [...byWork.values()].map(({ workKey, value, name, releaseCount }) => ({
    workKey,
    value,
    name,
    releaseCount,
  }));
}
