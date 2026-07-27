"use client";

import { useEffect, useMemo, useState } from "react";
import type { Artwork } from "@/lib/metadata/artwork";
import {
  distinctArtworkQueries,
  type ReleaseArtworkQuery,
} from "@/lib/metadata/release-art";

/**
 * Artwork for a list of release names, fetched once per work.
 *
 * The rules this exists to enforce, all of which were broken somewhere before:
 *
 *  - **Never per row.** A rail with three episodes of one show fires one
 *    lookup, because `distinctArtworkQueries` collapses them to one key first.
 *  - **Never on render.** The request happens in an effect keyed on the set of
 *    works, so re-renders from polling, filtering or sorting are free.
 *  - **Never twice per session.** Answers land in a module-level cache, so
 *    navigating Client → Activity → Client does not re-ask, and the Client
 *    page's five-second poll costs nothing after the first pass.
 *
 * Returns a lookup keyed by `ReleaseArtworkQuery.key`. Missing key means "no
 * art" — which is the normal case for obscure releases, not an error.
 */

/** Survives navigation between surfaces; cleared only by a full reload. */
const cache = new Map<string, Artwork>();
/** Keys already on the wire, so two mounted surfaces cannot ask twice. */
const inFlight = new Set<string>();
/**
 * Everyone currently rendering artwork.
 *
 * De-duplication and "tell me when it lands" are the same problem: if one
 * surface skips a fetch because another already has that key in flight, it has
 * no other way to hear the answer and would sit on letter tiles until the next
 * navigation.
 */
const subscribers = new Set<() => void>();

function announce() {
  for (const notify of [...subscribers]) notify();
}

const EMPTY: Record<string, Artwork> = {};

async function fetchArtwork(queries: ReleaseArtworkQuery[]): Promise<void> {
  const res = await fetch("/api/artwork", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      items: queries.map(({ title, year, mediaType }) => ({
        title,
        year,
        mediaType,
      })),
    }),
  });
  if (!res.ok) throw new Error(`artwork ${res.status}`);
  const body = (await res.json()) as { artwork?: Record<string, Artwork> };
  for (const query of queries) {
    // Record the miss too. Without this, a release with no art re-queries on
    // every poll forever.
    cache.set(query.key, body.artwork?.[query.key] ?? { posterUrl: null, backdropUrl: null });
  }
}

export function useReleaseArtwork(
  releases: readonly { name: string; category?: string | null }[],
): Record<string, Artwork> {
  const queries = useMemo(() => distinctArtworkQueries(releases), [releases]);
  // Effects must not depend on a fresh array identity every render.
  const signature = queries.map((q) => q.key).join("|");
  // Bumped when a fetch settles. It has to be a memo dependency as well as a
  // re-render trigger: the cache lives outside React, so without it the memo
  // below is asked to recompute from unchanged inputs and hands back the empty
  // map it built before the answer arrived — every row a letter tile forever.
  const [tick, force] = useState(0);

  useEffect(() => {
    const bump = () => force((n) => n + 1);
    subscribers.add(bump);

    const wanted = queries.filter((q) => !cache.has(q.key) && !inFlight.has(q.key));
    if (!wanted.length) {
      // Nothing to ask for — but another surface may have filled the cache
      // while this one was mounting, so still take a look.
      bump();
      return () => {
        subscribers.delete(bump);
      };
    }

    for (const q of wanted) inFlight.add(q.key);
    fetchArtwork(wanted)
      .catch(() => {
        // A failed lookup must not poison the cache: leaving the keys absent
        // lets a later mount retry, and the page renders letter tiles now.
      })
      .finally(() => {
        for (const q of wanted) inFlight.delete(q.key);
        announce();
      });

    return () => {
      subscribers.delete(bump);
    };
    // `signature` is the real dependency; `queries` is derived from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  return useMemo(() => {
    if (!queries.length) return EMPTY;
    const out: Record<string, Artwork> = {};
    for (const q of queries) {
      const hit = cache.get(q.key);
      if (hit) out[q.key] = hit;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, tick]);
}

/** Test seam and a way for a caller to drop stale art. Not used in render. */
export function __resetReleaseArtworkCache() {
  cache.clear();
  inFlight.clear();
  subscribers.clear();
}
