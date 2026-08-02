/**
 * What "delete this" is allowed to mean, before anything touches a disk.
 *
 * ## Why a decision layer exists at all
 *
 * Every other destructive path in this app is *speculative* — the retention
 * sweep reclaims a cache it believes nobody wants, and it is hedged accordingly
 * (`retention-sweep.ts` refuses on `unknown` at six separate points). This one
 * is different: the user asked for it, so it will happen. That makes the only
 * interesting question **how much** happens, and the answer has to be computed
 * and shown *before* the confirm, not discovered afterwards.
 *
 * ## The rule the whole module is built on
 *
 * A release is deletable by a scope only when **everything it covers is inside
 * that scope**. Not "overlaps", not "is the best match" — contained.
 *
 * The case that forces it: a season pack holding S01E01–E10 overlaps a request
 * to delete S01E03 perfectly well, and a matcher that deleted on overlap would
 * destroy nine episodes the user never mentioned, with no error and no way
 * back. There is no partial delete available — the engine removes a torrent and
 * its files as one unit — so "delete episode 3 out of a pack" is not a thing
 * that can be done carefully. It is a thing that must be **refused and
 * explained**, which is why {@link DeletionPlan.blocked} exists and is not an
 * error list: it is the part of the answer the user has to see.
 *
 * ## `unknown` is not permission
 *
 * Same discipline as `local-file-presence.ts` and `browse/availability.ts`: a
 * release whose name states no season and no episode has not been shown to be
 * outside the requested season, so it cannot be swept up by it. It stays behind
 * and is reported. Only `show` — which by definition contains everything held
 * for the work — can remove it.
 *
 * ## Pure
 *
 * No `node:fs`, no prisma, no clock. The caller supplies what it holds and the
 * presence verdict it measured; this decides. That is what lets the Library
 * card render the same file count and size the API will act on, from one
 * function, instead of two implementations that drift.
 */
import { parseEpisode } from "@/lib/torrents/episodes";
import { formatBytesShort } from "./storage-format";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export type DeletionScopeKind = "show" | "season" | "episode";

export type DeletionScope =
  /** Everything held for the work. */
  | { kind: "show" }
  /** One season, and nothing that reaches outside it. */
  | { kind: "season"; season: number }
  /** One episode, and nothing that reaches outside it. */
  | { kind: "episode"; season: number; episode: number };

/**
 * What a release name or a file name says it holds.
 *
 * `seasons` is deliberately open-ended (`from`, no `to`). A multi-season or
 * "Complete" pack rarely states where it stops, and inventing an end would let
 * a season-scoped delete "prove" containment against a boundary nobody wrote
 * down. An unstated end can never be contained by a single season, which is the
 * safe reading and also the true one.
 */
export type Coverage =
  | { kind: "episode"; season: number | null; episode: number }
  | { kind: "season"; season: number }
  | { kind: "seasons"; from: number }
  /** The name says nothing about episode structure (a film, `video.mkv`). */
  | { kind: "unknown" };

/** What the caller measured about the file on disk. @see local-file-presence.ts */
export type HeldFilePresence = "present" | "absent" | "unknown";

export interface HeldFile {
  /** Absolute path, as the engine recorded it. */
  path: string;
  sizeBytes: number;
  /** Defaults to whatever the file's own name states. */
  coverage?: Coverage;
  /** Defaults to `unknown`, which counts — only proven absence does not. */
  presence?: HeldFilePresence;
}

export interface HeldTorrent {
  hash: string;
  /** The release name. This is what states the release's own coverage. */
  name: string;
  /** Defaults to whatever {@link coverageFromName} reads from `name`. */
  coverage?: Coverage;
  /**
   * Bytes the engine has committed to this release.
   *
   * Used only when no individual files were recorded. A torrent at 1% has
   * already had its whole length allocated on disk (see `onDiskBytes` in
   * `retention-sweep.ts`, written after the live install under-reported a
   * 41.6 GB cache as 27.6 GB), so reporting 0 bytes for it would tell the user
   * that removing it frees nothing.
   */
  allocatedBytes: number;
  files: HeldFile[];
}

