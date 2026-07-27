/**
 * Season acquisition planner — pure.
 *
 * The user asked to "download a whole season, favour good packs but also be
 * able to find multiple episodes if available, automatically." Read literally:
 *
 *   - "favour good packs" is *not* "prefer packs". It is prefer packs that are
 *     actually **good** — good as in *measured to deliver*, the swarm-probe
 *     verdict, not the seeder count an indexer advertised. A pack advertising
 *     40 seeders that probed `dead` must lose to one advertising 12 that
 *     probed `good`. That is the exact failure this whole subsystem exists to
 *     fix: the app trusted a claim, picked a corpse, and stalled.
 *   - "but also be able to find multiple episodes … automatically" is the
 *     fallback: when there is no good pack, assemble the season out of
 *     individual episode releases without making the user do it by hand.
 *
 * This module is the strategy, expressed as a **pure function** so the whole
 * matrix — good pack wins, dead pack loses to good singles, partial pack plus
 * gap-filling singles, no double-grab, nothing-available reported honestly,
 * `unknown` pack still eligible — is testable without ever touching a swarm.
 * Execution (actually adding torrents) is a thin layer over the returned plan.
 *
 * Invariants carried verbatim from the ranker (`prerank.ts`) and the quality
 * rule (`quality.ts`, docs/handover.md §3):
 *
 *   - **`unknown` is not `dead`.** An unmeasured pack stays eligible. If the
 *     planner only ever took *measured* releases a cold cache would mean the
 *     feature never works, so absence of a verdict is neutral, never a reason
 *     to drop a candidate.
 *   - **Demote, never filter.** A `dead`/`weak` release is pushed to the back,
 *     never removed. A release that is the *only* way to get an episode is
 *     still offered — the alternative is telling the user that episode is
 *     unavailable when a release for it demonstrably exists.
 *   - **Report coverage honestly.** "8 of 10 episodes" is a real, useful
 *     answer. Silently downloading a partial season and calling it done is the
 *     quiet dishonesty this codebase refuses everywhere else.
 */
import { parseEpisode } from "./episodes";
import { seasonCoverage } from "./pack-preference";
import { infoHashFromMagnet, normalizeInfoHash } from "./infohash";
import type { TorrentResult } from "./types";
import type { SwarmVerdict } from "./swarm-probe";

/**
 * Verdict → tier, identical to `prerank.ts:verdictTier`. Kept as its own copy
 * rather than imported because `prerank.ts` pulls in Prisma at module load and
 * this planner must stay pure enough to run under the unit harness with no DB.
 * The ordering is the contract, not the source: good beats unknown beats weak
 * beats dead, and two judges of "which release" that could drift apart is a
 * bug generator, so the numbers must match `prerank.ts` exactly.
 */
function verdictTier(v: SwarmVerdict): number {
  switch (v) {
    case "good":
      return 0;
    case "unknown":
      return 1;
    case "weak":
      return 2;
    case "dead":
      return 3;
  }
}

/** A pack is eligible to be the *primary* choice only when it is not demoted. */
function isTakeablePackVerdict(v: SwarmVerdict): boolean {
  // good = measured pass; unknown = unmeasured, still eligible (cold cache must
  // not disable the feature). weak/dead packs are demoted out of the fast path:
  // "favour good packs" means we would rather assemble from singles than commit
  // the whole season to one swarm we have measured as failing.
  return v === "good" || v === "unknown";
}

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

/** The season number a title's `Sxx` marker names, if any. */
function titleSeason(title: string): number | null {
  const m = title.match(/\bS(?:eason)?\s*(\d{1,3})\b/i);
  return m ? parseInt(m[1], 10) : null;
}

export type PackFit = "single-season" | "range" | "multi-season" | "complete";

export interface SeasonRelease {
  release: TorrentResult;
  verdict: SwarmVerdict;
}

export interface PackChoice extends SeasonRelease {
  /** Wanted episodes this pack covers. */
  covers: number[];
  fit: PackFit;
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
  /** Why this plan looks the way it does — for the UI and for debugging. */
  reason: string;
}

