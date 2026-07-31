/**
 * Listing the alternative releases for a piece of content — the server side of
 * the quality selector.
 *
 * WHY THIS IS NOT A BITRATE LADDER
 * --------------------------------
 * In a streaming service, "quality" is one source re-encoded at several
 * bitrates, and the only tradeoff is sharpness vs bandwidth. In a torrent app it
 * is the opposite: each quality is a *different release* with a *different
 * swarm*. So the real question a viewer faces is not "sharper or cheaper" but
 * **"sharper, or will it play at all"** — a 1080p release behind one dead peer
 * is strictly worse than a 720p release with thirty live ones. This module
 * exists to make that visible: it lists each candidate *with its swarm verdict*
 * so a human can weigh resolution against whether the swarm actually delivers.
 * It also carries a third axis — {@link PlayabilitySignal} — so the viewer can
 * weigh resolution against whether the *browser* can even decode the release,
 * the question the "black screen, open in VLC" dead-end proved nobody was asking.
 *
 * SINGLE DISCOVERY PATH
 * ---------------------
 * The candidates are the same ranked pool `failOver`/`chooseNextRelease` use —
 * `rankedResultsFromCache`, what a prior search already cached. This module only
 * *lists and annotates*; it never runs a second search or a second ranking. The
 * pool's order is the ranker's order and is preserved verbatim: we annotate, we
 * do not re-sort, so the list cannot disagree with the ranker or the
 * auto-failover order.
 *
 * VERDICTS ARE READ, NEVER MEASURED
 * ---------------------------------
 * The swarm verdict (`good | weak | dead | unknown`) is produced by the
 * measurement agent's `swarm-probe` on its own schedule with a 6h TTL. This is a
 * UI-latency path, so it only ever **reads cached** verdicts and never probes.
 * The reader is injected ({@link SwarmVerdictReader}) so this module stays free
 * of node-only imports; `/api/playback/candidates` supplies `loadSwarmVerdicts`
 * from `swarm-probe.ts`. The default reader measures nothing and reads `unknown`
 * for every candidate, which is the correct answer when nothing is wired.
 *
 * `unknown` IS NOT `dead`. An unmeasured release is a normal, offerable choice —
 * it is listed like any other and never hidden or labelled broken. Only an
 * explicit `dead` measurement means "we watched this swarm deliver nothing".
 * Collapsing the two would hide most of the catalogue the first time the app
 * runs, before anything has been measured.
 */
import { releaseInfoHash } from "@/lib/prewarm/prerank";
import {
  directPlayableFromTitle,
  parseResolution,
  parseSourceTier,
  SOURCE_TIER,
} from "@/lib/torrents/quality";
import type { TorrentResult } from "@/lib/torrents/types";
import { normalizeMediaType } from "@/lib/metadata/media-type";
import { filterReleasesForWork } from "@/lib/torrents/work-match";
import type { PreRankTarget } from "@/lib/prewarm/types";
import { rankedResultsFromCache } from "./engine-deps";

/** A cached swarm measurement. `unknown` means unmeasured, NOT dead. */
export type SwarmVerdict = "good" | "weak" | "dead" | "unknown";

/**
 * Whether the *browser* can play this release, guessed from its name.
 *
 * This is the third axis the selector needs. Ranking asks "is this the right
 * content?"; the swarm verdict asks "will it actually deliver?"; this asks the
 * question a black-screen-then-"open in VLC" dead-end proved nobody was asking:
 * **"can the browser even decode it?"** A release we cannot play is worthless no
 * matter how healthy its swarm.
 *
 * The decision is NOT re-implemented here. `directPlayableFromTitle` in
 * `torrents/quality.ts` is the single seam, and it defers to the media layer's
 * one capability model (`media/decide.ts` + `media/capabilities.ts`) — the exact
 * engine `/api/playback/plan` uses — fed a codec/container shape inferred from
 * the release name. So:
 *   - `direct`    → plays natively, no server transcode (the name is clean);
 *   - `transcode` → the name carries a known obstacle (MKV container, DTS/TrueHD
 *                   audio, an unsupported video codec). Still *playable* — the
 *                   server remuxes/transcodes — just not instantly and not free.
 *   - `unknown`   → the name says too little to tell. Like `unknown` swarm
 *                   verdicts, this is offered normally and never treated as bad.
 *
 * `transcode` is deliberately not "cannot play": mislabelling a transcodable
 * release as broken would bury viable choices, the mirror of the swarm-verdict
 * rule that `unknown` is not `dead`.
 */
