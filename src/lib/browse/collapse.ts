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
   * A caller-known catalog/library work title. The release name still supplies
   * the identity key unless `workKey` is also set.
   */
  workTitle?: string;
  /** A caller-known work key when a catalog/library row is the identity source. */
  workKey?: string;
  /** Stable parent identity used only for collapsing linked rows. */
  identityKey?: string;
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
  const works: Array<
    CollapsedWork<T> & {
      identityKey: string | null;
      aliases: Set<string>;
      sortAt: Date;
      hasArtwork: boolean;
      prefer: boolean;
    }
  > = [];

  for (const release of releases) {
    const name = release.name?.trim();
    if (!name) continue;

    const display = browseWorkDisplay(name);
    const workKey = release.workKey?.trim() || display.key;
    const identityKey = release.identityKey?.trim() || null;
    const aliases = new Set([
      `key:${workKey}`,
      `release:${display.key}`,
      ...(release.workTitle?.trim()
        ? [`title:${browseWorkDisplay(release.workTitle).key}`]
        : []),
    ]);
    const title = release.workTitle?.trim() || display.title;
    const hasArtwork = release.hasArtwork === true;
    const prefer = release.prefer === true;
    const overlaps = (work: (typeof works)[number]) =>
      [...aliases].some((alias) => work.aliases.has(alias));
    let matches = works.filter((work) => {
      if (identityKey && work.identityKey) {
        return identityKey === work.identityKey;
      }
      return overlaps(work);
    });
    if (!identityKey) {
      const linkedIdentities = new Set(
        matches
          .map((work) => work.identityKey)
          .filter((id): id is string => id != null),
      );
      if (linkedIdentities.size > 1) {
        matches = matches.filter((work) => work.identityKey == null);
      }
    }
    const existing = matches.find((work) => work.identityKey === identityKey)
      ?? matches.find((work) => work.identityKey != null)
      ?? matches[0];

    if (!existing) {
      works.push({
        identityKey,
        aliases,
        workKey,
        title,
        value: release.value,
        name,
        releaseCount: 1,
        sortAt: release.sortAt,
        hasArtwork,
        prefer,
      });
      continue;
    }

    for (const match of matches) {
      if (match === existing) continue;
      match.aliases.forEach((alias) => existing.aliases.add(alias));
      existing.releaseCount += match.releaseCount;
      if (preferredRepresentative(match, existing)) {
        existing.value = match.value;
        existing.name = match.name;
        existing.title = match.title;
        existing.sortAt = match.sortAt;
        existing.hasArtwork = match.hasArtwork;
        existing.prefer = match.prefer;
      }
      works.splice(works.indexOf(match), 1);
    }
    aliases.forEach((alias) => existing.aliases.add(alias));
    if (identityKey && !existing.identityKey) existing.identityKey = identityKey;
    if (identityKey && release.workKey?.trim()) {
      existing.workKey = release.workKey.trim();
    }
    existing.releaseCount += 1;

    // Representative preference outranks artwork, which outranks recency. A
    // caller that knows which member can best play the work should not have to
    // forge a timestamp to beat a newer single file.
    if (preferredRepresentative(
      { prefer, hasArtwork, sortAt: release.sortAt },
      existing,
    )) {
      existing.value = release.value;
      existing.name = name;
      existing.title = title;
      existing.sortAt = release.sortAt;
      existing.hasArtwork = hasArtwork;
      existing.prefer = prefer;
    }
  }

  return works.map(
    ({ workKey, title, value, name, releaseCount }) => ({
      workKey,
      title,
      value,
      name,
      releaseCount,
    }),
  );
}

function preferredRepresentative(
  candidate: Pick<CollapsibleRelease<unknown>, "sortAt" | "hasArtwork" | "prefer">,
  current: Pick<CollapsibleRelease<unknown>, "sortAt" | "hasArtwork" | "prefer">,
): boolean {
  const candidatePreferred = candidate.prefer === true;
  const currentPreferred = current.prefer === true;
  if (candidatePreferred !== currentPreferred) return candidatePreferred;

  const candidateHasArtwork = candidate.hasArtwork === true;
  const currentHasArtwork = current.hasArtwork === true;
  if (candidateHasArtwork !== currentHasArtwork) return candidateHasArtwork;

  return candidate.sortAt.getTime() > current.sortAt.getTime();
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
  const numberedSeries = identity.isSeries
    ? explicitNumberedSeriesTitle(trimmed, derived)
    : null;

  if (numberedSeries) {
    return { key: `series:${normalizeBrowseKey(numberedSeries)}`, title: numberedSeries };
  }

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

function explicitNumberedSeriesTitle(
  releaseName: string,
  identityTitle: string,
): string | null {
  if (!identityTitle || isEpisodeOnlyLabel(identityTitle)) return null;

  const normalized = releaseName
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const marker = normalized.search(/\bS\d{1,3}\s*E\d{1,4}\b/i);
  if (marker <= 0) return null;

  const head = normalized
    .slice(0, marker)
    .replace(/[\s\-–—_:|.]+$/g, "")
    .trim();
  if (!/\s\d{1,4}$/.test(head)) return null;

  const headKey = normalizeBrowseKey(head);
  const identityKey = normalizeBrowseKey(identityTitle);
  if (!headKey || !identityKey) return null;

  return headKey.replace(/\s+\d{1,4}$/, "") === identityKey ? head : null;
}

function normalizeBrowseKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
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
