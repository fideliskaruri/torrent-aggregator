"use client";

import { FolderOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/** Short display path + full path on hover. */
export function TfPathChip({
  path,
  relative,
  className,
  onOpen,
}: {
  path?: string | null;
  relative?: string | null;
  className?: string;
  onOpen?: () => void;
}) {
  const full = path?.trim() || "";
  const short = relative?.trim() || shortenPath(full);
  if (!full && !short) return null;

  const body = (
    <button
      type="button"
      onClick={onOpen}
      disabled={!onOpen}
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded border border-[var(--border)] bg-[var(--bg-muted)] px-1.5 py-0.5 text-[11px] text-[var(--text-tertiary)] font-mono truncate transition-colors",
        onOpen && "hover:border-[var(--border-strong)] hover:text-[var(--accent-text)] cursor-pointer",
        !onOpen && "cursor-default",
        className,
      )}
      data-path-chip
      title={full || short}
    >
      {onOpen ? <FolderOpen className="h-3 w-3 shrink-0 opacity-70" /> : null}
      <span className="truncate">{short || full}</span>
    </button>
  );

  if (!full || full === short) return body;

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>{body}</TooltipTrigger>
        <TooltipContent side="bottom" className="font-mono text-[11px] break-all">
          {full}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function shortenPath(p: string): string {
  if (!p) return "";
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length <= 2) return p;
  return parts.slice(-2).join(" / ");
}
