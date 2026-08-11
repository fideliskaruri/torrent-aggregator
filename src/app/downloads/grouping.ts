/**
 * Collapsing the Downloads list into one row per work.
 *
 * A client mid-way through a season shows twelve rows that are all the same
 * show, all at different percentages, and no answer at all to the question the
 * page exists to answer: *am I going to be able to watch this tonight?* One
 * row per series, carrying the combined progress of everything under it, is
 * that answer. Films stay as they are — a film is already one row, and wrapping
 * it in a group would add a disclosure triangle that reveals itself.
 *
 * Four rules run through everything below, and each of them is a specific way
 * this would otherwise lie to the user:
 *
 *  - **Progress is weighted by size, never averaged.** Ten finished 100 MB
 *    episodes plus one untouched 4 GB season pack is 19% of the bytes, and the
 *    average of the percentages says 91%. The second number sends someone to
 *    the sofa.
 *  - **A group never claims more than its members.** If anything under it is
 *    still downloading, the group is not downloaded, whatever the
 *    percentage rounds to.
 *  - **A season pack and the loose episodes of that season are not counted
 *    twice.** They are the same content held twice on disk; summing both
 *    inflates the denominator and understates how far along you are.
 *  - **Order cannot depend on anything that moves.** The page re-polls the
 *    client every five seconds and re-renders from the answer, so an order
 *    derived from progress, speed or state would rearrange rows under the
 *    cursor. The engine already sorts its own list for exactly this reason
 *    (`builtin-engine.ts`: "a torrent visibly JUMPED from the tail of the list
 *    into the middle"), and an external client offers no such promise, so the
 *    order is recomputed here from identity alone.
 *
 * Pure and DOM-free: `grouping.test.ts` drives it as a table.
 */
import { workIdentityFor } from "@/components/title/work-key";
import { formatEpisodeLabel } from "@/lib/library/cursor";
import { parseEpisode, seasonFolderSegment } from "@/lib/torrents/episodes";
import { isSeriesDownload } from "./media-filter";

/** The fields grouping needs. The page's own row type is a superset. */
export interface TransferRow {
  hash: string;
  transferId?: string;
  name: string;
  category?: string | null;
  /** 0–1. */
  progress: number;
  sizeBytes: number;
  dlspeed: number;
  upspeed: number;
  /** Raw client state string, in qBittorrent's vocabulary. */
  state: string;
  playable?: boolean;
  workId?: string | null;
  workKey?: string | null;
  workTitle?: string | null;
  workYear?: number | null;
  workMediaType?: string | null;
  season?: number | null;
  episode?: number | null;
}

// ---------------------------------------------------------------------------
// What a transfer is doing
// ---------------------------------------------------------------------------
//
// These moved out of `page.tsx` rather than being rewritten here. The status
// filter, the badge colours and a group's combined state all have to agree
// about what "downloaded" means, including legacy external-client seed states.

const DOWNLOADING_STATES = new Set([
  "allocating",
  "checking",
  "checkingdl",
  "checkingresumedata",
  "checkingup",
  "downloading",
  "forceddl",
  "metadl",
  "queuedcheck",
  "queueddownload",
  "queueddl",
  "stalleddl",
]);

const DOWNLOADED_STATES = new Set([
  "complete",
  "downloaded",
  "forcedup",
  "queuedseed",
  "queuedup",
  "seeding",
  "stalledup",
  "uploading",
]);

const PAUSED_STATES = new Set([
  "error",
  "missingfiles",
  "paused",
  "pauseddl",
  "pausedup",
  "stopped",
  "stoppeddl",
  "stoppedup",
]);

export function isDownloading(state: string): boolean {
  return DOWNLOADING_STATES.has(state.trim().toLowerCase());
}

export function isDownloaded(state: string): boolean {
  return DOWNLOADED_STATES.has(state.trim().toLowerCase());
}

export function isPaused(state: string): boolean {
  return PAUSED_STATES.has(state.trim().toLowerCase());
}

export function canStreamTransfer(
  transfer: Pick<TransferRow, "playable" | "progress" | "state">,
): boolean {
  if (transfer.playable === false) return false;
  const state = transfer.state.trim().toLowerCase();
  if (state === "error" || state === "missingfiles") return false;
  if (isDownloaded(state)) return true;
  return Math.floor(Math.min(1, Math.max(0, transfer.progress)) * 100) > 0;
}

// ---------------------------------------------------------------------------
// Combining
// ---------------------------------------------------------------------------

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function usableSize(bytes: number): number {
  return Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
}

