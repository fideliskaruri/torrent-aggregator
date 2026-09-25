"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export type ActionButtonStatusVariant = "info" | "success" | "error";

export interface ActionButtonStatus {
  message: string;
  variant?: ActionButtonStatusVariant;
}

export interface ActionButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * Transient status/error rendered in the reserved slot directly under the
   * button. Pass `null`/`undefined` to leave the (still reserved) slot empty.
   */
  status?: ActionButtonStatus | null;
  /**
   * Pixel height reserved for the status line. The slot always occupies this
   * height — even with no message — so toggling a message on/off never shifts
   * surrounding layout.
   */
  statusReserveHeight?: number;
  /** Extra classes applied to the reserved status line. */
  statusClassName?: string;
}

/** Tailwind text colour for a status variant. */
export function actionStatusTone(variant: ActionButtonStatusVariant): string {
  switch (variant) {
    case "error":
      return "text-[var(--destructive)]";
    case "success":
      return "text-[var(--success)]";
    default:
      return "text-[var(--text-tertiary)]";
  }
}

/**
 * Normalise a raw status into what the reserved slot actually renders: trimmed
 * text and a resolved variant. Empty/whitespace-only messages resolve to an
 * empty string so the slot stays reserved but blank.
 */
export function resolveActionStatus(status?: ActionButtonStatus | null): {
  text: string;
  variant: ActionButtonStatusVariant;
} {
  return {
    text: status?.message?.trim() ?? "",
    variant: status?.variant ?? "info",
  };
}

/**
 * A button that owns an inline, fixed-height status/error line beneath it.
 *
 * The status slot is reserved up front via an inline `minHeight`, so the
 * message can appear or disappear with zero layout shift and independently of
 * whatever CSS/utility pipeline renders the page.
 */
export const ActionButton = React.forwardRef<
  HTMLButtonElement,
  ActionButtonProps
>(function ActionButton(
  {
    className,
    status,
    statusReserveHeight = 16,
    statusClassName,
    children,
    ...props
  },
  ref,
) {
  const { text, variant } = resolveActionStatus(status);

  return (
    <span className="inline-flex min-w-0 flex-col items-stretch">
      <button ref={ref} className={className} {...props}>
        {children}
      </button>
      <span
        data-action-status
        data-action-status-variant={text ? variant : undefined}
        role="status"
        aria-live="polite"
        title={text || undefined}
        style={{ minHeight: statusReserveHeight }}
        className={cn(
          "mt-0.5 flex max-w-full items-center justify-center overflow-hidden text-ellipsis whitespace-nowrap px-0.5 text-center text-[11px] leading-4",
          actionStatusTone(variant),
          statusClassName,
        )}
      >
        {text}
      </span>
    </span>
  );
});
