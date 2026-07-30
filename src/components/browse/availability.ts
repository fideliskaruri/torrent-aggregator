/**
 * Availability → what the UI is allowed to offer.
 *
 * The product rule this module exists to enforce: **never render a Play button
 * that will not play.** A rail item claims a state, but a claim is not enough —
 * `ready` with no info hash is nothing the player can open, so the label has to
 * follow what we can actually *do* with the fields we hold, not the adjective
 * the data layer chose. Every surface (card, hero, overlay) reads its label,
 * its behaviour and its disabled reason from here, so there is one place to be
 * wrong and one place to fix.
 *
 * Pure and DOM-free on purpose: `browse-ui.test.ts` drives it as a table.
 */
import type { AvailabilityState, RailItem } from "@/lib/browse";
import { SEARCH_HREF } from "@/lib/navigation";

// ---------------------------------------------------------------------------
// The state, as the UI sees it
// ---------------------------------------------------------------------------

/**
 * The unresolved case, spelled out.
 *
 * `RailItem.availability` is `AvailabilityState | null`, and `null` is not
 * missing data — it is a distinct, *expected* answer meaning "nobody has
 * checked". Deciding `fetchable` costs an indexer search, far too slow to run
 * for a page of rails, so the data layer returns `null` rather than guessing.
 *
 * `null` and `unavailable` are opposites and must never be collapsed: one means
 * "we have not looked", the other means "we looked and there is nothing".
 * Conflating them is exactly the false-negative this state exists to prevent,
 * so every consumer below handles `null` on its own path *before* it reaches a
 * `switch` — never as a `default:` that quietly shares the `unavailable` branch.
 *
 * A locally-held title always resolves to `ready`/`warm`: that check is cheap
 * and always runs, so `null` never hides something already on disk.
 */
export type Unresolved = null;

/**
 * Compile-time exhaustiveness over the four concrete states. Reached only if a
 * new member is added without a matching branch, and then it is a type error,
 * not a runtime one.
 */
function assertNever(value: never, context: string): never {
  throw new Error(`Unhandled availability state in ${context}: ${String(value)}`);
}

// ---------------------------------------------------------------------------
// Chip presentation
// ---------------------------------------------------------------------------

export type AvailabilityTone =
  | "success"
  | "accent"
  | "secondary"
  | "tertiary"
  | "info";

export interface AvailabilityMeta {
  /** Chip text. Never colour alone — the word carries the meaning. */
  label: string;
  tone: AvailabilityTone;
  /**
   * One honest sentence, used for tooltips and screen-reader description, or
   * `null` when the word says everything there is to say.
   *
   * Null is not "we forgot": the app does not narrate its own mechanics at the
   * user. A state whose label already reads as plain English gets no sentence
   * explaining what the label means, and consumers must render nothing at all
   * rather than an empty tooltip.
   */
  description: string | null;
}

/**
 * Neutral and inviting, never a warning: on a real install most cards land
 * here, and dressing it as a problem would make the whole page look broken.
 *
 * No description. "Not checked" is already the whole fact, and a sentence
 * underneath telling the user to open it to find out is the app explaining
 * itself instead of just working.
 */
const UNRESOLVED_META: AvailabilityMeta = {
  label: "Not checked",
  tone: "info",
  description: null,
};

