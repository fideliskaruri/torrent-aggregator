"use client";

/**
 * Quality chooser — the one extra step between pressing Download and sending
 * a keep-it grab to the server.
 *
 * Rules this encodes:
 *   - Only Download asks. Play must never prompt (see quality-picker-state.ts).
 *   - The chooser opens pre-selected on the user's preferred quality so the
 *     common press is one extra click, not a decision.
 *   - "Always use my preferred quality" skips the chooser on future presses.
 *   - We never present a quality as available when we have no evidence for it.
 *     All four choices are shown equally; none claims a release exists behind it.
 *   - Esc cancels (AlertDialog built-in).
 *   - Focus is trapped inside the dialog while open (Radix built-in).
 *   - Opening does not shift the page: Radix adds a scrollbar-width offset to
 *     <body> when it locks scroll, so the layout stays identical.
 *   - Touch targets: each option row is min-h-[44px] (matches the app's rule).
 */
import { useId, useState } from "react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { QUALITY_CHOICES, type QualityValue } from "./quality-picker-state";

export interface QualityPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called when the user confirms a quality. Never called on cancel. */
  onConfirm: (resolution: QualityValue) => void;
  /** The quality pre-selected when the dialog opens. */
  preferredResolution: QualityValue;
  /** Current value of the "always use preferred" preference. */
  alwaysPreferred: boolean;
  onAlwaysPreferredChange: (value: boolean) => void;
}

export function QualityPicker(props: QualityPickerProps) {
  const { open, preferredResolution } = props;
  return (
    <QualityPickerDialog
      key={`${open}:${preferredResolution}`}
      {...props}
    />
  );
}

function QualityPickerDialog({
  open,
  onOpenChange,
  onConfirm,
  preferredResolution,
  alwaysPreferred,
  onAlwaysPreferredChange,
}: QualityPickerProps) {
  const [selected, setSelected] = useState<QualityValue>(preferredResolution);
  const groupName = useId();

  function handleConfirm() {
    onConfirm(selected);
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Choose quality</AlertDialogTitle>
          <AlertDialogDescription>
            Select the quality to download. None is guaranteed until the
            download starts.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {/* Quality radio list.
            Each row is min-h-[44px] to meet the app's touch-target rule. The
            radio input is visually hidden but accessible; the entire row label
            is the click/tap target. */}
        <div
          role="radiogroup"
          aria-label="Download quality"
          className="space-y-1"
        >
          {QUALITY_CHOICES.map((choice) => {
            const id = `${groupName}-${choice.value}`;
            const isSelected = selected === choice.value;
            return (
              <label
                key={choice.value}
                htmlFor={id}
                className={cn(
                  "flex min-h-[44px] cursor-pointer items-center gap-3 rounded-[var(--radius)] border px-3 py-2 transition-colors",
                  isSelected
                    ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)]"
                    : "border-[var(--border)] hover:border-[var(--border-strong)]",
                )}
              >
                <input
                  id={id}
                  type="radio"
                  name={groupName}
                  value={choice.value}
                  checked={isSelected}
                  onChange={() => setSelected(choice.value)}
                  className="sr-only"
                />
                {/* Custom radio indicator */}
                <span
                  aria-hidden
                  className={cn(
                    "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                    isSelected
                      ? "border-[var(--accent)] bg-[var(--accent)]"
                      : "border-[var(--border-strong)] bg-[var(--bg)]",
                  )}
                >
                  {isSelected ? (
                    <span className="h-1.5 w-1.5 rounded-full bg-white" />
                  ) : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium text-[var(--text)]">
                    {choice.label}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-[var(--text-tertiary)]">
                    {choice.hint}
                  </span>
                </span>
              </label>
            );
          })}
        </div>

        {/* "Always use my preferred quality" — once checked, the picker is
            skipped on all future Download presses. Visible so the user can
            undo it here rather than hunting through Settings. */}
        <div className="flex min-h-[44px] items-center gap-2.5 pt-1 lg:min-h-0">
          <Checkbox
            id={`${groupName}-always`}
            checked={alwaysPreferred}
            onCheckedChange={(checked) =>
              onAlwaysPreferredChange(checked === true)
            }
          />
          <label
            htmlFor={`${groupName}-always`}
            className="cursor-pointer select-none text-[13px] text-[var(--text-secondary)]"
          >
            Always use my preferred quality
          </label>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          {/* AlertDialogAction closes the dialog automatically after onClick. */}
          <AlertDialogAction onClick={handleConfirm}>
            Download
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