export type PlayabilitySignal = "direct" | "transcode" | "unknown";

/**
 * Reads *cached* swarm verdicts for a set of infoHashes. Must never probe — it
 * is called on a UI-latency path. Absent or expired entries are simply omitted
 * from the returned map, and the caller reads them as `unknown`.
 *
 * Implemented by `loadSwarmVerdicts` in `swarm-probe.ts`, injected at the route
 * so this module never statically imports node-only code. The default below is
 * the unmeasured answer, used only when no reader is supplied.
 */
export type SwarmVerdictReader = (
  infoHashes: readonly string[],
) => Promise<ReadonlyMap<string, SwarmVerdict>>;

/** The unknown-safe default: no measurements, so every candidate is `unknown`. */
export const unknownVerdictReader: SwarmVerdictReader = async () => new Map();

/** Human-facing capture-source label, for the selector. Display only. */
export type SourceLabel = "BluRay" | "WEB-DL" | "WEBRip" | "HDTV" | "Unknown";

const SOURCE_LABEL_PATTERNS: Array<[RegExp, SourceLabel]> = [
  [/\b(?:blu[-_. ]?ray|bluray|bdrip|brrip|bd[-_. ]?remux|remux|uhdbd)\b/i, "BluRay"],
  [/\b(?:web[-_. ]?rip|webrip)\b/i, "WEBRip"],
  [/\b(?:web[-_. ]?dl|webdl)\b/i, "WEB-DL"],
  [/\b(?:hdtv|pdtv|sdtv|dsr|dvbs?[-_. ]?rip|tvrip)\b/i, "HDTV"],
];

function sourceLabel(title: string): SourceLabel {
  const t = title.replace(/[._]/g, " ");
  for (const [re, label] of SOURCE_LABEL_PATTERNS) {
    if (re.test(t)) return label;
  }
  return "Unknown";
}

function parseCodec(title: string): string | null {
  const t = title.replace(/[._]/g, " ");
  if (/\b(?:x265|h[.\s]?265|hevc)\b/i.test(t)) return "HEVC";
  if (/\b(?:x264|h[.\s]?264|avc)\b/i.test(t)) return "H.264";
  if (/\bav1\b/i.test(t)) return "AV1";
  return null;
}

function parseAudio(title: string): string | null {
  const t = title.replace(/[._]/g, " ");
  if (/\batmos\b/i.test(t)) return "Atmos";
  if (/\btruehd\b/i.test(t)) return "TrueHD";
  if (/\bdts(?:[-\s]?hd)?(?:[-\s]?ma)?\b/i.test(t)) return "DTS";
  if (/\b(?:ddp|dd\+|e[-\s]?ac[-\s]?3|eac3)\b/i.test(t)) return "DDP";
  if (/\b(?:dd|ac[-\s]?3)\b/i.test(t)) return "DD";
  if (/\baac\b/i.test(t)) return "AAC";
  return null;
}

/** One release, annotated for the selector. */
export interface CandidateListing {
  /** Canonical lowercase-hex infoHash. Present by construction. */
  infoHash: string;
  title: string;
  /** Vertical resolution in px (1080, 720, …) or null when the name says nothing. */
  resolution: number | null;
  /** Numeric capture tier (see {@link SOURCE_TIER}); higher is better. */
  sourceTier: number;
  /** Human capture-source label for display. */
  sourceLabel: SourceLabel;
  sizeBytes: number | null;
  sizeLabel: string | null;
  codec: string | null;
  audio: string | null;
  /**
   * Whether the browser can decode this release, from its name. See
   * {@link PlayabilitySignal} — `transcode` is playable-but-not-free, not broken.
   */
  playability: PlayabilitySignal;
  /** Advertised seeders — a claim from the indexer, which the verdict may contradict. */
  seeders: number;
  /** True for the release currently playing. */
  isCurrent: boolean;
  /** Cached swarm measurement. `unknown` when unmeasured — offered normally. */
  verdict: SwarmVerdict;
}