export function availabilityMeta(
  state: AvailabilityState | Unresolved,
): AvailabilityMeta {
  if (state === null) return UNRESOLVED_META;
  switch (state) {
    case "ready":
      return {
        label: "Ready",
        tone: "success",
        description: "Downloaded in full. Plays instantly and seeks anywhere.",
      };
    case "warm":
          // Not "Playable" — that competed with "Ready" as a second word for
          // "you can press Play". "Partial" names the actual difference (bytes on
          // disk) while the accent tone still marks it as live/playable.
          return {
            label: "Partial",
            tone: "accent",
            description: "Partly downloaded and live in the swarm. Plays now.",
          };
    case "fetchable":
      return {
        label: "Can get",
        tone: "secondary",
        description: "Not on disk yet, but a viable release exists.",
      };
    case "unavailable":
      return {
        label: "Unavailable",
        tone: "tertiary",
        description: "Searched, and nothing viable came back.",
      };
    default:
      return assertNever(state, "availabilityMeta");
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Opens the player for a torrent we already hold. */
export interface PlayAction {
  kind: "play";
  label: "Play" | "Resume";
  disabled: false;
  reason: null;
  infoHash: string;
  filePath: string | null;
  resumePositionSec: number | null;
}

/** Asks the on-demand grabber for one specific episode. */
export interface GetAction {
  kind: "get";
  label: "Download";
  disabled: false;
  reason: null;
  request: {
    watchListItemId: string | null;
    title: string;
    mediaType: string;
    season: number;
    episode: number;
  };
}

/** Hands the title to search — the affordance that always works. */
export interface SearchAction {
  kind: "search";
  /** "Find it" — a plain, honest handoff to search. Never narrates a check. */
  label: "Find it";
  disabled: false;
  reason: null;
  href: string;
}

/** Nothing to offer. Says why, out loud. The only dead end. */
export interface BlockedAction {
  kind: "blocked";
  label: "Unavailable";
  disabled: true;
  reason: string;
}

export type CardAction = PlayAction | GetAction | SearchAction | BlockedAction;

/**
 * Default media type for an on-demand grab when the row does not name one.
 *
 * The grabber compares media types with `===` (`"anime"` / `"movie"`), so a
 * capitalised value from the catalog would silently be routed as TV. Normalise
 * here rather than hoping every caller already did.
 */
const DEFAULT_MEDIA_TYPE = "tv";

function normalizeMediaType(raw: string | null): string {
  return raw?.trim().toLowerCase() || DEFAULT_MEDIA_TYPE;
}

/**
 * What each concrete state permits, as a total map.
 *
 * {@link resolveCardAction} reads its policy from here rather than testing
 * string literals inline, so a state added upstream is a compile error at this
 * table — the one place that has to make a decision about it — instead of
 * silently falling through to whichever branch happens to be last. `null` is
 * deliberately *not* a key: an unresolved item is handled before this lookup,
 * so it can never inherit another state's policy by accident.
 */
const STATE_POLICY: Record<AvailabilityState, "local" | "fetch" | "dead"> = {
  ready: "local",
  warm: "local",
  fetchable: "fetch",
  unavailable: "dead",
};

/**
 * The single action a card or hero may offer for `item`.
 *
 * Ordering of the rules matters:
 *  1. Playable *and* we hold the info hash → Play/Resume.
 *  2. Playable but no info hash → treat as not-local. A claim we cannot honour
 *     must never surface as Play; it degrades below.
 *  3. `unavailable` → blocked, with the reason spoken. The *only* dead end.
 *  4. No title at all → blocked; there is not even a string to look up.
 *  5. `null` → Check. Nobody has searched, so the honest offer is to go and
 *     find out, not to promise a grab we have no evidence can succeed.
 *  6. Enough to name one episode → Download (on-demand grab).
 *  7. Otherwise → Find it (search). Always executable.
 */
export function resolveCardAction(item: RailItem): CardAction {
  const state = item.availability;
  const infoHash = item.infoHash?.trim();
  const title = item.title.trim();

  if (state !== null && STATE_POLICY[state] === "local" && infoHash) {
    const resume = item.resumePositionSec ?? 0;
    return {
      kind: "play",
      label: resume > 0 ? "Resume" : "Play",
      disabled: false,
      reason: null,
      infoHash,
      filePath: item.filePath,
      resumePositionSec: item.resumePositionSec,
    };
  }

  if (state !== null && STATE_POLICY[state] === "dead") {
    return {
      kind: "blocked",
      label: "Unavailable",
      disabled: true,
      reason: item.watchListItemId
        ? "Nothing viable on the indexers yet — it stays monitored in your library."
        : "No viable release found yet.",
    };
  }

  if (!title) {
    return {
      kind: "blocked",
      label: "Unavailable",
      disabled: true,
      reason: "This entry has no title to look up.",
    };
  }

  // Unresolved: the expensive indexer search has not run, so the card leads to
  // the one place that *does* run it. Clickable, neutral, no promise made —
  // and explicitly not a grab, which would commit to a download on no evidence.
  if (state === null) {
    return {
      kind: "search",
      label: "Find it",
      disabled: false,
      reason: null,
      href: searchHref(title, searchCategoryFor(item.mediaType)),
    };
  }

  const episode = episodeRequest(item);
  if (episode) {
    return {
      kind: "get",
      label: "Download",
      disabled: false,
      reason: null,
      request: {
        watchListItemId: item.watchListItemId,
        title,
        mediaType: normalizeMediaType(item.mediaType),
        season: episode.season,
        episode: episode.episode,
      },
    };
  }

  // `fetchable` with no episode to name, and `ready`/`warm` whose info hash we
  // do not actually hold: a release exists, we just cannot address it from
  // here. Search can.
  return {
    kind: "search",
    label: "Find it",
    disabled: false,
    reason: null,
    href: searchHref(title, searchCategoryFor(item.mediaType)),
  };
}

/**
 * The secondary "go looking yourself" action, or null when there is no title.
 *
 * Every state gets one: it is the only affordance that cannot fail, so it is
 * what keeps a blocked card from being a dead end.
 */
export function searchAction(item: RailItem): SearchAction | null {
  const title = item.title.trim();
  if (!title) return null;
  return {
    kind: "search",
    label: "Find it",
    disabled: false,
    reason: null,
    href: searchHref(title, searchCategoryFor(item.mediaType)),
  };
}

function episodeRequest(
  item: RailItem,
): { season: number; episode: number } | null {
  const { season, episode } = item;
  if (season == null || episode == null) return null;
  if (!Number.isInteger(season) || !Number.isInteger(episode)) return null;
  if (season < 1 || episode < 1) return null;
  return { season, episode };
}

export function searchHref(title: string, category?: string | null): string {
  const params = new URLSearchParams({ q: searchQueryFor(title) });
  if (category && category !== "all") params.set("category", category);
  return `${SEARCH_HREF}?${params.toString()}`;
}

/** Category slug the search page uses for a rail item's media type. */
const SEARCH_CATEGORY_BY_MEDIA_TYPE: Record<string, string> = {
  anime: "anime",
  movie: "movies",
  movies: "movies",
  tv: "tv",
};

export function searchCategoryFor(mediaType: string | null): string | null {
  if (!mediaType) return null;
  return SEARCH_CATEGORY_BY_MEDIA_TYPE[mediaType.trim().toLowerCase()] ?? null;
}

/**
 * What to actually type into search for a card.
 *
 * Rail titles are whatever the source had: a catalog name for library rows, a
 * raw release name for anything that came from a torrent. Searching the raw
 * release name returns nothing, so it is cleaned the same way it is displayed.
 */
export function searchQueryFor(title: string): string {
  return cleanDisplayTitle(title);
}

// ---------------------------------------------------------------------------
// Titles
// ---------------------------------------------------------------------------

/**
 * Release-name noise: tokens that are never part of a title.
 *
 * Three classes, all describing the *distribution artifact* rather than the
 * work: how it was encoded (resolution, codec, audio), where it came from
 * (the distributing platform, or the capture method for a pre-release rip),
 * and what container it was muxed into. A title only ever names the work, so
 * anything in these classes is debris.
 *
 * Deliberately excluded as ambiguous, because each is also a real title or a
 * word inside one: `MAX` (*Mad Max*), `CAM` (*Cam*, 2018), `NF`, `TS`, `TC`,
 * `WP`. Stripping those costs more than the debris they remove — the fallback
 * at the end of `cleanDisplayTitle` would return the raw name anyway, so a
 * false positive is a silently worse caption, not a caught error.
 */
const RELEASE_TOKENS =
  /\b(\d{3,4}p|4k|uhd|hdr(?:10)?\+?|dolby ?vision|x26[45]|h\.?26[45]|hevc|avc|aac(?:5\.1|2\.0)?|ac-?3|e-?ac-?3|ddp?5\.1|dts(?:-hd)?|flac|opus|web-?dl|web-?rip|b[dr]rip|blu-?ray|hdtv|dvdrip|remux|repack|proper|multi|dual ?audio|subbed|dubbed|10 ?bits?|8 ?bits?|amzn|dsnp|hmax|atvp|hulu|pcok|stan|crav|telesync|telecine|hdcam|hdts|screener|dvdscr|workprint|mp4|mkv|avi|m4v|xvid|divx)\b/gi;

const FILE_EXTENSION = /\.(mkv|mp4|avi|m4v|mov|webm|ts|m2ts|mpe?g|iso)$/i;

/** `www.site.com - `, `[Site]`, `(Site)` prefixes indexers glue on. */
const SITE_PREFIX = /^\s*(?:\[[^\]]*\]|\([^)]*\)|www\.[^\s]+\s*-)\s*/i;

