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
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
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
      <AlertDialogContent className="bottom-0 left-0 top-auto max-h-[calc(100dvh-0.5rem)] w-full max-w-none translate-x-0 translate-y-0 rounded-b-none rounded-t-xl border-x-0 border-b-0 pb-[calc(1.25rem+var(--safe-bottom))] sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:w-[calc(100%-2rem)] sm:max-w-md sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl sm:border sm:p-5">
        <AlertDialogHeader>
          <AlertDialogTitle>Choose quality</AlertDialogTitle>
          <AlertDialogDescription>
            Select the quality to download. None is guaranteed until the
            download starts.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {/* Each row is a 44px Label card around a RadioGroupItem, so the whole
            row is the click/tap target and arrow keys move the choice. */}
        <RadioGroup
          aria-label="Download quality"
          value={String(selected)}
          onValueChange={(value) => {
            const choice = QUALITY_CHOICES.find((c) => String(c.value) === value);
            if (choice) setSelected(choice.value);
          }}
          className="gap-1"
        >
          {QUALITY_CHOICES.map((choice) => {
            const id = `${groupName}-${choice.value}`;
            return (
              <Label
                key={choice.value}
                htmlFor={id}
                className={cn(
                  "min-h-[44px] cursor-pointer gap-3 rounded-lg border border-border px-3 py-2 font-normal transition-colors hover:border-input",
                  "has-data-checked:border-brand has-data-checked:bg-brand/8",
                )}
              >
                <RadioGroupItem id={id} value={String(choice.value)} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium text-foreground">
                    {choice.label}
                  </span>
                  <span className="mt-0.5 block text-[12px] leading-snug text-subtle-foreground">
                    {choice.hint}
                  </span>
                </span>
              </Label>
            );
          })}
        </RadioGroup>

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
          <Label
            htmlFor={`${groupName}-always`}
            className="cursor-pointer text-[13px] font-normal text-muted-foreground"
          >
            Always use my preferred quality
          </Label>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel className="min-h-[48px] sm:min-h-0">
            Cancel
          </AlertDialogCancel>
          {/* AlertDialogAction closes the dialog automatically after onClick. */}
          <AlertDialogAction
            onClick={handleConfirm}
            className="min-h-[48px] sm:min-h-0"
          >
            Download
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
