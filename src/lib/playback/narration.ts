/**
 * Structured playback narration — facts in, words out.
 *
 * WHY THE SPLIT
 * -------------
 * `docs/handover.md` §3 and commit `badaf94` are blunt: the engine must never
 * write English. It used to emit `Download started (12% - 1 peers) -> C:\path`
 * as a finished sentence that the UI rendered verbatim — leaking a Windows path
 * into user copy and getting the pluralisation wrong, because copy written
 * where the bytes are counted has no idea where it will be shown. The fix was
 * to emit **structured facts** and let the presentation layer format them.
 *
 * The failover feature obeys the same rule. The engine/watchdog produces a
 * {@link PlaybackNarration} — a discriminated union of *states*, carrying only
 * facts (counts, names) — and {@link describePlayback} here is the single seam
 * that turns a state into the two things a viewer actually wants to know: will
 * this play, and what happens next. The UI renders these strings; it must never
 * see a peer count or an absolute path standing in for an explanation.
 */

/**
 * Why a source was left, or why every source failed.
 *
 * The field report showed two distinct dead-ends that must not collapse into one
 * generic error, because the honest sentence differs for each:
 *   - `delivery`    → the swarm connected but delivered no bytes (the stall this
 *                     watchdog detects). "This source stalled."
 *   - `playability` → the bytes arrive fine but the browser cannot decode this
 *                     release. "Your device can’t play this one." A healthy swarm
 *                     does not save an undecodable file.
 *
 * Exhaustion (every candidate tried, none worked) is its own terminal *phase*,
 * and it carries the dominant cause so the terminal sentence stays honest about
 * *why* nothing worked rather than flattening to "error".
 */
export type FailureCause = "delivery" | "playability";

/**
 * A playback state, as facts. Never a sentence.
 *
 * These are *states*, not mechanism: "stalled, switching" and "exhausted" are
 * answers to "what happens next", where a bare spinner or a peer count is not.
 */
export type PlaybackNarration =
  /** We have committed to a source and are waiting for the first bytes to play. */
  | { phase: "starting"; attempt: number }
  /** Bytes are flowing; playback is possible or underway. */
  | { phase: "playing" }
  /**
   * The current source failed and we are moving to another release of the same
   * content. `cause` says why we left it (delivery vs playability) so the UI can
   * write the right sentence. `triedCount` sources have now been abandoned.
   */
  | { phase: "switching"; cause: FailureCause; triedCount: number; nextName: string | null }
  /**
   * Every candidate has been tried and none worked. This is a terminal, honest
   * answer — not a spinner. `cause` is the dominant reason none worked (nothing
   * delivered vs nothing the browser could play); `triedCount` is how many were
   * attempted.
   */
  | { phase: "exhausted"; cause: FailureCause; triedCount: number }
  /**
   * The current source has stalled, but the user pinned it (chose it
   * explicitly), so we are NOT switching automatically. The selector should
   * offer the choice; we do not take it away.
   */
  | { phase: "stalled-held" };

/** The words a viewer sees. `detail` is optional supporting copy. */
export interface PlaybackCopy {
  /** One-line answer to "will this play / what is happening". */
  headline: string;
  /** Optional second line. Never contains a path, a rate, or a peer count. */
  detail?: string;
}

/**
 * Turn a structured narration into viewer-facing words.
 *
 * This is the *only* place these strings live. Pluralisation ("1 other source"
 * vs "2 other sources") is correct by construction here, exactly as `1 peer`
 * became correct once it was formatted at the presentation seam rather than at
 * the engine.
 */
export function describePlayback(state: PlaybackNarration): PlaybackCopy {
  switch (state.phase) {
    case "starting":
      return state.attempt <= 1
        ? { headline: "Starting playback…" }
        : { headline: "Trying another source…" };

    case "playing":
      return { headline: "Playing" };

    case "switching": {
      const target = state.nextName
        ? `Switching to “${state.nextName}”.`
        : "Switching to another release.";
      const headline =
        state.cause === "playability"
          ? "Your device can’t play this one — trying another…"
          : "This source stalled — trying another…";
      return { headline, detail: target };
    }

    case "exhausted": {
      const n = Math.max(1, state.triedCount);
      const sources = n === 1 ? "the only source" : `all ${n} sources`;
      const detail =
        state.cause === "playability"
          ? `We tried ${sources} we could find and none were ones your device can play. Try again later.`
          : `We tried ${sources} we could find and none were delivering. Try again later.`;
      const headline =
        state.cause === "playability"
          ? "Couldn’t play this — nothing your device supports right now"
          : "Couldn’t start this — no working source right now";
      return { headline, detail };
    }

    case "stalled-held":
      return {
        headline: "The source you chose has stalled",
        detail: "It isn’t delivering right now. Pick another quality to switch, or keep waiting.",
      };
  }
}