export interface PlannedRelease {
  hash: string;
  name: string;
  /** Recorded files that will actually be removed. May be 0. */
  fileCount: number;
  /** Bytes this release accounts for, never counting a file proven missing. */
  bytes: number;
  /** False when the engine never recorded a file list for this release. */
  filesRecorded: boolean;
}

/**
 * Why a scope cannot address something it nonetheless overlaps.
 *
 * - `covers-more` — the release reaches outside the request. Deleting it would
 *   take material the user did not name.
 * - `unrecognised` — nothing in the name places it inside or outside the
 *   request, and a guess here deletes the wrong episode.
 */
export type BlockedReason = "covers-more" | "unrecognised";

export interface BlockedRelease {
  hash: string;
  name: string;
  reason: BlockedReason;
  /** What it does cover, spelled out for a person: `Season 1`, `S02E06`. */
  covers: string;
  fileCount: number;
  bytes: number;
}

/**
 * Three outcomes, and the difference between the last two is the point.
 *
 * - `deletes` — at least one release will go.
 * - `blocked` — we hold material the request touches and are refusing to remove
 *   any of it. The user must be told, and offered a wider scope.
 * - `nothing-held` — there is genuinely nothing here. A different sentence, and
 *   a different control state: nothing to confirm, nothing to warn about.
 *
 * Collapsing `blocked` into `nothing-held` is the failure this names: the user
 * asks to delete episode 3, is told "nothing to delete", and their 24 GB season
 * pack sits there forever with no explanation and no way to remove it.
 */
export type DeletionPlanOutcome = "deletes" | "blocked" | "nothing-held";

export interface DeletionPlan {
  scope: DeletionScope;
  outcome: DeletionPlanOutcome;
  /** Releases whose entire contents are inside the scope. Engine rows to remove. */
  releases: PlannedRelease[];
  /** Absolute paths that will actually be removed. */
  files: string[];
  /** `files.length`, restated so a caller cannot report a different number. */
  fileCount: number;
  /** Bytes {@link releases} account for. Never includes a file proven missing. */
  totalBytes: number;
  /** Recorded paths the caller proved are already gone. Excluded from the totals. */
  missingFiles: string[];
  /** Held material this scope may not remove, with the reason. */
  blocked: BlockedRelease[];
}

// ---------------------------------------------------------------------------
// Reading coverage off a name
// ---------------------------------------------------------------------------

/**
 * What a release or file name claims to hold.
 *
 * Goes through `parseEpisode`, the same parser search, ranking and the season
 * hunt use, rather than growing a second set of season regexes — a delete that
 * disagreed with the grabber about what `Top.Gear.Series.22` means would remove
 * a season the library thinks it still has.
 *
 * A batch with no stated season (`Show.Complete.1080p`) becomes `seasons` from
 * 1, not `unknown`: "Complete" is a positive claim to hold more than one thing,
 * and treating it as unknown would let a *show*-scoped plan look narrower than
 * it is.
 */
export function coverageFromName(name: string): Coverage {
  const raw = (name ?? "").trim();
  if (!raw) return { kind: "unknown" };

  const ep = parseEpisode(raw);
  if (ep.isMultiSeason) return { kind: "seasons", from: ep.season ?? 1 };
  if (ep.isSeasonPack || ep.isBatch) {
    return ep.season != null
      ? { kind: "season", season: ep.season }
      : { kind: "seasons", from: 1 };
  }
  if (ep.episode != null) {
    return { kind: "episode", season: ep.season ?? null, episode: ep.episode };
  }
  return { kind: "unknown" };
}

