/**
 * Presentation helpers for swarm measurements shown in settings.
 *
 * Pure and framework-free so the rules that matter — chiefly that `unknown` is
 * never rendered as a bad verdict — can be asserted directly without a DOM.
 *
 * The load-bearing distinction, carried over from the rest of this subsystem:
 * **"not measured" is not "measured and poor".** A swarm we have never
 * established, or whose measurement has gone stale, is `unknown` — absence of
 * evidence, not evidence of absence. It must read visibly differently from a
 * `dead` swarm we actually watched deliver nothing. Collapsing the two would be
 * the same lie this codebase refuses everywhere else.
 */
import type { SwarmVerdict } from "@/lib/torrents/swarm-probe";

/**
 * The visual family a verdict maps to. Deliberately four, not three: `neutral`
 * exists precisely so `unknown` never has to borrow `bad`'s colour.
 */
export type VerdictTone = "good" | "weak" | "bad" | "neutral";

export interface VerdictDisplay {
  tone: VerdictTone;
  /** Short label by effect, not mechanism. */
  label: string;
  /** One plain sentence a viewer can act on. */
  hint: string;
}

/**
 * Map a stored verdict (plus its freshness) to how it should read.
 *
 * `expired` is honoured first: a measurement past its TTL is no longer
 * evidence, so it reads `neutral`/"Not measured" whatever it once said. The
 * store already coerces an expired row's verdict to `unknown`; this is
 * belt-and-braces so the rule holds even if a caller passes a raw verdict.
 */
export function verdictDisplay(
  verdict: SwarmVerdict,
  expired: boolean,
): VerdictDisplay {
  if (expired || verdict === "unknown") {
    return {
      tone: "neutral",
      label: "Not measured",
      hint: "We haven't established this swarm's health yet.",
    };
  }
  switch (verdict) {
    case "good":
      return {
        tone: "good",
        label: "Good",
        hint: "Measured fast enough to start playing right away.",
      };
    case "weak":
      return {
        tone: "weak",
        label: "Slow",
        hint: "Delivering, but too slowly to play smoothly.",
      };
    case "dead":
      return {
        tone: "bad",
        label: "Not delivering",
        hint: "Peers connected but sent us nothing.",
      };
    default: {
      // Exhaustiveness guard: a new verdict must be handled here, not silently
      // fall through to a bad colour.
      const _never: never = verdict;
      return {
        tone: "neutral",
        label: "Not measured",
        hint: "We haven't established this swarm's health yet.",
      };
    }
  }
}

/**
 * A coarse, human "how long ago" for a measurement time. Coarse on purpose —
 * the point is freshness, not precision, and a measurement is a prediction, not
 * a stopwatch.
 */
function relativeAge(measuredAtMs: number, nowMs: number): string {
  const diffMs = Math.max(0, nowMs - measuredAtMs);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * The freshness line for a row: when it was checked, and — when stale — that it
 * can no longer be trusted as current. Never presents an expired measurement as
 * a present-tense fact.
 */
export function freshnessLabel(
  measuredAtMs: number,
  expired: boolean,
  nowMs: number,
): string {
  const age = relativeAge(measuredAtMs, nowMs);
  return expired ? `checked ${age} · stale` : `checked ${age}`;
}
