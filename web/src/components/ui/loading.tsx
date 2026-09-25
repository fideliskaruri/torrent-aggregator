import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function SkeletonBlock({
  className,
}: {
  className?: string;
}) {
  return <div aria-hidden className={cn("skeleton", className)} />;
}

export function LoadingGlyph({ className }: { className?: string }) {
  return (
    <Loader2
      aria-hidden
      className={cn("shrink-0 animate-spin", className)}
    />
  );
}

export function PageSkeletonFrame({
  children,
  className,
  "aria-label": ariaLabel = "Loading",
}: {
  children: ReactNode;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <div
      className={className}
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={ariaLabel}
    >
      {children}
    </div>
  );
}