/** A bracketed group anywhere: `[SubsPlease]`, `[1080p]`, `[ABC123]`. */
const BRACKET_GROUP = /\[[^\]]*\]/g;

/** A parenthesised group that is not a release year — `(1080p)`, not `(2019)`. */
const PAREN_NOISE = /\((?![^)]*\b(?:19|20)\d{2}\b)[^)]*\)/g;

/** A trailing scene release group: `… x264-NTb`, `… BluRay-FLAME`. */
const TRAILING_GROUP = /\s-[A-Za-z0-9]+$/;

/**
 * A human-readable title for a card.
 *
 * Applies to *any* release-shaped string, not one indexer's format: strip the
 * site prefix, drop the extension, remove quality tokens, unglue dot-separated
 * names, remove bracketed groups, then trim the trailing separator debris.
 * Falls back to the original whenever cleaning would leave nothing — an empty
 * card title is worse than an ugly one.
 */
export function cleanDisplayTitle(raw: string): string {
  const original = raw.trim();
  if (!original) return original;

  let out = original;
  // Site prefixes stack: "[Nyaa] [SubsPlease] Show - 01".
  for (let i = 0; i < 3; i++) {
    const next = out.replace(SITE_PREFIX, "");
    if (next === out || !next.trim()) break;
    out = next;
  }
  out = out.replace(FILE_EXTENSION, "");

  // Decide the shape from the name we were *given*, before any substitution
  // introduces spaces of its own: a name with no spaces at all is dot- or
  // underscore-separated, whereas a title that already has spaces may
  // legitimately contain dots ("Mr. Robot").
  const dotSeparated = !/\s/.test(out);

  // Tokens are stripped before the dots are unglued as well as after, because
  // several of them contain dots themselves ("DDP5.1", "H.264"). Unglueing
  // first would split those into fragments no pattern can match, and the
  // debris would end up in the card title.
  out = out.replace(RELEASE_TOKENS, " ");
  if (dotSeparated) out = out.replace(/[._]+/g, " ");
  out = out.replace(BRACKET_GROUP, " ").replace(PAREN_NOISE, " ");
  out = out.replace(RELEASE_TOKENS, " ");
  out = out.replace(/\s+/g, " ").trim();
  // Only for release names: a lone "-NTb" left behind by the stripped tokens is
  // the release group, never part of a title someone typed.
  if (dotSeparated) out = out.replace(TRAILING_GROUP, "");
  out = out
    .replace(/\s+/g, " ")
    .replace(/^[\s._-]+/, "")
    .replace(/[\s._-]+$/, "")
    .trim();

  return out || original;
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

/** A 0–1 fraction, or null when there is nothing meaningful to draw. */
export function clampFraction(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (value <= 0) return null;
  return Math.min(value, 1);
}

/** Whole-percent for display. Never rounds a started item down to 0%. */
export function progressPercent(
  value: number | null | undefined,
): number | null {
  const fraction = clampFraction(value);
  if (fraction == null) return null;
  return Math.max(1, Math.round(fraction * 100));
}

/** `18:24` / `1:02:11` — playback position, where "18m" would lose the seconds. */
export function formatClock(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// ---------------------------------------------------------------------------
// In-flight actions
// ---------------------------------------------------------------------------

/** Where a card's action has got to. One grab is in flight at a time, per card. */
export type ActionStatus = "idle" | "pending" | "done" | "error";

/**
 * The button text for an action in a given status.
 *
 * A grab takes tens of seconds and then hands off to the client, so the button
 * has to keep telling the truth the whole way through: a control that still
 * says "Download" after a successful grab invites a second, duplicate grab.
 * Navigation actions have no in-flight state of their own — they are links —
 * so they keep their own label throughout.
 */
export function actionLabel(action: CardAction, status: ActionStatus): string {
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
    case "search":
    case "blocked":
      return action.label;
    default:
      return assertNever(action, "actionLabel");
  }
}
