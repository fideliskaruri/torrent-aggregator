import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { InlineStreamPlayer } from "@/components/watch/inline-player";
import type { ProgressEntry } from "@/lib/browse/types";
import { parseEpisode } from "@/lib/torrents/episodes";
import { resumeLookupKey, resumePositionForTarget } from "./resume-progress";
import { useFeatures } from "@/lib/features";

const RESUME_LOOKUP_TIMEOUT_MS = 3_000;

export interface PlayOverlayProps {
  /**
   * `null` means the player opens in its "opening" state — the instant Play is
   * pressed, before the grab has resolved a hash — so a SINGLE loader owns the
   * whole journey with no button→player spinner handoff. The real hash flows in
   * as a prop update (no remount) once the grab returns.
   */
  infoHash: string | null;
  title: string;
  /** Legacy callers may provide an episode code here. */
  subtitle?: string | null;
  episodeTitle?: string | null;
  episodeTitles?: Readonly<Record<string, string>>;
  season?: number | null;
  episode?: number | null;
  /**
   * The work's release year, when the opener knows it. Passed straight through
   * to the player so the quality selector can tell this film from every other
   * film that shares its name.
   */
  year?: number | null;
  /** Where playback got to last time, so the viewer can seek back to it. */
  resumePositionSec?: number | null;
  onClose: () => void;
}

/**
 * The playback surface. Press Watch, get the picture.
 *
 * This used to be a `max-w-4xl` card: a dialog containing a header, a bordered
 * panel, and inside that the player's own disclosure widget with its Play
 * toggle. Four nested boxes around a letterboxed video, on a page whole point
 * is the video. Watching is what the product is for and it was the smallest
 * thing on screen, under a primary button that read "Hide player".
 *
 * So there is no card. The overlay is the picture, edge to edge, and the only
 * chrome is what you need to leave: a title and a close control that sit over
 * the top of the frame rather than stealing height from it. Everything the old
 * header carried — the copy-stream-URL escape hatch, the reassurance line —
 * was furniture around a video, and furniture around a video is the thing we
 * are removing.
 */
export function PlayOverlay(props: PlayOverlayProps) {
  const { streaming } = useFeatures();
  return streaming ? <EnabledPlayOverlay {...props} /> : null;
}

function EnabledPlayOverlay({
  infoHash,
  title,
  subtitle,
  episodeTitle,
  episodeTitles,
  season,
  episode,
  year,
  resumePositionSec,
  onClose,
}: PlayOverlayProps) {
  const parsedEpisode = useMemo(
    () => (subtitle ? parseEpisode(subtitle) : null),
    [subtitle],
  );
  const resolvedSeason = season ?? parsedEpisode?.season;
  const resolvedEpisode = episode ?? parsedEpisode?.episode;
  const lookupKey =
    infoHash === null
      ? null
      : resumeLookupKey(infoHash, {
          season: resolvedSeason,
          episode: resolvedEpisode,
        });
  const [lookedUpResume, setLookedUpResume] = useState<{
    key: string;
    positionSec: number | null;
  } | null>(null);
  const needsResumeLookup = resumePositionSec === undefined && infoHash !== null;
  const resumeLookupReady =
    !needsResumeLookup || lookedUpResume?.key === lookupKey;
  const playerInfoHash = resumeLookupReady ? infoHash : null;
  const playerResumeSec =
    resumePositionSec !== undefined
      ? resumePositionSec
      : lookedUpResume?.key === lookupKey
        ? lookedUpResume.positionSec
        : null;

  useEffect(() => {
    if (!needsResumeLookup || !infoHash || !lookupKey) return;

    const controller = new AbortController();
    let disposed = false;
    const timeoutId = window.setTimeout(
      () => controller.abort(),
      RESUME_LOOKUP_TIMEOUT_MS,
    );
    void fetch(
      `/api/progress?active=1&infoHash=${encodeURIComponent(infoHash)}`,
      { signal: controller.signal },
    )
      .then(async (response) => {
        if (!response.ok) return [];
        const data = (await response.json()) as { entries?: ProgressEntry[] };
        return Array.isArray(data.entries) ? data.entries : [];
      })
      .then((entries) => {
        if (disposed) return;
        setLookedUpResume({
          key: lookupKey,
          positionSec: resumePositionForTarget(entries, {
            season: resolvedSeason,
            episode: resolvedEpisode,
          }),
        });
      })
      .catch(() => {
        if (disposed) return;
        setLookedUpResume({ key: lookupKey, positionSec: null });
      })
      .finally(() => window.clearTimeout(timeoutId));

    return () => {
      disposed = true;
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [
    infoHash,
    lookupKey,
    needsResumeLookup,
    resolvedEpisode,
    resolvedSeason,
  ]);

  // A Radix dialog, always open while mounted: callers mount this component
  // to play and unmount it to stop. It owns the focus trap, Escape, the scroll
  // lock and returning focus to whatever pressed Play.
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
        <DialogContent
          data-play-overlay
          aria-describedby={undefined}
          showCloseButton={false}
          className="inset-0 top-0 left-0 z-[60] flex h-dvh w-full max-w-none translate-x-0 translate-y-0 items-center justify-center gap-0 rounded-none bg-black p-0 text-white ring-0 sm:max-w-none data-open:zoom-in-100 data-closed:zoom-out-100"
        >
          <DialogTitle className="sr-only">{`Play ${title}`}</DialogTitle>
          {/*
            The frame, and nothing else. `max-h`/`max-w` in viewport units rather
            than a fixed pixel width: the constraint on a video is the screen it
            is being watched on, not a breakpoint.
          */}
          <div
            className="relative flex h-full w-full max-h-[100dvh] max-w-[100vw] flex-col justify-center"
            // The black around the picture is the backdrop: a press on it
            // (not on the player) closes, as it always has.
            onClick={(event) => {
              if (event.target === event.currentTarget) onClose();
            }}
          >
            {/*
              Chrome sits *over* the picture. Anything in normal flow above the
              video takes height from it, and height is the whole budget.
            */}
            <div className="pointer-events-none absolute right-0 top-0 z-50 flex items-start p-3 sm:p-4">
              <DialogClose asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Close"
                  className="pointer-events-auto rounded-full bg-black/50 text-white/80 hover:bg-black/70 hover:text-white dark:hover:bg-black/70"
                >
                  <X aria-hidden />
                </Button>
              </DialogClose>
            </div>

            <InlineStreamPlayer
              infoHash={playerInfoHash}
              title={title}
              episodeTitle={episodeTitle}
              episodeTitles={episodeTitles}
              year={year}
              season={resolvedSeason}
              episode={resolvedEpisode}
              resumeSec={playerResumeSec ?? undefined}
              chrome="theatre"
              className="min-h-0"
            />
          </div>
        </DialogContent>
    </Dialog>
  );
}
