"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { InlineStreamPlayer } from "@/components/watch/inline-player";

export interface PlayOverlayProps {
  infoHash: string;
  title: string;
  subtitle?: string | null;
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
export function PlayOverlay({
  infoHash,
  title,
  subtitle,
  resumePositionSec,
  onClose,
}: PlayOverlayProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    const restoreTo = document.activeElement as HTMLElement | null;

    // Lock the *document element*, not `body`: `html` carries `overflow-x:
    // hidden`, which stops the UA propagating body's overflow to the viewport,
    // so `body { overflow: hidden }` here would be a no-op and the page would
    // scroll behind the dialog. `scrollbar-gutter: stable` keeps this from
    // shifting the layout sideways.
    const root = document.documentElement;
    const previousOverflow = root.style.overflow;
    root.style.overflow = "hidden";

    const focusables = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), video, [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((el) => el.offsetParent !== null);

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const head = items[0];
      const tail = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (!dialog?.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? tail : head).focus();
      } else if (event.shiftKey && active === head) {
        event.preventDefault();
        tail.focus();
      } else if (!event.shiftKey && active === tail) {
        event.preventDefault();
        head.focus();
      }
    };

    document.addEventListener("keydown", onKey, true);

    focusables()[0]?.focus();

    return () => {
      document.removeEventListener("keydown", onKey, true);
      root.style.overflow = previousOverflow;
      if (restoreTo && document.contains(restoreTo)) restoreTo.focus();
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label={`Play ${title}`}
      ref={dialogRef}
      data-play-overlay
    >
      <button
        type="button"
        tabIndex={-1}
        aria-label="Close player"
        onClick={onClose}
        className="absolute inset-0 bg-black"
      />

      {/*
        The frame, and nothing else. `max-h`/`max-w` in viewport units rather
        than a fixed pixel width: the constraint on a video is the screen it is
        being watched on, not a breakpoint. A card class here is what made a
        16:9 picture occupy a third of a 1400px display.
      */}
      <div className="relative flex h-full w-full max-h-[100dvh] max-w-[100vw] flex-col justify-center">
        {/*
          Chrome sits *over* the picture. Anything in normal flow above the
          video takes height from it, and height is the whole budget.
          `pointer-events-none` on the strip with `auto` on the controls keeps
          the area beside the close button clickable as backdrop-to-dismiss.
        */}
        <div className="pointer-events-none absolute right-0 top-0 z-50 flex items-start p-3 sm:p-4">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="pointer-events-auto inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-black/50 text-white/80 transition-colors hover:bg-black/70 hover:text-white"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <InlineStreamPlayer
          infoHash={infoHash}
          title={title}
          resumeSec={resumePositionSec ?? undefined}
          chrome="theatre"
          className="min-h-0"
        />
      </div>
    </div>
  );
}