/**
 * How far along a set of transfers is, as a fraction of their *bytes*.
 *
 * The naive version — the mean of the percentages — is wrong in the direction
 * that matters. A season of ten 100 MB episodes at 100% next to one 4 GB
 * remux at 0% is 1 GB of 5 GB, so 19%; averaging the percentages reports 91%
 * and the row says "nearly there" about a download that has four fifths left
 * to fetch.
 *
 * Zero total size returns 0 rather than falling back to an average. A torrent
 * reports `sizeBytes: 0` while it is still fetching its metadata, and at that
 * point nothing has been downloaded — an average over rows we know nothing
 * about would reintroduce the exact error above in the one case where we have
 * no evidence at all.
 */
export function combinedProgress(
  members: readonly Pick<TransferRow, "progress" | "sizeBytes">[],
): number {
  let total = 0;
  let done = 0;
  for (const member of members) {
    const size = usableSize(member.sizeBytes);
    total += size;
    done += size * clamp01(member.progress);
  }
  if (total <= 0) return 0;
  return clamp01(done / total);
}

/**
 * The one state string that speaks for a set of transfers.
 *
 * Picked by *least finished*, not by majority or by first: a group with nine
 * downloaded episodes and one still downloading is a group you cannot watch
 * through, and badging it "Ready" claims completion that no member has. The
 * page renders whatever comes back through its own `stateLabel`, so this
 * returns a real member's raw state rather than inventing a vocabulary.
 *
 * Paused outranks downloaded for the same reason: unfinished-and-stopped is the
 * honest description of a group holding one paused episode, and it is the
 * state the user has to act on.
 */
export function combinedState(
  members: readonly Pick<TransferRow, "state">[],
): string {
  let best: string | null = null;
  let bestRank = -1;
  for (const member of members) {
    const state = member.state ?? "";
    const rank = isDownloading(state)
      ? 3
      : isPaused(state)
        ? 2
        : isDownloaded(state)
          ? 1
          : 0;
    if (rank > bestRank) {
      bestRank = rank;
      best = state;
    }
  }
  return best ?? "";
}

// ---------------------------------------------------------------------------
// The grouped shape
// ---------------------------------------------------------------------------

/** Aggregate figures shared by a group and by each of its seasons. */
export interface CombinedTotals {
  /** Size-weighted, 0–1, over the members that are not double-counted. */
  progress: number;
  /** Bytes, over the members that are not double-counted. */
  sizeBytes: number;
  /**
   * Live transfer rates, summed over **every** member including the
   * double-counted ones. A subsumed episode is still moving real bytes through
   * the network card, and hiding them would make the group's speed disagree
   * with the totals in the stat strip above it.
   */
  dlspeed: number;
  upspeed: number;
  /** A member's own raw state; see `combinedState`. */
  state: string;
}

export interface GroupEntry<T> {
  torrent: T;
  /** Null when the release names no single season (see `seasonFolderSegment`). */
  season: number | null;
  episode: number | null;
  isSeasonPack: boolean;
  /** `S02E05`, `S01 pack`, … straight from `parseEpisode`. */
  episodeLabel: string | null;
  /**
   * A season pack in the same season already accounts for these bytes, so they
   * are left out of the totals. The row is still listed: it is a real torrent
   * the user can pause or delete, and hiding it would make the count of things
   * on disk wrong in the other direction.
   */
  subsumed: boolean;
}

export interface SeasonBucket<T> extends CombinedTotals {
  /** Null for multi-season packs and for releases that state no season. */
  season: number | null;
  /** Stable across polls; safe as a React key and an expand/collapse handle. */
  key: string;
  /** `Season 09`, or `Other` for the null bucket. */
  label: string;
  entries: GroupEntry<T>[];
}

export interface SeriesGroup<T> extends CombinedTotals {
  kind: "series";
  key: string;
  title: string;
  seasons: SeasonBucket<T>[];
  /** Every member, in the order the expanded view lists them. */
  torrents: T[];
  releaseCount: number;
  seasonCount: number;
}

export interface SingleGroup<T> {
  kind: "single";
  key: string;
  /**
   * Used for ordering, and only for ordering. The row keeps rendering the
   * display title the page already derives for it, so nothing about how a film
   * looks changes just because it now passes through here.
   */
  title: string;
  torrent: T;
}

export type DownloadGroup<T> = SeriesGroup<T> | SingleGroup<T>;

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

/** `Season 09` for a single known season, `Other` for everything else. */
const OTHER_SEASON_LABEL = "Other";