interface ClassifiedPack {
  release: TorrentResult;
  index: number;
  verdict: SwarmVerdict;
  covers: number[];
  fit: PackFit;
}

interface ClassifiedSingle {
  release: TorrentResult;
  index: number;
  verdict: SwarmVerdict;
  episode: number;
}

function fitRank(fit: PackFit): number {
  // Prefer the tightest pack for the season the user asked for. A whole-series
  // "complete" pack downloaded for a single wanted season is 20x the bytes for
  // 1x the value and competes with playback for content nobody asked for, so
  // it ranks last among otherwise-equal packs. Demotion, not exclusion: if the
  // only pack is a complete one, it is still reachable.
  switch (fit) {
    case "single-season":
      return 0;
    case "range":
      return 1;
    case "multi-season":
      return 2;
    case "complete":
      return 3;
  }
}

/**
 * Classify a usable release against the wanted season into a pack (with the
 * wanted episodes it covers) or a single episode. Returns `null` for anything
 * that is neither — a different season, an unparseable title.
 */
function classify(
  release: TorrentResult,
  index: number,
  season: number,
  wantedSet: Set<number>,
  verdict: SwarmVerdict,
): ClassifiedPack | ClassifiedSingle | null {
  const wanted = [...wantedSet];
  const ts = titleSeason(release.title);

  // ── Partial pack: an explicit E-range inside the title ────────────────────
  const range = packEpisodeRange(release.title);
  if (range) {
    // Respect an explicit season marker; a range on the wrong season is not
    // ours. A range with no season marker at all is assumed to be this season,
    // because the caller scoped the search to this show + season.
    if (ts == null || ts === season) {
      const covers = wanted.filter((e) => e >= range.from && e <= range.to);
      if (covers.length > 0) {
        return { release, index, verdict, covers, fit: "range" };
      }
    }
  }

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
      // A pack of the season contains every episode of it, so it covers all
      // wanted episodes of this season.
      return { release, index, verdict, covers: wanted.slice(), fit };
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

/**
 * Order packs best-first for selection. Verdict dominates advertised order —
 * that is the whole point — but fit comes first among packs so a `good`
 * complete-series torrent does not beat a `good` single-season one for a user
 * who asked for one season. Within equal (fit, verdict) the ranker's order
 * (input index) is the tiebreak, exactly as `orderByVerdict` does.
 */
function comparePacks(a: ClassifiedPack, b: ClassifiedPack): number {
  return (
    fitRank(a.fit) - fitRank(b.fit) ||
    verdictTier(a.verdict) - verdictTier(b.verdict) ||
    b.covers.length - a.covers.length ||
    a.index - b.index
  );
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
 */
export function planSeason(input: {
  season: number;
  wanted: readonly number[];
  releases: readonly TorrentResult[];
  verdictOf: (r: TorrentResult) => SwarmVerdict;
}): SeasonPlan {
  const season = input.season;
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
    reason,
  });

  if (wanted.length === 0) {
    return { ...emptyPlan("No episodes requested"), missing: [] };
  }

  const packs: ClassifiedPack[] = [];
  const singles: ClassifiedSingle[] = [];
  input.releases.forEach((release, index) => {
    if (!isUsable(release)) return;
    const c = classify(release, index, season, wantedSet, input.verdictOf(release));
    if (!c) return;
    if (isPack(c)) packs.push(c);
    else singles.push(c);
  });

  if (packs.length === 0 && singles.length === 0) {
    return emptyPlan("No usable releases found for this season");
  }

  const orderedPacks = packs.slice().sort(comparePacks);

  // ── 1. Take the best good/unknown pack, if there is one ───────────────────
  // "Take a good pack when there is one." `unknown` counts as takeable so a
  // cold cache still acquires; weak/dead packs are held back for the singles
  // fallback below.
  const primaryPack =
    orderedPacks.find((p) => isTakeablePackVerdict(p.verdict)) ?? null;

  const covered = new Set<number>();
  let chosenPack: ClassifiedPack | null = null;
  if (primaryPack) {
    chosenPack = primaryPack;
    for (const e of primaryPack.covers) covered.add(e);
  }

  // ── 2. Fill every uncovered wanted episode with the best single ───────────
  // Best per episode by verdict tier then ranker order. Demote-never-filter:
  // a weak or even dead single is still taken if it is the only release for
  // that episode, because reporting the episode missing when a release exists
  // is the dishonesty we refuse. No double-grab: only episodes the chosen pack
  // does not already cover get a single.
  const chosenSingles: ClassifiedSingle[] = [];
  const bestSingleFor = (episode: number): ClassifiedSingle | null =>
    singles
      .filter((s) => s.episode === episode)
      .sort(
        (a, b) => verdictTier(a.verdict) - verdictTier(b.verdict) || a.index - b.index,
      )[0] ?? null;

  for (const episode of wanted) {
    if (covered.has(episode)) continue;
    const s = bestSingleFor(episode);
    if (s) {
      chosenSingles.push(s);
      covered.add(episode);
    }
  }

  // ── 3. Last resort: a demoted pack for episodes no single could cover ─────
  // If we took no primary pack and some wanted episodes are still uncovered
  // because no single exists for them, a demoted (weak/dead) pack that covers
  // them is better than reporting them missing — the same demote-never-filter
  // rule, applied to packs. It only claims episodes nothing else reached, so
  // it can never cause a double-grab.
  if (!chosenPack) {
    const stillMissing = wanted.filter((e) => !covered.has(e));
    if (stillMissing.length > 0) {
      const lastResort = orderedPacks
        .map((p) => ({
          p,
          gap: p.covers.filter((e) => stillMissing.includes(e)),
        }))
        .filter((x) => x.gap.length > 0)
        .sort(
          (a, b) =>
            b.gap.length - a.gap.length ||
            verdictTier(a.p.verdict) - verdictTier(b.p.verdict) ||
            comparePacks(a.p, b.p),
        )[0];
      if (lastResort) {
        chosenPack = lastResort.p;
        for (const e of lastResort.p.covers) {
          if (wantedSet.has(e)) covered.add(e);
        }
      }
    }
  }

  const coveredList = [...covered].filter((e) => wantedSet.has(e)).sort((a, b) => a - b);
  const missing = wanted.filter((e) => !covered.has(e));

  const packChoice: PackChoice | null = chosenPack
    ? {
        release: chosenPack.release,
        verdict: chosenPack.verdict,
        covers: chosenPack.covers.filter((e) => wantedSet.has(e)).sort((a, b) => a - b),
        fit: chosenPack.fit,
      }
    : null;

  const singleChoices: SingleChoice[] = chosenSingles
    .sort((a, b) => a.episode - b.episode)
    .map((s) => ({ release: s.release, verdict: s.verdict, episode: s.episode }));

  return {
    season,
    wanted,
    pack: packChoice,
    singles: singleChoices,
    covered: coveredList,
    missing,
    coverageLabel: `${coveredList.length} of ${wanted.length} episodes`,
    reason: buildReason(packChoice, singleChoices, missing, season),
  };
}

function buildReason(
  pack: PackChoice | null,
  singles: SingleChoice[],
  missing: number[],
  season: number,
): string {
  const parts: string[] = [];
  if (pack) {
    const verb = pack.verdict === "good" ? "measured good" : `verdict ${pack.verdict}`;
    if (singles.length === 0 && missing.length === 0) {
      parts.push(`Season ${season} pack (${verb}) covers the whole season`);
    } else {
      parts.push(
        `Season ${season} pack (${verb}) covers ${pack.covers.length} episode(s)`,
      );
    }
  } else if (singles.length > 0) {
    parts.push(`No takeable pack — assembling ${singles.length} episode(s) individually`);
  } else {
    parts.push(`No releases available for season ${season}`);
  }
  if (singles.length > 0 && pack) {
    parts.push(`plus ${singles.length} single(s) for the gap`);
  }
  if (missing.length > 0) {
    parts.push(`missing E${missing.map(pad).join(", E")}`);
  }
  return parts.join("; ");
}
