"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn, formatBytes } from "@/lib/utils";

/**
 * Live swarm health, shown for the whole time a file is playing.
 *
 * The question a viewer actually has while a torrent stutters is "is this going
 * to recover, or should I give up?" — and until now the app answered it with
 * nothing at all. Two numbers answer it: how many peers are connected, and how
 * fast bytes are arriving.
 *
 * Three rules this component exists to keep:
 *
 *  1. **It never invents a number.** The engine reports connected peers only —
 *     WebTorrent cannot distinguish a seed from a leech — so this says "peers",
 *     never "seeders". When a value is missing it renders "unknown"; it does not
 *     render 0, and it does not keep showing the last good sample as if it were
 *     current.
 *  2. **It never competes with playback.** One small JSON GET every
 *     `POLL_MS`, paused entirely while the tab is hidden, aborted on unmount.
 *  3. **Its state comes from responses, not from hope.** A failed or aborted
 *     request moves it to "unknown", the same as a response with null fields.
 */

const POLL_MS = 5_000;

export type SwarmSample = {
  peers: number | null;
  downloadSpeedBps: number | null;
  progress: number | null;
  observedAt: number;
};

/** What the dot means. Deliberately three states, one of which is ignorance. */
export type SwarmHealth = "unknown" | "stalled" | "thin" | "live";

/**
 * `thin` is the honest middle: peers are connected but nothing is arriving
 * *yet*, which happens for several seconds after a seek and is not a failure.
 * Only "no peers at all" is called stalled, because that is the one state the
 * viewer cannot wait out.
 */
export function swarmHealth(sample: SwarmSample | null): SwarmHealth {
  if (!sample) return "unknown";
  const { peers, downloadSpeedBps: rate, progress } = sample;
  if (peers === null && rate === null) return "unknown";
  // A finished torrent is served from disk. Nothing about the swarm can stall
  // it, so 0 peers and 0 B/s are the *expected* readings here and colouring
  // them as trouble would be a warning about a problem that cannot happen.
  if (progress !== null && progress >= 1) return "live";
  if (peers === 0) return "stalled";
  if (rate !== null && rate > 0) return "live";
  if (peers !== null && peers > 0) return "thin";
  return "unknown";
}

export function peerText(peers: number | null): string {
  if (peers === null) return "peers unknown";
  return `${peers} ${peers === 1 ? "peer" : "peers"}`;
}

export function rateText(bps: number | null): string {
  if (bps === null) return "rate unknown";
  return `${formatBytes(bps)}/s`;
}

/** One sentence a screen reader can read out on demand. */
export function swarmSummary(sample: SwarmSample | null): string {
  const health = swarmHealth(sample);
  if (health === "unknown") return "Swarm health unknown — no peer data from the engine.";
  if ((sample?.progress ?? 0) >= 1) {
    return `Download complete — playing from disk. ${peerText(sample?.peers ?? null)} connected.`;
  }
  return `Swarm: ${peerText(sample?.peers ?? null)} connected, ${rateText(
    sample?.downloadSpeedBps ?? null,
  )}.`;
}

const DOT_CLASS: Record<SwarmHealth, string> = {
  unknown: "bg-[var(--text-tertiary)]",
  stalled: "bg-[var(--danger)]",
  // No `--warning` token exists in the theme, so this is spelled out rather
  // than referencing a variable that would resolve to nothing.
  thin: "bg-[#e8a54b]",
  live: "bg-[var(--success)]",
};

type SwarmChipProps = {
  infoHash: string;
  /** Poll only while the player is actually mounted and showing something. */
  active: boolean;
  className?: string;
  /** Test seam: overrides the network fetch. */
  fetchSample?: (signal: AbortSignal) => Promise<SwarmSample | null>;
};