function totalsFor<T extends TransferRow>(
  entries: readonly GroupEntry<T>[],
): CombinedTotals {
  const counted = entries.filter((entry) => !entry.subsumed);
  const all = entries.map((entry) => entry.torrent);
  return {
    progress: combinedProgress(counted.map((entry) => entry.torrent)),
    sizeBytes: counted.reduce(
      (sum, entry) => sum + usableSize(entry.torrent.sizeBytes),
      0,
    ),
    dlspeed: all.reduce((sum, t) => sum + (Number(t.dlspeed) || 0), 0),
    upspeed: all.reduce((sum, t) => sum + (Number(t.upspeed) || 0), 0),
    state: combinedState(all),
  };
}

/**
 * Mark the loose episodes of a season that its season pack already contains.
 *
 * A pack and the individual episodes inside it are the same content twice, so
 * counting both puts the episodes' bytes in the denominator a second time and
 * the group reads as less complete than it is. The pack wins because it is the
 * superset by definition.
 *
 * Two deliberate limits:
 *
 *  - **The pack must actually be big enough.** Subsuming is only credible when
 *    the pack is at least as large as what it claims to contain; a pack that is
 *    smaller either is not really a pack of these episodes, or is still
 *    fetching metadata and reporting `sizeBytes: 0`. In both cases dropping
 *    real bytes from the total would be the worse error, so nothing is
 *    subsumed and the group merely over-counts.
 *  - **Multi-season packs subsume nothing.** `S01-S10` overlaps ten seasons,
 *    and deciding how much of each it covers would need per-season sizes that
 *    no client reports. Guessing there would be inventing physics, so it is
 *    left alone and counted whole — an over-count we can name, rather than an
 *    under-count we cannot.
 */
function applySeasonPackSubsumption<T extends TransferRow>(
  entries: GroupEntry<T>[],
): void {
  const bySeason = new Map<number, GroupEntry<T>[]>();
  for (const entry of entries) {
    if (entry.season == null) continue;
    const bucket = bySeason.get(entry.season);
    if (bucket) bucket.push(entry);
    else bySeason.set(entry.season, [entry]);
  }

  for (const bucket of bySeason.values()) {
    const packs = bucket.filter((entry) => entry.isSeasonPack);
    if (!packs.length) continue;

    // Largest pack wins; hash breaks a tie so two identically sized packs
    // cannot swap authority between polls and flip the totals back and forth.
    const authoritative = [...packs].sort(
      (a, b) =>
        usableSize(b.torrent.sizeBytes) - usableSize(a.torrent.sizeBytes) ||
        (a.torrent.transferId ?? a.torrent.hash).localeCompare(
          b.torrent.transferId ?? b.torrent.hash,
        ),
    )[0];

    const covered = bucket.filter((entry) => entry !== authoritative);
    const coveredBytes = covered.reduce(
      (sum, entry) => sum + usableSize(entry.torrent.sizeBytes),
      0,
    );
    if (usableSize(authoritative.torrent.sizeBytes) < coveredBytes) continue;
    for (const entry of covered) entry.subsumed = true;
  }
}

function compareEntries<T extends TransferRow>(
  a: GroupEntry<T>,
  b: GroupEntry<T>,
): number {
  // A pack covers the whole season, so it heads the season it belongs to.
  if (a.isSeasonPack !== b.isSeasonPack) return a.isSeasonPack ? -1 : 1;
  const ae = a.episode ?? Number.MAX_SAFE_INTEGER;
  const be = b.episode ?? Number.MAX_SAFE_INTEGER;
  if (ae !== be) return ae - be;
  return (
    a.torrent.name.localeCompare(b.torrent.name, undefined, { numeric: true }) ||
    (a.torrent.transferId ?? a.torrent.hash).localeCompare(
      b.torrent.transferId ?? b.torrent.hash,
    )
  );
}

/**
 * One row per work: a group for every series, and the film rows untouched.
 *
 * The returned order is a total order over identity — display title, then the
 * group's own key — and is therefore identical for the same set of torrents
 * however the client happened to hand them over and whatever they are doing.
 * That is the property the five-second poll needs; sorting on progress or
 * speed would move a row the instant it moved.
 */
