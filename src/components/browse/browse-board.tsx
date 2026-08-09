"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import type { BrowsePayload, RailItem } from "@/lib/browse";
import {
  cleanDisplayTitle,
  type ActionStatus,
  type CardAction,
} from "./availability";
import { RAIL_PREVIEWS, missingRailPreviews } from "./first-run";
import { HeroBanner } from "./hero-banner";
import { pickHeroItem } from "./hero";
import { PlayOverlay } from "./play-overlay";
import { Rail } from "./rail";

interface NowPlaying {
  infoHash: string | null;
  title: string;
  subtitle: string | null;
  season: number | null;
  episode: number | null;
  resumePositionSec: number | null;
}

/**
 * The browse page's one piece of state.
 *
 * Cards and the hero are deliberately dumb: they render an action and report a
 * click. Everything that can fail — opening the player, asking for a grab —
 * lands here, so there is a single place that knows what is in flight and a
 * single place a duplicate grab could be prevented.
 */
export function BrowseBoard({ payload }: { payload: BrowsePayload }) {
  const [statuses, setStatuses] = useState<Record<string, ActionStatus>>({});
  const [playing, setPlaying] = useState<NowPlaying | null>(null);

  const hero = useMemo(() => pickHeroItem(payload.rails), [payload.rails]);

  const runAction = useCallback(
    async (item: RailItem, action: CardAction) => {
      if (action.kind === "play") {
        // Play plays. Open the overlay immediately on the hash we have. If the
        // engine no longer holds it the stream 404s, so we re-fetch in the
        // background and hand the fresh hash in as a prop update — the player
        // never dead-ends on "download it first, then play".
        setPlaying({
          infoHash: action.infoHash,
          title: cleanDisplayTitle(item.title),
          subtitle: item.subtitle,
          season: item.season ?? null,
          episode: item.episode ?? null,
          resumePositionSec: action.resumePositionSec,
        });

        // `warm`/`ready` means the engine answered for it moments ago. Anything
        // else (notably Continue Watching's stale hash) gets a refetch.
        if (item.availability === "ready" || item.availability === "warm") return;

        try {
          const res = await fetch("/api/library/ondemand", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              watchListItemId: item.watchListItemId ?? undefined,
              title: cleanDisplayTitle(item.title),
              mediaType: item.mediaType ?? undefined,
              season: item.season ?? undefined,
              episode: item.episode ?? undefined,
              retention: "stream",
              protectHashes: [action.infoHash],
            }),
          });
          const data = (await res.json().catch(() => null)) as {
            ok?: boolean;
            infoHash?: string | null;
          } | null;
          if (res.ok && data?.infoHash && data.infoHash !== action.infoHash) {
            setPlaying((prev) =>
              prev ? { ...prev, infoHash: data.infoHash! } : prev,
            );
          }
        } catch {
          // The player owns its own failure copy from here.
        }
        return;
      }
      if (action.kind !== "get") return;
      if (statuses[item.id] === "pending") return;

      const label = cleanDisplayTitle(item.title);
      setStatuses((prev) => ({ ...prev, [item.id]: "pending" }));
      try {
        const res = await fetch("/api/library/ondemand", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(action.request),
        });
        const data = (await res.json().catch(() => null)) as {
          ok?: boolean;
          message?: string;
        } | null;
        if (!res.ok || data?.ok === false) {
          throw new Error(data?.message ?? `Grab failed (${res.status})`);
        }
        setStatuses((prev) => ({ ...prev, [item.id]: "done" }));
        toast.success(`Grabbing ${label}`, {
          description: item.subtitle
            ? `${item.subtitle} — sent to your client.`
            : "Sent to your client.",
        });
      } catch (err) {
        setStatuses((prev) => ({ ...prev, [item.id]: "error" }));
        toast.error(`Could not grab ${label}`, {
          description: err instanceof Error ? err.message : undefined,
        });
      }
    },
    [statuses],
  );

  return (
    <>
      {hero ? (
        <HeroBanner
          pick={hero}
          status={statuses[hero.item.id]}
          onAction={runAction}
        />
      ) : null}

      <div className="container-app min-w-0 pb-14" data-browse-board>
        {payload.rails.map((rail, index) => (
          <Rail
            key={rail.id}
            rail={rail}
            index={index}
            statuses={statuses}
            onAction={runAction}
          />
        ))}
        <MissingRailsNote rails={payload.rails} />
      </div>

      {playing ? (
        <PlayOverlay
          infoHash={playing.infoHash}
          title={playing.title}
          subtitle={playing.subtitle}
          season={playing.season}
          episode={playing.episode}
          resumePositionSec={playing.resumePositionSec}
          onClose={() => setPlaying(null)}
        />
      ) : null}
    </>
  );
}

/**
 * The partially-empty page: some rails populated, some not.
 *
 * An empty rail is omitted rather than drawn, because a rail heading is a
 * promise of contents and a title over blank space is both a broken promise
 * and pure vertical noise between two rows that do have something. But
 * omitting it silently teaches nothing — the user cannot tell whether "Next
 * Up" is empty or does not exist — so the rails that are missing are named
 * once, compactly, at the bottom, where they cannot interrupt real content.
 *
 * Renders nothing when every rail is populated, and nothing on a first run
 * either: with no rails at all the whole page is already the first-run state,
 * and a footer listing all five would be saying it twice.
 */
function MissingRailsNote({ rails }: { rails: BrowsePayload["rails"] }) {
  const missing = useMemo(() => missingRailPreviews(rails), [rails]);
  if (!missing.length || missing.length === RAIL_PREVIEWS.length) return null;

  return (
    <section
      data-missing-rails
      aria-labelledby="missing-rails-title"
      className="mt-8 border-t border-[var(--border)] pt-6"
    >
      <h2
        id="missing-rails-title"
        className="text-[13px] font-medium text-[var(--text-secondary)]"
      >
        Not showing yet
      </h2>
      <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {missing.map((preview) => (
          <li key={preview.id} className="surface flex flex-col gap-1.5 p-3.5">
            <span className="text-[13px] font-medium text-[var(--text)]">
              {preview.title}
            </span>
            <span className="text-[12px] leading-relaxed text-[var(--text-tertiary)]">
              {preview.blurb}
            </span>
            <Link
              href={preview.href}
              className="mt-auto inline-flex items-center self-start min-h-[44px] pt-1 text-[12px] text-[var(--accent-text)] underline-offset-4 transition-colors hover:text-[var(--accent-hover)] hover:underline lg:min-h-0"
            >
              {preview.cta}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
