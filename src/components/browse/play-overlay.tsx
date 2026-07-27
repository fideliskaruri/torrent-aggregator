"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { InlineStreamPlayer } from "@/components/watch/inline-player";
import { formatClock } from "./availability";

export interface PlayOverlayProps {
  infoHash: string;
  title: string;
  subtitle?: string | null;
  /** Where playback got to last time, so the viewer can seek back to it. */
  resumePositionSec?: number | null;
  onClose: () => void;
}

/**
 * Full-screen playback surface for a browse card.
 *
 * The player itself belongs to `components/watch` and is shared with Client and
 * Library; browse mounts it rather than forking a second one. It owns its own
 * disclosure state and takes no "start expanded" prop, so the effect below
 * presses its toggle once — clicking a card *is* an explicit "play this", and
 * making the user press a second Play would be the whole point of the redesign
 * undone. If that toggle ever disappears the user simply sees the player's own
 * button, which is why this is a nudge and not a requirement.
 */
export function PlayOverlay({
  infoHash,
  title,
  subtitle,
  resumePositionSec,
  onClose,
}: PlayOverlayProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const resumeAt = formatClock(resumePositionSec);

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

    const toggle = dialog?.querySelector<HTMLButtonElement>(
      "[data-stream-play-toggle]",
    );
    if (toggle?.getAttribute("aria-expanded") === "false") toggle.click();
    (toggle ?? focusables()[0])?.focus();

    return () => {
      document.removeEventListener("keydown", onKey, true);
      root.style.overflow = previousOverflow;
      if (restoreTo && document.contains(restoreTo)) restoreTo.focus();
    };
  }, [onClose, infoHash]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center"
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
        className="absolute inset-0 bg-black/70"
      />

      <div
        className="relative flex max-h-[92dvh] w-full max-w-4xl flex-col overflow-y-auto rounded-t-xl border border-[var(--border)] bg-[var(--bg-elevated)] shadow-[var(--shadow-md)] sm:rounded-[var(--radius)]"
        style={{ paddingBottom: "var(--safe-bottom)" }}
      >
        <div className="flex items-start gap-3 border-b border-[var(--border)] p-3 sm:p-4">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-[var(--text)]">
              {title}
            </p>
            <p className="mt-0.5 text-[12px] text-[var(--text-tertiary)]">
              {[subtitle, resumeAt ? `You stopped at ${resumeAt}` : null]
                .filter(Boolean)
                .join(" · ") || "Streaming from your own machine"}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-muted)] hover:text-[var(--text)]"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="p-3 sm:p-4">
          <InlineStreamPlayer infoHash={infoHash} title={title} />
        </div>
      </div>
    </div>
  );
}
