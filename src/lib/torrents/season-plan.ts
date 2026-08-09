/**
 * Season acquisition planner — pure.
 *
 * A season download is a batch of exact episode downloads. Packs are still
 * parsed by legacy/local-file code, but this planner never selects one.
 *
 * This module is the strategy, expressed as a **pure function** so the whole
 * matrix — exact matching, deterministic ranking, no double-grab and honest
 * missing coverage — is testable without ever touching a swarm.
 * Execution (actually adding torrents) is a thin layer over the returned plan.
 *
 * Invariants carried verbatim from the ranker (`prerank.ts`) and the quality
 * rule (`quality.ts`, docs/handover.md §3):
 *
 *   - **`unknown` is not `dead`.** An unmeasured exact episode stays eligible.
 *   - **Demote, never filter.** A `dead`/`weak` release is pushed to the back,
 *     never removed. A release that is the *only* way to get an episode is
 *     still offered — the alternative is telling the user that episode is
 *     unavailable when a release for it demonstrably exists.
 *   - **Report coverage honestly.** "8 of 10 episodes" is a real, useful
 *     answer. Silently downloading a partial season and calling it done is the
 *     quiet dishonesty this codebase refuses everywhere else.
 */
import { parseEpisode } from "./episodes";
import { isSupportedVideoFileName } from "./filters";
import {
  isEpisodeRangeRelease,
  seasonCoverage,
} from "./pack-preference";
import { infoHashFromMagnet, normalizeInfoHash } from "./infohash";
import { scoreRelease } from "./quality";
import type { TorrentResult } from "./types";
import type { SwarmVerdict } from "./swarm-probe";

function releaseInfoHash(r: TorrentResult): string | null {
  if (r.infoHash) {
    const direct = normalizeInfoHash(r.infoHash);
    if (direct) return direct;
  }
  return infoHashFromMagnet(r.magnet ?? null);
}

/**
 * A release is usable at all only with a magnet and at least one advertised
 * seeder — the same gate `selectBestRelease` and the on-demand grab apply. A
 * zero-seeder magnet is not a candidate; that is not a verdict, it is the
 * absence of anything to probe.
 */
function isUsable(r: TorrentResult): boolean {
  return Boolean(r.magnet) && (r.seeders ?? 0) > 0 && releaseInfoHash(r) !== null;
}

/**
 * Episode numbers a season pack actually contains, read from its torrent file
 * list. This is the authoritative reconciliation input: the file list beats the
 * name every time, so once a pack's metadata resolves we count the real files
 * for the wanted season rather than trusting the release title.
 *
 * A file counts only when it parses to the wanted season (or carries no season
 * marker at all, which for a single-season pack is the common `E05.mkv` case)
 * and to an episode number. Sample/extra files that parse to nothing are
 * ignored, so a pack padded with `sample.mkv` is not credited a phantom
 * episode. Returns sorted, de-duplicated episode numbers.
 */
