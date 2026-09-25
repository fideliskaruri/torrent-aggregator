/**
 * What the title page is allowed to offer — the one decision the whole
 * redesign hangs off.
 *
 * The product complaint this answers: clicking a title used to land you in a
 * table of release names. So the primary control here is never navigation. It
 * is **Play**, **Resume**, or **Get**, and nothing else — a search link
 * may exist on the page, but only as a discreet way to override a decision the
 * app has already made for you.
 *
 * The label says what the click does and nothing explains it underneath: a
 * button reading Get does not need a sentence telling you it downloads.
 *
 * Two rules carry over from the browse card and are not negotiable:
 *
 *  1. **Never offer Play for something that will not play.** A `ready` claim
 *     with no info hash is nothing the player can open, so it degrades — but
 *     to a *stream* Play, which searches and sends before opening the player,
 *     rather than to a button that dead-ends.
 *  2. **`null` is not `unavailable`.** Nobody having searched is not the same
 *     as having searched and found nothing — but both still get Play. Unchecked
 *     runs the search; a prior miss retries the (improved) ladder. A thin miss
 *     must never demote the primary control to Get forever.
 *
 * Pure and DOM-free on purpose: `title.test.ts` drives it as a table.
 */
import type { AvailabilityState } from "@/lib/browse";
import type {
  TitleDetailPayload,
  TitleEpisode,
  TitleEpisodeTransfer,
} from "./types";

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Opens the player on a file we actually hold. */
interface PlayTitleAction {
  kind: "play";
  label: "Play" | "Resume";
  infoHash: string;
  filePath: string | null;
  resumePositionSec: number | null;
  season: number | null;
  episode: number | null;
}

/** Searches and sends, in one click. Never navigates to a release table. */
interface GetTitleAction {
  kind: "get";
  label: "Get" | "Download";
  season: number | null;
  episode: number | null;
  /** Present when Download only has to keep a torrent that is already local. */
  infoHash?: string | null;
}

/**
 * Grab it, then open the player on what was grabbed.
 *
 * The product rule is "click and it plays". Anything we do not already hold
 * used to answer that with a Get button, which asks the viewer to leave
 * and come back — the one thing this redesign exists to stop.
 *
 * Nothing new is needed to honour it. The engine already adds every torrent
 * with `strategy: "sequential"` and pulls the file's first and last bytes into
 * the piece selector (`clients/builtin-engine.ts`), both done specifically so a
 * partial file is watchable from the start. The grab pipeline already knows the
 * info hash it chose — it dedupes on it — and used to throw it away at the API
 * boundary. Returning it is the whole change: a torrent that started one second
 * ago is as addressable as one that finished last week.
 *
 * This is a *distinct kind* rather than a flag on `play`, because the two have
 * different failure modes and must not share a code path. `play` opens
 * something we hold and can only fail to render. `stream` performs a search and
 * a send first, either of which can find nothing — and a Play press that finds
 * nothing must say so, never open a black player and let the viewer conclude
 * the app is broken.
 */
interface StreamTitleAction {
  kind: "stream";
  label: "Play";
  season: number | null;
  episode: number | null;
}

/**
 * We know this is a series, but not which episode to act on.
 *
 * This exists so the title page can stop *inventing* one. The old fallback
 * returned S01E01 whenever the cursor, the catalog and local files were all
 * silent — which reads as a confident claim ("play the first episode") built
 * on no evidence at all. For a series whose episodes have not loaded, or one
 * the catalog does not carry, that produced a Play button pointing at an
 * episode nobody had established exists, next to an empty list saying there
 * were no episodes. Two contradictory claims from one payload.
 *
 * The honest answer is a different action, not a guessed target: offer to go
 * and find the episodes, and only show Play/Download once something real came
 * back. `season` is carried when a season is in view so the lookup can be
 * narrowed; it is never used to synthesise an episode number.
 */
interface DiscoverTitleAction {
  kind: "discover";
  label: "Find episodes";
  season: number | null;
  episode: null;
}

export type TitleAction =
  | PlayTitleAction
  | GetTitleAction
  | StreamTitleAction
  | DiscoverTitleAction;

/**
 * What each concrete state permits, as a total map.
 *
 * Same discipline as `components/browse/availability.ts`: a state added
 * upstream is a compile error *here*, at the one table that has to decide
 * about it, rather than silently inheriting whichever branch happens to be
 * last. `null` is deliberately not a key — it is handled before the lookup.
 *
 * `fetchable` means we have searched and a seeded release exists. That is not
 * "come back later", it is "press play"; it moves to `stream`.
 *
 * `unavailable` used to stay a Get after one miss. That poisoned titles the
 * ladder can now find (anime aliases, dual Nyaa categories). Play retries the
 * search; if it still finds nothing, the failure copy on the control says so.
 * Download remains a separate keep-intent control — never the only way in.
 */
const STATE_POLICY: Record<AvailabilityState, "local" | "stream" | "remote"> = {
  ready: "local",
  warm: "local",
  fetchable: "stream",
  unavailable: "stream",
};

