import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { LoadingGlyph } from "@/components/ui/loading";

type DataAttributes = { [key: `data-${string}`]: string | boolean | undefined };

/** The one destructive fill every confirm uses. */
export const DESTRUCTIVE_CONFIRM_CLASS =
  "bg-destructive text-white hover:bg-destructive/90";

const TOUCH = "max-md:min-h-11 pointer-coarse:min-h-11";

/**
 * The one yes/no confirmation. Every "are you sure" in the app goes through
 * this, so they share the destructive styling, the busy state that blocks
 * closing mid-action, and focus return to whatever opened them (handled by
 * `AlertDialogContent`).
 *
 * The confirm never closes the dialog by itself: `onConfirm` runs and the
 * caller closes it (usually once its request settles), so a failure can keep
 * the dialog up.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  variant = "default",
  icon,
  onConfirm,
  busy = false,
  confirmDisabled = false,
  secondaryAction,
  hideConfirm = false,
  contentData,
  confirmData,
  cancelData,
  onCloseAutoFocus,
}: {
  open: boolean;
  /** Called with `false` for Esc, overlay and Cancel. Ignored while busy. */
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** Says what happens. Strings render as one paragraph. */
  description?: ReactNode;
  /** Extra body under the description: a form field, a plan, a breakdown. */
  children?: ReactNode;
  confirmLabel: ReactNode;
  cancelLabel?: ReactNode;
  variant?: "default" | "destructive";
  /** Leading glyph on the confirm; replaced by a spinner while busy. */
  icon?: ReactNode;
  onConfirm: () => void;
  busy?: boolean;
  confirmDisabled?: boolean;
  /** A third button between Cancel and the confirm. */
  secondaryAction?: ReactNode;
  hideConfirm?: boolean;
  contentData?: DataAttributes;
  confirmData?: DataAttributes;
  cancelData?: DataAttributes;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <AlertDialogContent onCloseAutoFocus={onCloseAutoFocus} {...contentData}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description != null ? (
            typeof description === "string" ? (
              <AlertDialogDescription>{description}</AlertDialogDescription>
            ) : (
              <AlertDialogDescription asChild>
                <div className="space-y-3">{description}</div>
              </AlertDialogDescription>
            )
          ) : null}
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy} className={TOUCH} {...cancelData}>
            {cancelLabel}
          </AlertDialogCancel>
          {secondaryAction}
          {hideConfirm ? null : (
            <AlertDialogAction
              disabled={busy || confirmDisabled}
              className={cn(TOUCH, variant === "destructive" && DESTRUCTIVE_CONFIRM_CLASS)}
              onClick={(event) => {
                event.preventDefault();
                onConfirm();
              }}
              {...confirmData}
            >
              {busy ? <LoadingGlyph className="h-3.5 w-3.5" /> : icon}
              {confirmLabel}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
