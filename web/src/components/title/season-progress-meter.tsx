import type { ComponentProps } from "react";
import { Check, Download } from "lucide-react";
import { cn } from "@/lib/utils";
import { isSeasonComplete, type SeasonProgress } from "./season-progress";

/**
 * "12 of 38 downloaded · 3 downloading" with a small ring. The ring fills
 * with the downloaded share of aired episodes and turns into a check once
 * every aired episode is on disk; in-flight episodes are only in the words.
 * Used by the season header and, summed over seasons, the title hero.
 */
export function SeasonProgressMeter({
  progress,
  label,
  className,
  ...props
}: {
  progress: SeasonProgress;
  label: string;
} & Omit<ComponentProps<"p">, "children">) {
  const complete = isSeasonComplete(progress);
  const fraction =
    progress.aired && progress.aired > 0
      ? Math.min(1, progress.downloaded / progress.aired)
      : 0;
  const radius = 6.5;
  const circumference = 2 * Math.PI * radius;
  return (
    <p
      data-complete={complete ? "true" : undefined}
      className={cn(
        "inline-flex items-center gap-1.5 text-[12px] tabular-nums text-muted-foreground",
        className,
      )}
      {...props}
    >
      {complete ? (
        <span
          aria-hidden
          className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-success text-background"
        >
          <Check className="h-3 w-3" strokeWidth={3} />
        </span>
      ) : progress.aired != null && progress.aired > 0 ? (
        <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4 shrink-0 -rotate-90">
          <circle cx="8" cy="8" r={radius} fill="none" strokeWidth="2.5" className="stroke-input" />
          {fraction > 0 ? (
            <circle
              cx="8"
              cy="8"
              r={radius}
              fill="none"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray={`${fraction * circumference} ${circumference}`}
              className="stroke-brand"
            />
          ) : null}
        </svg>
      ) : (
        <Download className="h-3.5 w-3.5 shrink-0 text-subtle-foreground" aria-hidden />
      )}
      <span>{label}</span>
    </p>
  );
}
