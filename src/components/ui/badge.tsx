import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium transition-colors max-w-full truncate",
  {
    variants: {
      variant: {
        default:
          "border-[var(--border)] bg-[var(--bg-muted)] text-[var(--text-secondary)]",
        secondary:
          "border-transparent bg-[var(--bg-hover)] text-[var(--text-secondary)]",
        accent:
          "border-[var(--accent-border)] bg-[var(--accent-dim)] text-[var(--accent-text)]",
        success:
          "border-[rgba(62,207,142,0.22)] bg-[rgba(62,207,142,0.12)] text-[var(--success)]",
        danger:
          "border-[rgba(240,113,120,0.22)] bg-[rgba(240,113,120,0.12)] text-[var(--danger)]",
        outline: "border-[var(--border)] text-[var(--text-secondary)]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
