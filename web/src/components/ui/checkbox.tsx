import * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  // The control the finger lands on is 44x44 on touch (WCAG 2.5.5 / the app's
  // established touch rule, mirrored on the monitoring switch), while the box
  // the eye reads stays 16px: the Root is a transparent, centred hit area and
  // the painted checkbox is the inner span. On desktop, where the pointer is a
  // mouse and a 44px control looks oversized, the hit area collapses back to
  // 16px. Enlarging the visible border box instead would put a big empty square
  // beside every label; a bare ::before hit area would not enlarge the element's
  // own box, which is exactly what an accessibility audit measures.
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      "peer group relative grid h-11 w-11 shrink-0 place-items-center rounded lg:h-4 lg:w-4",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--bg)]",
      "disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    {...props}
  >
    <span className="grid h-4 w-4 place-items-center rounded border border-[var(--border-strong)] bg-[var(--bg)] shadow-sm transition-colors group-data-[state=checked]:border-[var(--primary)] group-data-[state=checked]:bg-[var(--primary)] group-data-[state=checked]:text-[var(--primary-foreground)]">
      <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
        <Check className="h-3 w-3" strokeWidth={3} />
      </CheckboxPrimitive.Indicator>
    </span>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = CheckboxPrimitive.Root.displayName;

export { Checkbox };