async function defaultFetchSample(
  infoHash: string,
  signal: AbortSignal,
): Promise<SwarmSample | null> {
  // `poll=1` tells the route not to write a diagnostics line for a request the
  // player makes on a timer.
  const res = await fetch(`/api/stream/${encodeURIComponent(infoHash)}?poll=1`, {
    signal,
    cache: "no-store",
  });
  // 425 (metadata still resolving) still carries a swarm block: a viewer waiting
  // on metadata is exactly who needs to know whether any peer answered.
  if (!res.ok && res.status !== 425) return null;
  const body = (await res.json().catch(() => null)) as { swarm?: SwarmSample } | null;
  const swarm = body?.swarm;
  if (!swarm || typeof swarm !== "object") return null;
  return {
    peers: typeof swarm.peers === "number" ? swarm.peers : null,
    downloadSpeedBps:
      typeof swarm.downloadSpeedBps === "number" ? swarm.downloadSpeedBps : null,
    progress: typeof swarm.progress === "number" ? swarm.progress : null,
    observedAt: typeof swarm.observedAt === "number" ? swarm.observedAt : Date.now(),
  };
}

export function SwarmChip({ infoHash, active, className, fetchSample }: SwarmChipProps) {
  /**
   * The sample is stored with the torrent it describes. Rendering compares the
   * two, so switching torrents shows "unknown" immediately rather than another
   * release's peer count — without an effect that resets state on mount, which
   * would cost a cascading render on every poll cycle.
   */
  const [state, setState] = useState<{ key: string; sample: SwarmSample | null }>({
    key: "",
    sample: null,
  });
  const timerRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!active || !infoHash) return;
    const controller = new AbortController();
    let stopped = false;

    const tick = async () => {
      if (stopped) return;
      // A hidden tab has no viewer to inform; skip the request entirely rather
      // than spend a viewer's bandwidth on a chip nobody is looking at.
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        schedule();
        return;
      }
      try {
        const next = fetchSample
          ? await fetchSample(controller.signal)
          : await defaultFetchSample(infoHash, controller.signal);
        if (!stopped) setState({ key: infoHash, sample: next });
      } catch {
        // Including AbortError on unmount, where the setState is skipped anyway.
        if (!stopped) setState({ key: infoHash, sample: null });
      }
      schedule();
    };

    // Self-scheduling rather than setInterval: an interval would queue another
    // request while a slow one is still in flight, which is exactly the kind of
    // pile-up that starts competing with the stream.
    function schedule() {
      if (stopped) return;
      timerRef.current = window.setTimeout(() => void tick(), POLL_MS);
    }

    void tick();

    const onVisible = () => {
      if (document.visibilityState === "visible") {
        clearTimer();
        void tick();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      stopped = true;
      clearTimer();
      controller.abort();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [active, infoHash, clearTimer, fetchSample]);

  if (!active) return null;

  const sample = state.key === infoHash ? state.sample : null;
  const health = swarmHealth(sample);
  const peers = peerText(sample?.peers ?? null);
  const rate = rateText(sample?.downloadSpeedBps ?? null);

  return (
    <span
      data-swarm-chip
      data-swarm-health={health}
      data-swarm-peers={sample?.peers ?? "unknown"}
      data-swarm-rate={sample?.downloadSpeedBps ?? "unknown"}
      role="status"
      // The numbers change every few seconds; announcing each one would make the
      // player unusable with a screen reader. The chip is readable on demand.
      aria-live="off"
      title={swarmSummary(sample)}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--bg-muted)] px-2 py-0.5 text-[11px] text-[var(--text-tertiary)] tabular-nums",
        className,
      )}
    >
      {/* Flex drops whitespace-only text nodes, so every separator a screen
          reader needs is a real element, not a `{" "}`. */}
      <span className="sr-only">Swarm health: </span>
      <span
        aria-hidden="true"
        className={cn("h-1.5 w-1.5 shrink-0 rounded-full", DOT_CLASS[health])}
      />
      <span data-swarm-peers-text>{peers}</span>
      <span className="sr-only">, </span>
      <span aria-hidden="true">·</span>
      <span data-swarm-rate-text>{rate}</span>
    </span>
  );
}
