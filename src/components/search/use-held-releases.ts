"use client";

/**
 * What the engine already holds, so a row can stop offering to fetch it again.
 *
 * ## The bug
 *
 * `ArtifactRow` rendered an enabled **Download** button unconditionally. It had
 * no idea whether the release was already on disk, so a finished download still
 * invited another press — and pressing it sent another grab. The owner reported
 * both halves: *"double downloading"* and *"downloads show ready but download
 * button still clickable.. maybe make it say 'Downloaded' instead"*. They are
 * one defect: a control that does not know its own state.
 *
 * The engine does dedupe by info hash, so a second press does not corrupt
 * anything — but "nothing visibly happens" is exactly the dead-end this app
 * keeps having to remove. The fix is for the button to answer the question the
 * viewer is actually asking: *do I have this already?*
 *
 * ## Why a stream still offers Download
 *
 * Holding a release as a **stream** is not the same as having downloaded it: a
 * stream is reclaimable cache and only the pieces around the playhead were ever
 * fetched. Download is the meaningful action there — it promotes the stream to a
 * kept file and selects the whole thing. So only `kept` suppresses the button;
 * `stream` and `prewarm` keep it, and say so.
 *
 * ## One fetch, shared
 *
 * A list of forty rows must not make forty requests. The state is fetched once
 * per mount and shared through a module-level cache with a short TTL, so
 * switching shelves or reopening the palette is instant and the engine is not
 * polled per keystroke.
 */

import { useCallback, useEffect, useState } from "react";

/** What the engine holds for one info hash. */
export type HeldState = "downloaded" | "downloading" | "queued" | "stream" | "none";

export interface HeldRelease {
  state: HeldState;
  /** 0..1, for the "Downloading… 42%" label. */
  progress: number;
  /** 1-based place in the built-in download queue, when `state` is "queued". */
  queuePosition?: number;
}

type HeldMap = Map<string, HeldRelease>;

const EMPTY: HeldMap = new Map();

/** Cache window. Long enough to cover a scroll, short enough to feel live. */
const TTL_MS = 4000;

let cache: { at: number; value: HeldMap } | null = null;
let inFlight: Promise<HeldMap> | null = null;
const listeners = new Set<(m: HeldMap) => void>();

type ClientTorrentLike = {
  hash?: string | null;
  infoHash?: string | null;
  progress?: number | null;
  retentionState?: string | null;
  status?: string | null;
  state?: string | null;
  queuePosition?: number | null;
};

/**
 * Classify one live torrent.
 *
 * Exported and pure so `use-held-releases.test.ts` can pin the rule class
 * without a DOM or a running engine — the interesting cases are all about which
 * states must NOT suppress the button.
 */
export function classifyHeld(t: ClientTorrentLike): HeldRelease {
  const progress =
    typeof t.progress === "number" && Number.isFinite(t.progress)
      ? Math.max(0, Math.min(1, t.progress))
      : 0;
  const retention = (t.retentionState ?? "").toLowerCase();

  // A stream is reclaimable cache with only the played window fetched, so
  // Download still means something: promote it and take the whole file.
  if (retention === "stream" || retention === "prewarm") {
    return { state: "stream", progress };
  }

  // `unknown` retention is not evidence of anything. Treating it as "kept"
  // would hide the button for a release we cannot vouch for, which is the
  // worse failure: the viewer loses the only way to get the file.
  if (retention !== "kept") return { state: "none", progress };

  if (progress < 1 && (t.state ?? "").trim().toLowerCase() === "queued") {
    const position = t.queuePosition;
    return typeof position === "number" && Number.isFinite(position) && position > 0
      ? { state: "queued", progress, queuePosition: Math.floor(position) }
      : { state: "queued", progress };
  }

  return { state: progress >= 1 ? "downloaded" : "downloading", progress };
}

function toMap(torrents: readonly ClientTorrentLike[]): HeldMap {
  const m: HeldMap = new Map();
  for (const t of torrents) {
    const hash = (t.hash ?? t.infoHash ?? "").trim().toLowerCase();
    if (hash.length !== 40) continue;
    m.set(hash, classifyHeld(t));
  }
  return m;
}

async function fetchHeld(): Promise<HeldMap> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const res = await fetch("/api/client/torrents");
      if (!res.ok) return cache?.value ?? EMPTY;
      const body = (await res.json()) as { torrents?: ClientTorrentLike[] };
      const value = toMap(body.torrents ?? []);
      cache = { at: Date.now(), value };
      for (const fn of listeners) fn(value);
      return value;
    } catch {
      // Never let this break a results list: not knowing simply means every row
      // keeps its ordinary Download button, which is the pre-existing behaviour.
      return cache?.value ?? EMPTY;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Drop the cache so the next read is fresh — call after a successful send. */
export function invalidateHeldReleases(): void {
  cache = null;
}

export function useHeldReleases(): {
  held: HeldMap;
  refresh: () => void;
} {
  const [held, setHeld] = useState<HeldMap>(() => cache?.value ?? EMPTY);

  const refresh = useCallback(() => {
    invalidateHeldReleases();
    void fetchHeld().then(setHeld);
  }, []);

  useEffect(() => {
    let alive = true;
    listeners.add(setHeld);
    void fetchHeld().then((m) => {
      if (alive) setHeld(m);
    });
    return () => {
      alive = false;
      listeners.delete(setHeld);
    };
  }, []);

  return { held, refresh };
}

/** Look up one release. Accepts the loose hash shapes results carry. */
export function heldFor(
  held: HeldMap,
  infoHash: string | null | undefined,
  magnet?: string | null,
): HeldRelease {
  const direct = infoHash?.trim().toLowerCase();
  if (direct && held.has(direct)) return held.get(direct)!;
  const fromMagnet = /urn:btih:([0-9a-fA-F]{40})/.exec(magnet ?? "")?.[1];
  if (fromMagnet) {
    const k = fromMagnet.toLowerCase();
    if (held.has(k)) return held.get(k)!;
  }
  return { state: "none", progress: 0 };
}

/** The button's label and whether it may still be pressed. */
export function downloadControlFor(held: HeldRelease): {
  label: string;
  disabled: boolean;
  /** Spoken form, so a screen reader is not left with a bare adjective. */
  hint: string | null;
} {
  switch (held.state) {
    case "downloaded":
      return { label: "Downloaded", disabled: true, hint: "Already in your library" };
    case "downloading":
      return {
        label: `Downloading ${Math.round(held.progress * 100)}%`,
        disabled: true,
        hint: "Already downloading — see the Client page",
      };
    case "queued":
      return {
        label: held.queuePosition ? `Queued · #${held.queuePosition}` : "Queued",
        disabled: true,
        hint: "Already queued — it starts when a download slot frees up",
      };
    case "stream":
      // Deliberately still pressable: this fetches the rest and keeps it.
      return { label: "Download", disabled: false, hint: "Streamed — download to keep it" };
    default:
      return { label: "Download", disabled: false, hint: null };
  }
}
