import { Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { setPreviewAsRequester, useCapabilities } from "@/lib/capabilities";

/** Tells the owner the page is rendered as a requester would see it, with the way out. */
export function PreviewBanner() {
  const { previewing } = useCapabilities();
  if (!previewing) return null;
  return (
    <div
      role="status"
      data-preview-banner
      className="border-b border-border bg-brand-dim"
    >
      <div className="container-app flex min-h-[44px] items-center justify-between gap-3 py-1 text-[13px]">
        <p className="flex min-w-0 items-center gap-2 text-brand-foreground">
          <Eye className="h-4 w-4 shrink-0" aria-hidden />
          <span className="truncate">Previewing as a requester</span>
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setPreviewAsRequester(false)}
          data-preview-exit
          className="shrink-0 text-[13px] text-foreground max-md:min-h-11"
        >
          Exit preview
        </Button>
      </div>
    </div>
  );
}
