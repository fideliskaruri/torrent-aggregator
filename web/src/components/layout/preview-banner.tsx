import { Eye } from "lucide-react";
import { setPreviewAsRequester, useCapabilities } from "@/lib/capabilities";

/** Tells the owner the page is rendered as a requester would see it, with the way out. */
export function PreviewBanner() {
  const { previewing } = useCapabilities();
  if (!previewing) return null;
  return (
    <div
      role="status"
      data-preview-banner
      className="border-b border-[var(--border)] bg-[var(--accent-dim)]"
    >
      <div className="container-app flex min-h-[44px] items-center justify-between gap-3 py-1 text-[13px]">
        <p className="flex min-w-0 items-center gap-2 text-[var(--accent-text)]">
          <Eye className="h-4 w-4 shrink-0" aria-hidden />
          <span className="truncate">Previewing as a requester</span>
        </p>
        <button
          type="button"
          onClick={() => setPreviewAsRequester(false)}
          data-preview-exit
          className="inline-flex min-h-[44px] shrink-0 items-center rounded-md px-2.5 font-medium text-[var(--text)] underline-offset-2 hover:underline outline-none focus-visible:ring-1 focus-visible:ring-[var(--brand)] md:min-h-8"
        >
          Exit preview
        </button>
      </div>
    </div>
  );
}
