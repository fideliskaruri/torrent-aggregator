import { useCallback,useEffect,useMemo,useState } from "react";
import { send } from "@/lib/api";
import type { Artwork } from "@/lib/metadata/artwork";
import {
artworkQueryFor,
artworkQueryForRelease,
distinctArtworkQueries,
type ReleaseArtworkQuery,
type WorkArtworkSource,
} from "@/lib/metadata/release-art";

/**
 * The one artwork source for rows. A row whose payload carries `posterUrl`
 * (transfers, recommendations, notifications, library, requests) uses it as is;
 * only rows without one are looked up.
 *
 * A row is looked up by the work the server matched it to (title, year, type)
 * when it has one, and by its release name otherwise. That is the rule that
 * makes Downloads show the same poster as the title page: the release name of
 * an anime film filed under Movies parsed to a film lookup that missed, while
 * the title page held the AniList cover all along.
 *
 *  - **Never per row.** Rows describing one work collapse to one key first.
 *  - **Never on render.** The request runs in an effect keyed on the set of works.
 *  - **Never twice per session.** Answers, misses included, live in a
 *    module-level cache shared by every surface.
 *  - **A typed miss asks again untyped.** A row's category is a hint, not the
 *    truth: an anime film filed as a movie is found by the untyped lookup,
 *    which still only returns a poster the server can vouch for.
 */

/** Survives navigation between surfaces; cleared only by a full reload. */
const cache = new Map<string, Artwork>();
/** Keys already on the wire, so two mounted surfaces cannot ask twice. */
const inFlight = new Set<string>();
/** Everyone currently rendering artwork, told when a lookup lands. */
const subscribers = new Set<() => void>();

const NONE: Artwork = { posterUrl: null, backdropUrl: null };

function announce() {
  for (const notify of [...subscribers]) notify();
}

async function postArtwork(
  queries: ReleaseArtworkQuery[],
): Promise<Record<string, Artwork>> {
  const res = await send("/api/artwork", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      items: queries.map(({ title, year, mediaType }) => ({ title, year, mediaType })),
    }),
  });
  if (!res.ok) throw new Error(`artwork ${res.status}`);
  const body = (await res.json()) as { artwork?: Record<string, Artwork> };
  return body.artwork ?? {};
}

async function fetchArtwork(queries: ReleaseArtworkQuery[]): Promise<void> {
  const first = await postArtwork(queries);
  const retry = queries.filter((q) => q.mediaType && !first[q.key]?.posterUrl);
  const second = retry.length
    ? await postArtwork(retry.map((q) => ({ ...q, mediaType: null }))).catch(() => ({}) as Record<string, Artwork>)
    : {};
  for (const query of queries) {
    const hit = first[query.key]?.posterUrl ? first[query.key] : second[query.key];
    // Record the miss too, or a release with no art re-queries on every poll.
    cache.set(query.key, hit ?? first[query.key] ?? NONE);
  }
}

export interface WorkArtwork {
  /**
   * Every answer keyed by its work key, plus an alias under each row's
   * release-name key, so a consumer that still keys by release name
   * (`artworkQueryForRelease`) finds the same poster.
   */
  map: Record<string, Artwork>;
  /** The artwork for one row, or undefined while it loads or when there is none. */
  artFor: (source: WorkArtworkSource) => Artwork | undefined;
}

function payloadArt(source: WorkArtworkSource): Artwork | undefined {
  return source.posterUrl ? { posterUrl: source.posterUrl, backdropUrl: null } : undefined;
}

export function useWorkArtwork(sources: readonly WorkArtworkSource[]): WorkArtwork {
  // A poster the server put on the row wins; only rows without one are looked up.
  const queries = useMemo(
    () => distinctArtworkQueries(sources.filter((s) => !s.posterUrl)),
    [sources],
  );
  const signature = queries.map((q) => q.key).join("|");
  // Bumped when a fetch settles. The cache lives outside React, so the memo
  // below needs it as a dependency or it hands back the map it built before the
  // answer arrived.
  const [tick, force] = useState(0);

  useEffect(() => {
    const bump = () => force((n) => n + 1);
    subscribers.add(bump);

    const wanted = queries.filter((q) => !cache.has(q.key) && !inFlight.has(q.key));
    if (!wanted.length) {
      // Another surface may have filled the cache while this one mounted.
      bump();
      return () => {
        subscribers.delete(bump);
      };
    }

    for (const q of wanted) inFlight.add(q.key);
    fetchArtwork(wanted)
      .catch(() => {
        // A failed lookup must not poison the cache: a later mount retries.
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

  const map = useMemo(() => {
    const out: Record<string, Artwork> = {};
    for (const source of sources) {
      const workKey = artworkQueryFor(source).key;
      const hit = payloadArt(source) ?? out[workKey] ?? cache.get(workKey);
      if (!hit) continue;
      if (!out[workKey]?.posterUrl) out[workKey] = hit;
      const releaseKey = artworkQueryForRelease(source.name, source.category).key;
      if (!out[releaseKey]?.posterUrl) out[releaseKey] = hit;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources, signature, tick]);

  const artFor = useCallback(
    (source: WorkArtworkSource) =>
      payloadArt(source) ?? map[artworkQueryFor(source).key] ?? cache.get(artworkQueryFor(source).key),
    [map],
  );

  return { map, artFor };
}