export function episodesFromFilenames(
  filenames: readonly string[],
  season: number,
): number[] {
  const found = new Set<number>();
  for (const raw of filenames) {
    if (!isSupportedVideoFileName(raw)) continue;
    const name = raw.split(/[\\/]/).pop() ?? raw;
    const ep = parseEpisode(name);
    if (ep.isSeasonPack || ep.episode == null) continue;
    // A per-episode file inside a single-season pack often omits the season
    // ("E05.mkv"); accept it as this season. When it names a season, it must
    // match.
    if (ep.season != null && ep.season !== season) continue;
    found.add(ep.episode);
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * Episode range advertised *inside* a pack title, e.g. `S01E01-E08`,
 * `S01 E01-08`, `Episodes 1-8`. This is the coverage-bookkeeping core and the
 * place bugs will live.
 *
 * Why it lives here and not in `parseEpisode`: `parseEpisode("S01E01-E08")`
 * matches its `SxxEyy` branch first and returns a *single* episode E01, hiding
 * the range entirely. So a partial pack must be recognised before trusting the
 * single-episode parse, or a hybrid (pack for E01-E08 + singles for E09-E10)
 * collapses into "one episode plus everything missing".
 *
 * Deliberately conservative: it requires an explicit `E`/`Ep`/`Episodes`
 * marker and a dash to a second number. A bare `01-08` is *not* treated as a
 * range — in scene names that is far more often a date, a group id or a codec
 * token than an episode span, and a wrong range would over-claim coverage and
 * silently drop the gap-filling singles.
 */
export function packEpisodeRange(title: string): { from: number; to: number } | null {
  const candidates: RegExpMatchArray[] = [];
  // No leading \b: in "S01E01-E08" the char before the first E is the season's
  // digit, so there is no word boundary there and \bE would never match.
  const eForm = title.match(/E(\d{1,4})\s*[-–—]\s*E?(\d{1,4})\b/i);
  if (eForm) candidates.push(eForm);
  const wordForm = title.match(/\bEpisodes?\s*(\d{1,4})\s*[-–—]\s*(\d{1,4})\b/i);
  if (wordForm) candidates.push(wordForm);

  for (const m of candidates) {
    const from = parseInt(m[1], 10);
    const to = parseInt(m[2], 10);
    if (
      Number.isFinite(from) &&
      Number.isFinite(to) &&
      from >= 1 &&
      to > from &&
      to - from < 200
    ) {
      return { from, to };
    }
  }
  return null;
}

export type PackFit = "single-season" | "range" | "multi-season" | "complete";

/**
 * How much to trust a pack's `covers` set. This is the spine of the honesty
 * fix: a season pack's contents are *inferred from its name* until the torrent
 * metadata resolves, and a release name is the least trustworthy field we have
 * — the same untrusted string `parseEpisode` already defends against. Telling
 * the user "9 of 9 episodes" off a bare `Severance S01` that we never opened is
 * the advertised-vs-delivered lie this whole subsystem exists to resist, one
 * level up: there the advertised number was seeders, here it is an episode
 * count. `unknown` is not `dead`, and it is also not `confirmed`.
 *
 *   - `confirmed` — reconciled against the torrent's actual file list. The file
 *     list is authoritative and beats the name every time.
 * Names are never eligibility evidence. `asserted` and `inferred` remain in the
 * public type for response compatibility, but the planner only emits
 * `confirmed`.
 */
export type CoverageBasis = "confirmed" | "asserted" | "inferred";

export interface SeasonRelease {
  release: TorrentResult;
  verdict: SwarmVerdict;
}

export interface PackChoice extends SeasonRelease {
  /** Wanted episodes this pack covers. */
  covers: number[];
  fit: PackFit;
  /** Whether {@link covers} is confirmed, name-asserted, or merely inferred. */
  coverageBasis: CoverageBasis;
}

export interface SingleChoice extends SeasonRelease {
  episode: number;
}

export interface SeasonPlan {
  season: number;
  /** Sorted, de-duplicated wanted episode numbers (the input contract). */
  wanted: number[];
  /** The chosen season pack, if any. */
  pack: PackChoice | null;
  /** Per-episode singles chosen to fill everything the pack does not cover. */
  singles: SingleChoice[];
  /** Wanted episodes we have a release for (pack ∪ singles). Sorted. */
  covered: number[];
  /** Wanted episodes with no release at all. Sorted. */
  missing: number[];
  /** Human-facing coverage summary, e.g. "8 of 10 episodes". */
  coverageLabel: string;
  /**
   * True only when the coverage report can be trusted as fact: no episode in it
   * rests on an `inferred` pack. A name-asserted range and a file-confirmed
   * pack both count as trustworthy; a bare-`S01` pack we never opened does not.
   * `wt-title` owns the wording ("covers" vs "should cover"); this is the fact
   * it words.
   */
  coverageConfirmed: boolean;
  /** Why this plan looks the way it does — for the UI and for debugging. */
  reason: string;
}

interface ClassifiedPack {
  release: TorrentResult;
  index: number;
  verdict: SwarmVerdict;
  covers: number[];
  fit: PackFit;
  coverageBasis: CoverageBasis;
}

interface ClassifiedSingle {
  release: TorrentResult;
  index: number;
  verdict: SwarmVerdict;
  episode: number;
}

/**
 * Classify a usable release against the wanted season into a pack (with the
 * wanted episodes it covers) or a single episode. Returns `null` for anything
 * that is neither — a different season, an unparseable title.
 *
 * `packContents` is the reconciliation seam: given a pack it returns the
 * episode numbers actually present in the torrent's file list, or `null` when
 * that is not (yet) known. When it resolves, the file list is authoritative and
 * the coverage is `confirmed`; when it does not, a bare season pack's coverage
 * is `inferred`, never reported as fact.
 */
function classify(
  release: TorrentResult,
  index: number,
  season: number,
  wantedSet: Set<number>,
  verdict: SwarmVerdict,
  packContents: (r: TorrentResult) => number[] | null,
): ClassifiedPack | ClassifiedSingle | null {
  const wanted = [...wantedSet];
  if (isEpisodeRangeRelease(release.title)) return null;

  const ep = release.episode ?? parseEpisode(release.title);

  // ── Whole-season / multi-season / complete pack ───────────────────────────
  const coverage = seasonCoverage(release.title, ep);
  if (coverage) {
    const coversThisSeason =
      coverage.kind === "unknown-complete" ||
      (coverage.from <= season && season <= coverage.to);
    if (coversThisSeason) {
      const fit: PackFit =
        coverage.kind === "unknown-complete"
          ? "complete"
          : coverage.kind === "multi"
            ? "multi-season"
            : "single-season";
      const files = packContents(release);
      if (files) {
        // The file list resolved: trust it, and take the pack only when it
        // actually holds every wanted episode. A confirmed-partial pack is
        // dropped so the singles fallback fills the season instead.
        if (wanted.every((episode) => files.includes(episode))) {
          return {
            release,
            index,
            verdict,
            covers: wanted.slice(),
            fit,
            coverageBasis: "confirmed",
          };
        }
        return null;
      }
      // Not openable yet — the common first-grab case, since a pack's files are
      // only readable once the torrent is live. Dropping it here is what made
      // whole seasons un-grabbable: the season search returns only packs, none
      // are live, so every one was discarded and nothing downloaded. Take it on
      // its name instead, marked `inferred` so the report says "should cover …
      // (unconfirmed)" rather than claiming it as fact. A bare season name
      // infers the whole season; a name that enumerates an explicit episode
      // range credits only that range, so the singles fallback fills the gap
      // rather than the pack over-claiming episodes it never named.
      const named = packEpisodeRange(release.title);
      const inferredCovers = named
        ? wanted.filter((episode) => episode >= named.from && episode <= named.to)
        : wanted.slice();
      if (inferredCovers.length === 0) return null;
      return {
        release,
        index,
        verdict,
        covers: inferredCovers,
        fit,
        coverageBasis: "inferred",
      };
    }
    // A pack that exists but does not cover this season is not ours.
    return null;
  }

  // ── Single episode ────────────────────────────────────────────────────────
  if (ep.season === season && ep.episode != null && wantedSet.has(ep.episode)) {
    return { release, index, verdict, episode: ep.episode };
  }

  return null;
}

function isPack(
  c: ClassifiedPack | ClassifiedSingle,
): c is ClassifiedPack {
  return "covers" in c;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Plan the acquisition of a season.
 *
 * @param wanted     Authoritative wanted-episode numbers. The caller (which
 *                   knows the season's episode count from metadata) supplies
 *                   this; the planner never invents episodes it cannot see, so
 *                   "8 of 10" is only honest if the caller says the season has
 *                   10 episodes.
 * @param releases   Candidate releases, already ordered best-first by the
 *                   ranker (`rankResults`). Input order is the tiebreak.
 * @param verdictOf  Pure verdict lookup; unmeasured releases read `unknown`.
 * @param preferredResolution The vertical pixels the user explicitly asked for,
 *                   or null for no preference. Honoured as a hard preference
 *                   tier in selection (demote, never filter) so an explicit
 *                   "1080p" is not silently served a 4K release that merely
 *                   sorted higher.
 * @param packContents Retained for pack parsing callers; acquisition ignores
 *                   every classified pack.
 */
export function planSeason(input: {
  season: number;
  wanted: readonly number[];
  releases: readonly TorrentResult[];
  verdictOf: (r: TorrentResult) => SwarmVerdict;
  preferredResolution?: number | null;
  packContents?: (r: TorrentResult) => number[] | null;
  /**
   * Retained for caller compatibility. Exact episode planning does not use it.
   */
  seasonComplete?: boolean;
}): SeasonPlan {
  const season = input.season;
  const preferred =
    input.preferredResolution != null &&
    Number.isFinite(input.preferredResolution) &&
    input.preferredResolution >= 1
      ? Math.trunc(input.preferredResolution)
      : null;
  const wanted = [...new Set(input.wanted.map((e) => Math.trunc(e)))]
    .filter((e) => e >= 1)
    .sort((a, b) => a - b);
  const wantedSet = new Set(wanted);

  const emptyPlan = (reason: string): SeasonPlan => ({
    season,
    wanted,
    pack: null,
    singles: [],
    covered: [],
    missing: wanted.slice(),
    coverageLabel: `0 of ${wanted.length} episodes`,
    coverageConfirmed: true,
    reason,
  });

  if (wanted.length === 0) {
    return { ...emptyPlan("No episodes requested"), missing: [] };
  }

  const singles: ClassifiedSingle[] = [];
  input.releases.forEach((release, index) => {
    if (!isUsable(release)) return;
    const c = classify(
      release,
      index,
      season,
      wantedSet,
      input.verdictOf(release),
      input.packContents ?? (() => null),
    );
    if (!c) return;
    if (!isPack(c)) singles.push(c);
  });

  if (singles.length === 0) {
    return emptyPlan("No usable releases found for this season");
  }

  // Per-episode releases are the only acquisition unit. They give every card a
  // real torrent identity and progress value instead of projecting one pack's
  // aggregate state across a whole season.
  //
  // Best single per episode: viable before demoted, then the resolution the
  // user explicitly asked for, then verdict tier, then ranker order.
  // Demote-never-filter — a weak or wrong-resolution single is still taken when
  // it is the only release for that episode.
  const covered = new Set<number>();
  const singleByEpisode = new Map<number, ClassifiedSingle>();
  const bestSingleFor = (episode: number): ClassifiedSingle | null =>
    singles
      .filter((s) => s.episode === episode)
      .sort(
        (a, b) =>
          // scoreRelease produces the shared quality/verdict ordering.
          scoreRelease(b.verdict, b.release.title, preferred) -
            scoreRelease(a.verdict, a.release.title, preferred) ||
          a.index - b.index,
      )[0] ?? null;

  for (const episode of wanted) {
    const s = bestSingleFor(episode);
    if (s) {
      singleByEpisode.set(episode, s);
      covered.add(episode);
    }
  }

  const chosenSingles: ClassifiedSingle[] = [...singleByEpisode.values()];

  const coveredList = [...covered].filter((e) => wantedSet.has(e)).sort((a, b) => a - b);
  const missing = wanted.filter((e) => !covered.has(e));

  const singleChoices: SingleChoice[] = chosenSingles
    .sort((a, b) => a.episode - b.episode)
    .map((s) => ({ release: s.release, verdict: s.verdict, episode: s.episode }));

  return {
    season,
    wanted,
    pack: null,
    singles: singleChoices,
    covered: coveredList,
    missing,
    coverageLabel: `${coveredList.length} of ${wanted.length} episodes`,
    coverageConfirmed: true,
    reason: buildReason(singleChoices, missing, season),
  };
}

function buildReason(
  singles: SingleChoice[],
  missing: number[],
  season: number,
): string {
  const parts: string[] = [];
  if (singles.length > 0) {
    parts.push(`Assembling ${singles.length} episode(s) from individual releases`);
  } else {
    parts.push(`No releases available for season ${season}`);
  }
  if (missing.length > 0) {
    parts.push(`missing E${missing.map(pad).join(", E")}`);
  }
  return parts.join("; ");
}