/** Last path segment, for either separator. Pure so this module stays fs-free. */
export function fileNameOf(filePath: string): string {
  const parts = (filePath ?? "").split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

/**
 * Parse `EngineTorrent.verifiedFilesJson` into held files.
 *
 * The engine writes this only after every file stats to its full recorded
 * length, so a present entry is a real allocation and its `size` is the whole
 * of it — which is why the sum of these is a defensible "you will free X".
 * Anything malformed yields no files rather than a partial list: a half-read
 * file list would under-report the delete.
 */
export function heldFilesFromVerifiedJson(
  verifiedFilesJson: string | null | undefined,
): HeldFile[] {
  if (!verifiedFilesJson?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(verifiedFilesJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: HeldFile[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { path?: unknown; size?: unknown };
    if (typeof record.path !== "string") continue;
    const path = record.path.trim();
    if (!path) continue;
    const size =
      typeof record.size === "number" && Number.isFinite(record.size) && record.size > 0
        ? record.size
        : 0;
    out.push({ path, sizeBytes: size });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Containment
// ---------------------------------------------------------------------------

/**
 * Is everything this coverage names inside the scope?
 *
 * The whole safety property of the feature is this function returning `false`
 * generously. Every `false` here costs the user one extra click (delete the
 * season instead of the episode); every wrong `true` costs them files.
 */
export function coverageWithin(coverage: Coverage, scope: DeletionScope): boolean {
  // `show` means every byte held for this work, so nothing can reach outside it.
  if (scope.kind === "show") return true;

  if (scope.kind === "season") {
    if (coverage.kind === "episode") return coverage.season === scope.season;
    if (coverage.kind === "season") return coverage.season === scope.season;
    // A pack that does not state where it ends cannot be proven to end here.
    return false;
  }

  // `episode`: only a release that is exactly that episode qualifies. A season
  // pack is the case this exists for — it holds the episode *and* nine others.
  return (
    coverage.kind === "episode" &&
    coverage.season === scope.season &&
    coverage.episode === scope.episode
  );
}

/**
 * Could this coverage include anything the scope asked about?
 *
 * Used only to decide whether an undeletable release is worth *reporting*.
 * Season 1 material is not "blocked" by a season 2 request — it is simply none
 * of that request's business, and listing it would train the user to ignore the
 * list that also carries the season-pack warning.
 *
 * Erring towards `true` here is cheap (an extra line of explanation) and is the
 * right direction for anything unproven.
 */
export function coverageOverlaps(coverage: Coverage, scope: DeletionScope): boolean {
  if (scope.kind === "show") return true;
  if (coverage.kind === "unknown") return true;

  if (scope.kind === "season") {
    if (coverage.kind === "episode") {
      // A release numbered absolutely (`One Piece - 1170`) states no season, so
      // it cannot be ruled out of one.
      return coverage.season == null || coverage.season === scope.season;
    }
    if (coverage.kind === "season") return coverage.season === scope.season;
    return scope.season >= coverage.from;
  }

  if (coverage.kind === "episode") {
    if (coverage.episode !== scope.episode) return false;
    return coverage.season == null || coverage.season === scope.season;
  }
  if (coverage.kind === "season") return coverage.season === scope.season;
  return scope.season >= coverage.from;
}

/**
 * Everything a release would take with it if removed.
 *
 * The release name and its files both get a vote, because either can know
 * something the other does not: a pack named `Show.S01` does not name its ten
 * episodes, and a torrent named after a scene group may say nothing while its
 * files say `S01E01`…`S02E10`.
 *
 * `unknown` entries are dropped rather than treated as a claim. A single-episode
 * release routinely ships `sample.mkv` and `poster.jpg`, whose names state
 * nothing; counting those as unknown coverage would block every episode-scoped
 * delete in the library on the strength of a JPEG.
 */
export function statedCoverage(torrent: HeldTorrent): Coverage[] {
  const stated: Coverage[] = [];
  const own = torrent.coverage ?? coverageFromName(torrent.name);
  if (own.kind !== "unknown") stated.push(own);
  for (const file of torrent.files) {
    const cover = file.coverage ?? coverageFromName(fileNameOf(file.path));
    if (cover.kind !== "unknown") stated.push(cover);
  }
  return stated;
}

/** How a coverage reads in a sentence. */
export function coverageLabel(coverage: Coverage): string {
  if (coverage.kind === "episode") {
    const ep = `E${pad(coverage.episode)}`;
    return coverage.season == null
      ? `episode ${coverage.episode}`
      : `S${pad(coverage.season)}${ep}`;
  }
  if (coverage.kind === "season") return `Season ${coverage.season}`;
  if (coverage.kind === "seasons") return `Season ${coverage.from} and later`;
  return "not stated";
}

/** How a scope reads in a sentence. */
export function scopeLabel(scope: DeletionScope): string {
  if (scope.kind === "show") return "this title";
  if (scope.kind === "season") return `Season ${scope.season}`;
  return `S${pad(scope.season)}E${pad(scope.episode)}`;
}

/** Widest coverage first, so the message names the thing that blocked it. */
function widestLabel(stated: readonly Coverage[]): string {
  const rank = (c: Coverage) =>
    c.kind === "seasons" ? 3 : c.kind === "season" ? 2 : 1;
  const widest = [...stated].sort((a, b) => rank(b) - rank(a))[0];
  return widest ? coverageLabel(widest) : "not stated";
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/**
 * What deleting `scope` from `held` would actually do.
 *
 * Deliberately total: every held release lands in exactly one of `releases`,
 * `blocked`, or nowhere (out of scope). There is no fourth "we'll see at
 * runtime" bucket, because the number this returns is the number shown on the
 * confirm dialog, and a confirm dialog that under-states the damage is worse
 * than no dialog.
 */
export function planDeletion(
  held: readonly HeldTorrent[],
  scope: DeletionScope,
): DeletionPlan {
  const releases: PlannedRelease[] = [];
  const files: string[] = [];
  const missingFiles: string[] = [];
  const blocked: BlockedRelease[] = [];
  let totalBytes = 0;

  for (const torrent of held) {
    const stated = statedCoverage(torrent);

    // Nothing in the name or the file list places this release. `show` holds
    // everything by definition; any narrower scope has no evidence and must not
    // manufacture some.
    if (stated.length === 0 && scope.kind !== "show") {
      blocked.push(describeBlocked(torrent, "unrecognised", "not stated"));
      continue;
    }

    if (stated.every((cover) => coverageWithin(cover, scope))) {
      const present = torrent.files.filter((f) => f.presence !== "absent");
      const gone = torrent.files.filter((f) => f.presence === "absent");
      for (const file of present) files.push(file.path);
      for (const file of gone) missingFiles.push(file.path);

      // A recorded-but-absent file frees nothing, so it must not be counted.
      // The allocation fallback applies only when the engine recorded no file
      // list at all — using it here would re-add the bytes we just proved gone.
      const filesRecorded = torrent.files.length > 0;
      const bytes = filesRecorded
        ? present.reduce((sum, f) => sum + safeBytes(f.sizeBytes), 0)
        : safeBytes(torrent.allocatedBytes);

      releases.push({
        hash: torrent.hash,
        name: torrent.name,
        fileCount: present.length,
        bytes,
        filesRecorded,
      });
      totalBytes += bytes;
      continue;
    }

    if (stated.some((cover) => coverageOverlaps(cover, scope))) {
      blocked.push(
        describeBlocked(torrent, blockedReason(stated), widestLabel(stated)),
      );
    }
    // Otherwise it belongs to another season entirely and is not this request's
    // business — reporting it would dilute the list that carries the warning.
  }

  const outcome: DeletionPlanOutcome =
    releases.length > 0 ? "deletes" : blocked.length > 0 ? "blocked" : "nothing-held";

  return {
    scope,
    outcome,
    releases,
    files,
    fileCount: files.length,
    totalBytes,
    missingFiles,
    blocked,
  };
}

/**
 * Which refusal this is.
 *
 * The distinction is what the user does next. "Covers more than you asked" has
 * an answer — widen the scope. "We could not place it" does not, and telling
 * someone to delete a season to remove a file we cannot prove is in that season
 * would be advice to destroy the wrong thing. A release numbered absolutely
 * (`One Piece - 1170`, no season anywhere in the name) is the case that
 * separates them.
 */
function blockedReason(stated: readonly Coverage[]): BlockedReason {
  const provablyWider = stated.some(
    (cover) =>
      cover.kind === "season" ||
      cover.kind === "seasons" ||
      (cover.kind === "episode" && cover.season != null),
  );
  return provablyWider ? "covers-more" : "unrecognised";
}

function describeBlocked(
  torrent: HeldTorrent,
  reason: BlockedReason,
  covers: string,
): BlockedRelease {
  const present = torrent.files.filter((f) => f.presence !== "absent");
  return {
    hash: torrent.hash,
    name: torrent.name,
    reason,
    covers,
    fileCount: present.length,
    bytes: torrent.files.length
      ? present.reduce((sum, f) => sum + safeBytes(f.sizeBytes), 0)
      : safeBytes(torrent.allocatedBytes),
  };
}

// ---------------------------------------------------------------------------
// Saying it out loud
// ---------------------------------------------------------------------------

/**
 * The one line that goes above the confirm button.
 *
 * Three jobs, in this order: state the size of the damage, admit anything it
 * cannot do, and name the way forward. It must never round any of those away —
 * a file the caller proved missing is excluded from the count *and* mentioned,
 * because "10 files · 24 GB" over a folder holding nine is the kind of small
 * lie that makes a user stop believing the number entirely.
 */
export function deletionPlanSummary(plan: DeletionPlan): string {
  const subject = scopeLabel(plan.scope);

  if (plan.outcome === "nothing-held") {
    return `No files held for ${subject}. Nothing to delete.`;
  }

  if (plan.outcome === "blocked") {
    const first = plan.blocked[0];
    const head =
      first.reason === "covers-more"
        ? `Nothing can be deleted for ${subject}: ${count(plan.blocked.length, "release")} ` +
          `cover${plan.blocked.length === 1 ? "s" : ""} ${first.covers}, not just ${subject}.`
        : `Nothing can be deleted for ${subject}: ${count(plan.blocked.length, "release")} ` +
          `could not be matched to a season.`;
    return `${head} ${blockedTail(plan)}`;
  }

  const size = formatBytesShort(plan.totalBytes);
  // Files, not releases, when we know the files: "10 files · 24.0 GB" is a
  // quantity a person can weigh against their disk. "1 release" is not, and is
  // only used when the engine never wrote a file list for what it is holding.
  const head = plan.fileCount
    ? `Deletes ${count(plan.fileCount, "file")} · ${size} from ${subject}.`
    : `Deletes ${count(plan.releases.length, "release")} · ${size} from ${subject}.`;

  const parts = [head];
  const unlisted = plan.releases.filter((release) => !release.filesRecorded).length;
  if (unlisted) {
    parts.push(
      `${count(unlisted, "release")} with no recorded file list; the size shown is the full allocation.`,
    );
  }
  if (plan.missingFiles.length) {
    parts.push(
      `${count(plan.missingFiles.length, "recorded file")} already gone from disk, so not counted.`,
    );
  }
  if (plan.blocked.length) {
    parts.push(
      `${count(plan.blocked.length, "release")} left alone: ${plan.blocked[0].name} covers ${plan.blocked[0].covers}.`,
    );
  }
  return parts.join(" ");
}

/** What the user can do about a refusal, which depends on what they asked for. */
function blockedTail(plan: DeletionPlan): string {
  const held = `${count(totalBlockedFiles(plan), "file")} · ${formatBytesShort(
    plan.blocked.reduce((sum, b) => sum + b.bytes, 0),
  )} left in place.`;
  if (plan.scope.kind === "episode") {
    return `${held} A single episode cannot be removed from a pack — delete Season ${plan.scope.season} to remove it.`;
  }
  if (plan.scope.kind === "season") {
    return `${held} Delete the whole title to remove it.`;
  }
  return held;
}

function totalBlockedFiles(plan: DeletionPlan): number {
  return plan.blocked.reduce((sum, b) => sum + b.fileCount, 0);
}

// ---------------------------------------------------------------------------
// Small shared bits
// ---------------------------------------------------------------------------

/**
 * Build a scope from loose request values, or null.
 *
 * Null is a real answer and callers must treat it as a 400. A season scope with
 * a missing season number silently becoming "the whole show" is the shape of
 * accident this feature cannot afford.
 */
export function makeDeletionScope(
  kind: string | null | undefined,
  season?: number | null,
  episode?: number | null,
): DeletionScope | null {
  if (kind === "show") return { kind: "show" };
  if (kind === "season") {
    return isSeasonNumber(season) ? { kind: "season", season } : null;
  }
  if (kind === "episode") {
    return isSeasonNumber(season) && isEpisodeNumber(episode)
      ? { kind: "episode", season, episode }
      : null;
  }
  return null;
}

function isSeasonNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isEpisodeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function safeBytes(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
