/**
 * What the title page is allowed to offer — the one decision the whole
 * redesign hangs off.
 *
 * The product complaint this answers: clicking a title used to land you in a
 * table of release names. So the primary control here is never navigation. It
 * is **Watch**, **Resume**, or **Download**, and nothing else — a search link
 * may exist on the page, but only as a discreet way to override a decision the
 * app has already made for you.
 *
 * The label says what the click does and nothing explains it underneath: a
 * button reading Download does not need a sentence telling you it downloads.
 *
 * Two rules carry over from the browse card and are not negotiable:
 *
 *  1. **Never offer Watch for something that will not play.** A `ready` claim
 *     with no info hash is nothing the player can open, so it degrades to
 *     Download rather than rendering a button that dead-ends.
 *  2. **`null` is not `unavailable`.** Nobody having searched is not the same
 *     as having searched and found nothing. Both still get a working Download
 *     button — the action is the same either way, so the button is the same.
 *
 * Pure and DOM-free on purpose: `title.test.ts` drives it as a table.
 */
import type { AvailabilityState } from "@/lib/browse";
import type { TitleDetailPayload, TitleEpisode } from "./types";

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Opens the player on a file we actually hold. */
export interface PlayTitleAction {
  kind: "play";
  label: "Watch" | "Resume";
  infoHash: string;
  filePath: string | null;
  resumePositionSec: number | null;
  season: number | null;
  episode: number | null;
}

/** Searches and sends, in one click. Never navigates to a release table. */
export interface GetTitleAction {
  kind: "get";
  label: "Download";
  season: number | null;
  episode: number | null;
}

export type TitleAction = PlayTitleAction | GetTitleAction;

/**
 * What each concrete state permits, as a total map.
 *
 * Same discipline as `components/browse/availability.ts`: a state added
 * upstream is a compile error *here*, at the one table that has to decide
 * about it, rather than silently inheriting whichever branch happens to be
 * last. `null` is deliberately not a key — it is handled before the lookup.
 */
const STATE_POLICY: Record<AvailabilityState, "local" | "remote"> = {
  ready: "local",
  warm: "local",
  fetchable: "remote",
  unavailable: "remote",
};

/** The minimum a thing needs for this module to decide about it. */
export interface Playable {
  availability: AvailabilityState | null;
  infoHash: string | null;
  filePath?: string | null;
  resumePositionSec?: number | null;
  season?: number | null;
  episode?: number | null;
}

/**
 * The single action offered for one playable thing.
 *
 * Ordering matters:
 *  1. Local *and* addressable → Watch/Resume.
 *  2. Local but no info hash → falls through; a claim we cannot honour never
 *     surfaces as Watch.
 *  3. Everything else → Download.
 */
export function resolvePlayableAction(item: Playable): TitleAction {
  const state = item.availability;
  const infoHash = item.infoHash?.trim();
  const season = item.season ?? null;
  const episode = item.episode ?? null;

  if (state !== null && STATE_POLICY[state] === "local" && infoHash) {
    const resume = item.resumePositionSec ?? 0;
    return {
      kind: "play",
      label: resume > 0 ? "Resume" : "Watch",
      infoHash,
      filePath: item.filePath ?? null,
      resumePositionSec: item.resumePositionSec ?? null,
      season,
      episode,
    };
  }

  return {
    kind: "get",
    label: "Download",
    season,
    episode,
  };
}

/** The action for one episode row. */
export function resolveEpisodeAction(episode: TitleEpisode): TitleAction {
  return resolvePlayableAction({
    availability: episode.availability,
    infoHash: episode.infoHash,
    filePath: episode.filePath,
    resumePositionSec: episode.resumePositionSec,
    season: episode.season,
    episode: episode.episode,
  });
}

// ---------------------------------------------------------------------------
// The primary action
// ---------------------------------------------------------------------------

/**
 * The one control the page is built around.
 *
 * For a series it follows the viewer, not the season tab: resume what was
 * started, else play the first episode on disk that has not been watched, else
 * get the episode the library is waiting for. Switching season tabs changes
 * the list, never this button — the per-episode buttons are how you act on a
 * season you are browsing rather than watching.
 */
export function resolvePrimaryAction(payload: TitleDetailPayload): TitleAction {
  const resume = payload.resume;
  if (resume?.infoHash && (resume.positionSec ?? 0) > 0) {
    return {
      kind: "play",
      label: "Resume",
      infoHash: resume.infoHash,
      filePath: resume.filePath,
      resumePositionSec: resume.positionSec,
      season: resume.season,
      episode: resume.episode,
    };
  }

  if (payload.isSeries) {
    const next = firstPlayableEpisode(payload.episodes);
    if (next) return resolveEpisodeAction(next);
  }

  const titleLevel = resolvePlayableAction({
    availability: payload.availability,
    infoHash: payload.infoHash,
    filePath: null,
    resumePositionSec: null,
  });
  if (titleLevel.kind === "play") return titleLevel;

  if (payload.isSeries) {
    const target = nextUpTarget(payload);
    return {
      kind: "get",
      label: "Download",
      season: target.season,
      episode: target.episode,
    };
  }

  return titleLevel;
}

/** The earliest episode on disk that has not been watched to the end. */
function firstPlayableEpisode(episodes: TitleEpisode[]): TitleEpisode | null {
  const playable = episodes
    .filter((e) => e.infoHash && !e.watched)
    .filter((e) => e.availability !== null && STATE_POLICY[e.availability] === "local")
    .sort((a, b) => a.season - b.season || a.episode - b.episode);
  return playable[0] ?? null;
}

/**
 * Which episode a series-level Get should ask for.
 *
 * The library's hunt cursor when there is one — it is the app's existing
 * answer to "what is this show waiting for" and reusing it keeps one notion of
 * next. Otherwise the first episode after the last one we know about, and
 * failing that S01E01, which is the only episode every series is guaranteed
 * to have.
 */
export function nextUpTarget(payload: TitleDetailPayload): {
  season: number;
  episode: number;
} {
  const { cursorSeason, cursorEpisode } = payload.library;
  if (cursorSeason && cursorEpisode) {
    return { season: cursorSeason, episode: cursorEpisode };
  }

  const known = payload.episodes.filter((e) => e.infoHash);
  if (known.length) {
    const last = known.reduce((a, b) =>
      b.season > a.season || (b.season === a.season && b.episode > a.episode) ? b : a,
    );
    return { season: last.season, episode: last.episode + 1 };
  }

  const season = payload.season ?? payload.seasons[0]?.season ?? 1;
  return { season, episode: 1 };
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** Where an in-flight action has got to. One grab at a time, per control. */
export type TitleActionStatus = "idle" | "pending" | "done" | "error";

/**
 * The button text for an action in a given status.
 *
 * A grab takes tens of seconds and then hands off to the client, so the
 * control has to keep telling the truth the whole way through: one that still
 * says "Download" after a successful grab invites a second, duplicate grab.
 */
export function titleActionLabel(
  action: TitleAction,
  status: TitleActionStatus,
): string {
  switch (action.kind) {
    case "play":
      if (status === "pending") return "Opening…";
      if (status === "error") return "Try again";
      return action.label;
    case "get":
      if (status === "pending") return "Starting…";
      if (status === "error") return "Try again";
      if (status === "done") return "Downloading";
      return action.label;
    default:
      return assertNeverAction(action);
  }
}

function assertNeverAction(action: never): never {
  throw new Error(`Unhandled title action: ${JSON.stringify(action)}`);
}
