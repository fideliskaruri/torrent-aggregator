import { Check,Download,Loader2,RotateCw,Search } from "lucide-react";
import type { TitleDownloadPresentation } from "./title-download-state";

export function DownloadGlyph({
  presentation,
}: {
  presentation: TitleDownloadPresentation;
}) {
  if (presentation.state === "retry") return <RotateCw className="h-4 w-4" aria-hidden />;
  if (presentation.state === "downloading") {
    const pct = Math.floor(Math.max(0, Math.min(1, presentation.progress ?? 0)) * 100);
    return <span className="text-[12px] font-semibold tabular-nums leading-none">{pct}%</span>;
  }
  if (presentation.state === "looking") return <Search className="h-4 w-4" aria-hidden />;
  if (presentation.state === "queued" && presentation.queuePosition != null) {
    return <span className="text-[12px] font-semibold tabular-nums leading-none">#{presentation.queuePosition}</span>;
  }
  if (presentation.state === "queued" || presentation.state === "pending") {
    return <Loader2 className="h-4 w-4 animate-spin" aria-hidden />;
  }
  if (presentation.state === "done") return <Check className="h-4 w-4 text-brand-foreground" aria-hidden />;
  return <Download className="h-4 w-4" aria-hidden />;
}