export function groupDownloads<T extends TransferRow>(
  rows: readonly T[],
): DownloadGroup<T>[] {
  const singles: SingleGroup<T>[] = [];
  const seriesRows: Array<{
    workId: string | null;
    key: string;
    title: string;
    aliases: Set<string>;
    rows: T[];
  }> = [];

  for (const row of rows) {
    const identity = workIdentityFor(row.name ?? "");
    const title = row.workTitle?.trim() || identity.name || row.name || "";
    const key = row.workKey?.trim() || identity.key;
    const workId = row.workId?.trim() || null;
    const aliases = new Set([
      `key:${key}`,
      `release:${identity.key}`,
      ...(row.workTitle?.trim()
        ? [`title:${workIdentityFor(row.workTitle).key}`]
        : []),
    ]);
    if (!isSeriesDownload(row)) {
      // Films stay individual, and each keeps its own row even when two prints
      // of the same film are present: they are separate torrents taking
      // separate disk, and merging them would hide one behind the other's
      // pause and delete controls.
      singles.push({
        kind: "single",
        key: `single:${row.transferId ?? row.hash}`,
        title,
        torrent: row,
      });
      continue;
    }
    const overlaps = (bucket: (typeof seriesRows)[number]) =>
      [...aliases].some((alias) => bucket.aliases.has(alias));
    let matches = seriesRows.filter((bucket) => {
      if (workId && bucket.workId) return workId === bucket.workId;
      return overlaps(bucket);
    });
    if (!workId) {
      const linkedIds = new Set(
        matches
          .map((bucket) => bucket.workId)
          .filter((id): id is string => id != null),
      );
      if (linkedIds.size > 1) {
        matches = matches.filter((bucket) => bucket.workId == null);
      }
    }

    let bucket = matches.find((candidate) => candidate.workId === workId)
      ?? matches.find((candidate) => candidate.workId != null)
      ?? matches[0];
    if (!bucket) {
      bucket = { workId, key, title, aliases, rows: [] };
      seriesRows.push(bucket);
    } else {
      for (const match of matches) {
        if (match === bucket) continue;
        match.rows.forEach((member) => bucket.rows.push(member));
        match.aliases.forEach((alias) => bucket.aliases.add(alias));
        seriesRows.splice(seriesRows.indexOf(match), 1);
      }
      aliases.forEach((alias) => bucket.aliases.add(alias));
      if (workId && !bucket.workId) bucket.workId = workId;
      if (workId && row.workKey?.trim()) bucket.key = row.workKey.trim();
      if (workId && row.workTitle?.trim()) bucket.title = row.workTitle.trim();
    }
    bucket.rows.push(row);
  }

  const groups: DownloadGroup<T>[] = [...singles];

  for (const bucket of seriesRows) {
    const key = bucket.key;
    const labelled = bucket.rows.map((torrent) => {
      const parsed = parseEpisode(torrent.name ?? "");
      const explicitSeason = torrent.season ?? null;
      const episode = torrent.episode ?? parsed.episode ?? null;
      // `seasonFolderSegment` answers "does this name state one single
      // season?" — null for a multi-season pack and for a name with no season
      // at all — which is exactly the bucket question, and reusing it means the
      // heading on screen reads the same as the folder on disk.
      const folder = explicitSeason != null
        ? `Season ${String(explicitSeason).padStart(2, "0")}`
        : seasonFolderSegment(parsed);
      const season = explicitSeason ?? (folder ? parsed.season ?? null : null);
      const entry: GroupEntry<T> = {
        torrent,
        season: folder ? season : null,
        episode,
        isSeasonPack: parsed.isSeasonPack === true,
        episodeLabel:
          season != null && episode != null
            ? formatEpisodeLabel(season, episode)
            : parsed.label,
        subsumed: false,
      };
      return { entry, label: folder ?? OTHER_SEASON_LABEL };
    });
    const entries = labelled.map((row) => row.entry);

    applySeasonPackSubsumption(entries);

    const buckets = new Map<string, GroupEntry<T>[]>();
    for (const { entry, label } of labelled) {
      const existing = buckets.get(label);
      if (existing) existing.push(entry);
      else buckets.set(label, [entry]);
    }

    const seasons: SeasonBucket<T>[] = [...buckets.entries()]
      .map(([label, bucketEntries]) => {
        const sorted = [...bucketEntries].sort(compareEntries);
        return {
          season: sorted[0].season,
          key: `${key}::${label}`,
          label,
          entries: sorted,
          ...totalsFor(sorted),
        };
      })
      // Numbered seasons ascending; the "Other" bucket last, because a
      // multi-season pack or an unnumbered batch is not a place in the run and
      // sorting it in among the numbers would imply it was one.
      .sort((a, b) => {
        if (a.season == null) return b.season == null ? 0 : 1;
        if (b.season == null) return -1;
        return a.season - b.season;
      });

    const ordered = seasons.flatMap((season) =>
      season.entries.map((entry) => entry.torrent),
    );

    groups.push({
      kind: "series",
      key,
      title: bucket.title,
      seasons,
      torrents: ordered,
      releaseCount: entries.length,
      seasonCount: seasons.length,
      ...totalsFor(entries),
    });
  }

  return groups.sort(
    (a, b) =>
      a.title.localeCompare(b.title, undefined, { numeric: true }) ||
      a.key.localeCompare(b.key),
  );
}
