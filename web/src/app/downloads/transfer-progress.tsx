import { cn } from "@/lib/utils";
import { Progress } from "@/components/ui/progress";
import { isDownloaded, isError, isPaused, isQueued } from "./grouping";
import type { DownloadStatus } from "./types";

/** The fill colour of every transfer bar: done, failed, waiting or moving. */
export function transferBarTone(status: DownloadStatus, failing = false): string {
  return isDownloaded(status)
    ? "bg-success"
    : isError(status) || failing
      ? "bg-destructive"
      : isPaused(status) || isQueued(status)
        ? "bg-subtle-foreground"
        : "bg-primary";
}

/**
 * The one download progress bar: the bar, the floored percent and, while
 * something is moving, the speed. `mini` is the season tab's short bar.
 */
export function TransferProgress({
  percent,
  tone,
  label,
  speed = null,
  size = "md",
  showPercent = true,
  className,
  barClassName,
}: {
  percent: number;
  tone: string;
  label: string;
  speed?: string | null;
  size?: "md" | "sm" | "mini";
  showPercent?: boolean;
  className?: string;
  barClassName?: string;
}) {
  return (
    <div className={cn("flex items-center", size === "mini" ? "w-full gap-1.5" : "gap-2", className)}>
      <Progress
        value={percent}
        aria-label={label}
        className={cn(
          size === "mini" ? "h-1 w-10 shrink-0 bg-border" : size === "sm" ? "h-1 flex-1" : "h-1.5 flex-1",
          barClassName,
        )}
        indicatorClassName={tone}
      />
      {showPercent ? (
        <span className="shrink-0 text-[12px] tabular-nums text-subtle-foreground">{percent}%</span>
      ) : null}
      {speed ? (
        <span className="shrink-0 text-[12px] tabular-nums font-mono text-brand-foreground">
          ↓ {speed}
        </span>
      ) : null}
    </div>
  );
}
