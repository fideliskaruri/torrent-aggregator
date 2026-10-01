/**
 * "Downloads at once": one − / number / + stepper for Settings (inside its
 * form, saved with the form) and the Downloads status line (saved on its own,
 * see `app/downloads/use-max-active.ts`). Both write the same server field.
 */
import { useState } from "react";
import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** The server's bounds (`DownloadLimits.MinActiveDownloads` and `MaxActiveDownloads`). */
export const MIN_ACTIVE_DOWNLOADS = 1;
export const MAX_ACTIVE_DOWNLOADS = 20;

/** A whole number inside the server's bounds, or `fallback` when `value` isn't a number. */
export function clampMaxActive(value: number, fallback: number): number {
  return Number.isFinite(value)
    ? Math.min(MAX_ACTIVE_DOWNLOADS, Math.max(MIN_ACTIVE_DOWNLOADS, Math.trunc(value)))
    : fallback;
}

export function MaxActiveDownloadsControl({
  value,
  onChange,
  variant = "field",
  id,
  describedBy,
  className,
}: {
  /** NaN while the Settings box is empty mid-edit. */
  value: number;
  onChange: (next: number) => void;
  /** `field` has a number box to type in; `inline` sits in a line of text. */
  variant?: "field" | "inline";
  /** The number box's id, for the form label (field only). */
  id?: string;
  describedBy?: string;
  className?: string;
}) {
  const known = Number.isFinite(value);
  const atMin = known && value <= MIN_ACTIVE_DOWNLOADS;
  const atMax = known && value >= MAX_ACTIVE_DOWNLOADS;
  const inline = variant === "inline";
  // The number box only echoes typing, so presses are read out here.
  const [announced, setAnnounced] = useState("");
  const step = (delta: number) => {
    const next = clampMaxActive((known ? value : MIN_ACTIVE_DOWNLOADS) + delta, MIN_ACTIVE_DOWNLOADS);
    onChange(next);
    if (!inline) setAnnounced(`${next} at once`);
  };
  const buttonSize = inline ? "icon-sm" : "icon";
  const buttonClass = inline ? "size-7" : undefined;
  const iconClass = inline ? "size-3.5" : undefined;

  // aria-disabled rather than disabled at the bounds: a button that disables
  // itself under the pointer drops keyboard focus to the page.
  return (
    <div
      role="group"
      aria-label="Downloads at once"
      className={cn(
        "inline-flex shrink-0 items-center whitespace-nowrap rounded-lg border border-input bg-background dark:bg-input/30",
        className,
      )}
      data-max-active-control={variant}
    >
      <Button
        type="button"
        variant="ghost"
        size={buttonSize}
        className={cn("rounded-r-none", buttonClass)}
        aria-label="One fewer download at once"
        aria-disabled={atMin || undefined}
        onClick={() => {
          if (!atMin) step(-1);
        }}
        data-max-active-dec
      >
        <Minus aria-hidden className={iconClass} />
      </Button>
      {inline ? (
        <span
          aria-live="polite"
          className="min-w-6 text-center text-[13px] font-medium tabular-nums text-foreground"
          data-max-active-value
        >
          {known ? value : null}
        </span>
      ) : (
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={MIN_ACTIVE_DOWNLOADS}
          max={MAX_ACTIVE_DOWNLOADS}
          step={1}
          value={known ? value : ""}
          onChange={(event) => onChange(event.target.valueAsNumber)}
          aria-describedby={describedBy}
          className="h-9 w-14 scroll-mb-32 border-x border-input bg-transparent text-center text-base tabular-nums text-foreground outline-none [appearance:textfield] focus-visible:ring-3 focus-visible:ring-ring/50 max-md:min-h-11 pointer-coarse:min-h-11 md:text-sm [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          data-max-active-downloads
        />
      )}
      {inline ? null : (
        <span className="sr-only" aria-live="polite">
          {announced}
        </span>
      )}
      <Button
        type="button"
        variant="ghost"
        size={buttonSize}
        className={cn("rounded-l-none", buttonClass)}
        aria-label="One more download at once"
        aria-disabled={atMax || undefined}
        onClick={() => {
          if (!atMax) step(1);
        }}
        data-max-active-inc
      >
        <Plus aria-hidden className={iconClass} />
      </Button>
    </div>
  );
}