"use client";

import { AlertCircle, Check, Download, Zap } from "lucide-react";
import type { AvailabilityState } from "@/lib/browse";
import { cn } from "@/lib/utils";
import {
  availabilityMeta,
  type AvailabilityTone,
  type Unresolved,
} from "./availability";

/**
 * The state of a title, in one word and a glyph.
 *
 * Colour is a reinforcement, never the message: the chip always carries the
 * word *and* a shape, so it reads the same to a colour-blind user, in a
 * screenshot, and through a screen reader. Backgrounds are mixed from the theme
 * tokens rather than eyeballed, and stay opaque because a chip sits on top of
 * poster art of unknown brightness.
 *
 * Both maps below are keyed by a whole union, so a state added upstream is a
 * compile error here rather than a chip that silently renders blank.
 */
const TONE_CLASS: Record<AvailabilityTone, string> = {
  success:
    "text-[var(--success)] [background:color-mix(in_srgb,var(--success)_16%,var(--bg-elevated))] [border-color:color-mix(in_srgb,var(--success)_28%,var(--border))]",
  accent:
    "text-[var(--accent-text)] [background:color-mix(in_srgb,var(--accent)_18%,var(--bg-elevated))] [border-color:var(--accent-border)]",
  info: "text-[var(--info)] [background:color-mix(in_srgb,var(--info)_14%,var(--bg-elevated))] [border-color:color-mix(in_srgb,var(--info)_26%,var(--border))]",
  secondary:
    "text-[var(--text-secondary)] bg-[var(--bg-elevated)] border-[var(--border-strong)]",
  tertiary:
    "text-[var(--text-tertiary)] bg-[var(--bg-elevated)] border-[var(--border)]",
};

const STATE_ICON: Record<AvailabilityState, typeof Check> = {
  ready: Check,
  warm: Zap,
  fetchable: Download,
  unavailable: AlertCircle,
};

export function AvailabilityChip({
  state,
  className,
  compact = false,
}: {
  /** `null` is the unresolved answer, not missing data. */
  state: AvailabilityState | Unresolved;
  className?: string;
  /** Icon-first, tighter padding — for the corner of a poster. */
  compact?: boolean;
}) {
  const meta = availabilityMeta(state);

  // "Can get" is not a state worth a chip. It only says a viable release
  // exists — which the Play/Download action right next to it already offers —
  // so as a badge it is the app narrating its own plumbing. The title hero
  // suppresses it for this exact reason; doing it here at the shared seam means
  // the word never appears on rail cards, episode rows, or the browse hero
  // either. The meaningful states (Ready, Playable, Unavailable) still render.
  if (state === "fetchable") return null;

  // "Nobody checked yet" is a normal, expected answer — not a warning — and it
  // was true of nearly every card, so a blue "Not checked" pill was pure noise.
  // Render it as a faint dot: present enough to mark the unknown, quiet enough
  // to disappear next to a real Ready / Unavailable badge. The word still
  // reaches assistive tech and the hover title.
  if (state === null) {
    return (
      <span
        data-availability="unresolved"
        title={meta.label}
        className={cn(
          "inline-flex items-center justify-center",
          compact ? "h-4 w-4" : "h-5 w-5",
          className,
        )}
      >
        <span
          className="h-1.5 w-1.5 rounded-full bg-[var(--text-tertiary)] opacity-60"
          aria-hidden
        />
        <span className="sr-only">{meta.label}</span>
      </span>
    );
  }

  const Icon = STATE_ICON[state];

  return (
    <span
      data-availability={state ?? "unresolved"}
      title={meta.description ?? undefined}
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-[5px] border font-medium leading-none",
        compact ? "px-1.5 py-1 text-[11px]" : "px-2 py-1 text-[12px]",
        TONE_CLASS[meta.tone],
        className,
      )}
    >
      <Icon className="h-3 w-3 shrink-0" strokeWidth={2.25} aria-hidden />
      <span className="truncate">{meta.label}</span>
      {/* No sentence means no node: an empty ` — ` reads aloud as a dangling
          dash, and a `title` of "" is a tooltip that flashes and says nothing. */}
      {meta.description ? (
        <span className="sr-only"> — {meta.description}</span>
      ) : null}
    </span>
  );
}