/** Map the media layer's direct-play hint to the selector's playability axis. */
export function playabilityFromTitle(title: string): PlayabilitySignal {
  const direct = directPlayableFromTitle(title);
  if (direct === true) return "direct";
  if (direct === false) return "transcode";
  return "unknown";
}

/** Turn a release title into its display shape. Pure and unit-testable. */
export function describeReleaseShape(title: string): {
  resolution: number | null;
  sourceTier: number;
  sourceLabel: SourceLabel;
  codec: string | null;
  audio: string | null;
  playability: PlayabilitySignal;
} {
  return {
    resolution: parseResolution(title),
    sourceTier: parseSourceTier(title),
    sourceLabel: sourceLabel(title),
    codec: parseCodec(title),
    audio: parseAudio(title),
    playability: playabilityFromTitle(title),
  };
}

export interface ListCandidatesOptions {
  /** The infoHash currently playing, so the list can mark it. */
  currentInfoHash?: string | null;
  /** Candidate pool source; defaults to the shared cached ranked pool. */
  rankedResults?: (target: PreRankTarget) => Promise<readonly TorrentResult[]>;
  /** Cached verdict reader; defaults to unknown-for-all. Never probes. */
  readVerdicts?: SwarmVerdictReader;
}

/**
 * List the alternative releases for `target`, annotated with quality shape and
 * cached swarm verdicts, in the ranker's order.
 *
 * A release with no resolvable infoHash is dropped: it cannot be selected,
 * committed, or measured, so it cannot be a menu item. Duplicate infoHashes are
 * collapsed to the first (highest-ranked) occurrence.
 *
 * Releases that are not this *work* are dropped too. The pool comes from a
 * free-text search, so for a film it happily contains other films of the same
 * name and things that are not films at all — the reported bug listed a 1997
 * print, a documentary and an audiobook under the 2026 *Odyssey*. A menu of
 * releases for something else is worse than a short menu. See `work-match.ts`.
 */
export async function listCandidates(
  target: PreRankTarget,
  options: ListCandidatesOptions = {},
): Promise<CandidateListing[]> {
  const getPool = options.rankedResults ?? ((t) => rankedResultsFromCache(t));
  const readVerdicts = options.readVerdicts ?? unknownVerdictReader;
  const current = options.currentInfoHash?.toLowerCase() ?? null;

  const pool = await getPool(target);
  // Only a CONFIRMED film is filtered by name/year. A series' releases are
  // already constrained by season/episode and their names legitimately
  // disagree with the catalogue, and an unrecognised media type is not
  // something to guess about — see `selectBestRelease`.
  const sameWork =
    normalizeMediaType(target.mediaType) === "movie"
      ? filterReleasesForWork(pool, {
          title: target.title,
          year: target.year,
          isSeries: false,
        })
      : pool;

  const seen = new Set<string>();
  const usable: Array<{ release: TorrentResult; infoHash: string }> = [];
  for (const release of sameWork) {
    const infoHash = releaseInfoHash(release);
    if (!infoHash || seen.has(infoHash)) continue;
    seen.add(infoHash);
    usable.push({ release, infoHash });
  }

  let verdicts: ReadonlyMap<string, SwarmVerdict>;
  try {
    verdicts = await readVerdicts(usable.map((u) => u.infoHash));
  } catch {
    // A verdict lookup failure must not blank the whole selector — fall back to
    // unknown, which is offered normally.
    verdicts = new Map();
  }

  return usable.map(({ release, infoHash }) => {
    const shape = describeReleaseShape(release.title);
    return {
      infoHash,
      title: release.title,
      resolution: shape.resolution,
      sourceTier: shape.sourceTier,
      sourceLabel: shape.sourceLabel,
      sizeBytes: release.sizeBytes,
      sizeLabel: release.sizeLabel ?? null,
      codec: shape.codec,
      audio: shape.audio,
      playability: shape.playability,
      seeders: release.seeders,
      isCurrent: current !== null && infoHash === current,
      verdict: verdicts.get(infoHash) ?? "unknown",
    };
  });
}