/** The minimum a thing needs for this module to decide about it. */
interface Playable {
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
 *  1. Local *and* addressable → Play/Resume, straight into the player.
 *  2. Everything else — fetchable, unchecked, prior miss, or a local claim
 *     with no info hash — → Play via a grab. A thin earlier search is not a
 *     reason to demote the primary control to Get.
 */
function resolvePlayableAction(item: Playable): TitleAction {
  const state = item.availability;
  const infoHash = item.infoHash?.trim();
  const season = item.season ?? null;
  const episode = item.episode ?? null;

  // `null` is not a key in the table: an unchecked thing is one search away
  // from playing, which is the same shape as `fetchable`, not the same shape
  // as a state we have checked and ruled out.
  const policy = state === null ? "stream" : STATE_POLICY[state];

  if (policy === "local" && infoHash) {
    const resume = item.resumePositionSec ?? 0;
    return {
      kind: "play",
      label: resume > 0 ? "Resume" : "Play",
      infoHash,
      filePath: item.filePath ?? null,
      resumePositionSec: item.resumePositionSec ?? null,
      season,
      episode,
    };
  }

  if (policy === "remote") {
    return {
      kind: "get",
      label: "Get",
      season,
      episode,
    };
  }

  return {
    kind: "stream",
    label: "Play",
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

  // A series-level action has to name an episode; the title-level lookup could
  // not, because it was asked about the work. Keep whichever kind the state
  // earned and only fill in the target — a `fetchable` series must not lose its
  // Play on the way through here just because it needed an episode number.
  //
  // When no episode can be named from evidence, the action becomes discovery
  // rather than a guess. See {@link DiscoverTitleAction}.
  if (payload.isSeries) {
    const target = nextUpTarget(payload);
    if (!target) {
      return {
        kind: "discover",
        label: "Find episodes",
        season: payload.season ?? payload.seasons[0]?.season ?? null,
        episode: null,
      };
    }
    return titleLevel.kind === "stream"
      ? {
          kind: "stream",
          label: "Play",
          season: target.season,
          episode: target.episode,
        }
      : {
          kind: "get",
          label: "Get",
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
 * Which episode a series-level action should ask for, or `null` when none can
 * be named from evidence.
 *
 * In order: the library's hunt cursor when there is one — it is the app's
 * existing answer to "what is this show waiting for", and reusing it keeps one
 * notion of next. Otherwise the episode after the last one we actually hold.
 * Otherwise the first episode the catalog lists, which is evidence too: the
 * payload carried that row, so the episode demonstrably exists.
 *
 * There is deliberately no fourth fallback. This used to end in S01E01 on the
 * grounds that every series has one, but that is a claim about the *world*,
 * not about anything this payload established — and the payload is all the
 * caller has. Returning `null` moves the decision to the one place equipped to
 * make it: {@link resolvePrimaryAction}, which offers discovery instead.
 */
function nextUpTarget(payload: TitleDetailPayload): {
  season: number;
  episode: number;
} | null {
  const { cursorSeason, cursorEpisode } = payload.library;
  if (cursorSeason && cursorEpisode) {
    return { season: cursorSeason, episode: cursorEpisode };
  }

  const held = payload.episodes.filter((e) => e.infoHash);
  if (held.length) {
    const last = held.reduce((a, b) =>
      b.season > a.season || (b.season === a.season && b.episode > a.episode) ? b : a,
    );
    return { season: last.season, episode: last.episode + 1 };
  }

  // Nothing held, but the catalog listed episodes: act on the earliest one.
  // This is not a guess — the row came back from the server.
  const listed = [...payload.episodes].sort(
    (a, b) => a.season - b.season || a.episode - b.episode,
  )[0];
  if (listed) return { season: listed.season, episode: listed.episode };

  return null;
}

// ---------------------------------------------------------------------------
// Button state
// ---------------------------------------------------------------------------

/** Where an in-flight action has got to. One grab at a time, per control. */
export type TitleActionStatus = "idle" | "pending" | "done" | "error";

/**
 * Whether pressing the button may run side effects now.
 *
 * The label no longer prevents duplicate grabs; it stays an action word while
 * status lives beside the progress row. This predicate is the guard instead:
 * pending actions cannot be clicked, and successful remote grabs stay spent
 * until the refreshed payload resolves them into a real `play` action.
 */
export function shouldRunTitleAction(
  action: TitleAction,
  status: TitleActionStatus,
): boolean {
  if (status === "pending") return false;
  if (status === "done" && action.kind !== "play") return false;
  return true;
}

/**
 * The button's visible action text.
 *
 * This only folds failures into a retry label. Progress and completion are not
 * encoded here, because state belongs in the status row, not the primary slot.
 *
 * A failed retry names what will be retried. "Try again" was the same four
 * characters whether a search had found nothing, a send to the engine had been
 * refused, or a local file had failed to open — three different problems with
 * three different remedies, and the label told you which one you had by
 * telling you nothing.
 */
export function titleActionButtonLabel(
  action: TitleAction,
  status: TitleActionStatus,
): string {
  switch (action.kind) {
    case "play":
      if (status === "error") return "Retry play";
      return action.label;
    case "stream":
      if (status === "error") return "Retry play";
      return action.label;
    case "get":
      if (status === "error") return "Retry download";
      return action.label;
    case "discover":
      if (status === "error") return "Retry search";
      return action.label;
    default:
      return assertNeverAction(action);
  }
}

function assertNeverAction(action: never): never {
  throw new Error(`Unhandled title action: ${JSON.stringify(action)}`);
}

// ---------------------------------------------------------------------------
// Transfer state
// ---------------------------------------------------------------------------

/**
 * Whether a Download control may be offered for a target in this state.
 *
 * The rule is one intent, one control. A target the user has already asked
 * for is not offered again — pressing Download beside a torrent the Client is
 * actively fetching either starts a second grab or silently does nothing, and
 * both teach the viewer that the button lies.
 *
 * `failed` is the exception: it is the one state where pressing again is the
 * correct move, so the control stays and the label becomes a retry.
 * `null` means no target exists — nothing has been asked for, so Download is
 * exactly right.
 */
export function offersDownload(transfer: TitleEpisodeTransfer | null): boolean {
  if (!transfer) return true;
  return transfer.status === "failed";
}
