import { Check, Download, Loader2, RotateCcw, Search } from "lucide-react";
import type { TitleActionStatus } from "./title-actions";
import type { TitleTransferState } from "./types";

export function DownloadGlyph({
  transferStatus,
  transferState,
  queuePosition,
  progress,
  held,
  status,
}: {
  transferStatus: "queued" | "downloading" | "downloaded" | "failed" | null;
  transferState: TitleTransferState | null;
  queuePosition: number | null;
  progress: number | null;
  held: boolean;
  status: TitleActionStatus;
}) {
  if (transferStatus === "failed" || status === "error") {
    return <RotateCcw className="h-4 w-4" aria-hidden />;
  }
  if (transferStatus === "downloading") {
    const pct = Math.floor(Math.max(0, Math.min(1, progress ?? 0)) * 100);
    return (
      <span className="text-[12px] font-semibold tabular-nums leading-none">
        {pct}%
      </span>
    );
  }
  if (transferState === "looking" || transferState === "waiting_season_list") {
    return <Search className="h-4 w-4" aria-hidden />;
  }
  if (transferStatus === "queued" && queuePosition != null) {
    return (
      <span className="text-[12px] font-semibold tabular-nums leading-none">
        #{queuePosition}
      </span>
    );
  }
  if (transferStatus === "queued" || status === "pending") {
    return <Loader2 className="h-4 w-4 animate-spin" aria-hidden />;
  }
  if (held || transferStatus === "downloaded" || status === "done") {
    return <Check className="h-4 w-4 text-brand-foreground" aria-hidden />;
  }
  return <Download className="h-4 w-4" aria-hidden />;
}

export function formatTransferProgress(progress: number): string {
  const percent = Math.min(100, Math.max(0, progress * 100));
  return `${Number.isInteger(percent) ? percent.toFixed(0) : percent.toFixed(1)}%`;
}
