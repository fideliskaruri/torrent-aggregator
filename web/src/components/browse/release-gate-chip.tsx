import type { BrowseReleaseGate } from "@/lib/browse/release-status";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * "In cinemas", "Digital Aug 2026" or "Coming Jul 2026": why a title cannot be
 * fetched yet, in one chip.
 *
 * `browseReleaseGate` decides; this draws it. Cards, the browse hero, search
 * results and the title page all wear this one chip, so a gated title reads the
 * same wherever it appears. Renders nothing for an open title.
 */
export function ReleaseGateChip({
  gate,
  className,
  ...data
}: {
  gate: Pick<BrowseReleaseGate, "gated" | "label">;
  className?: string;
} & { [key: `data-${string}`]: string | boolean | undefined }) {
  if (!gate.gated) return null;
  return (
    <Badge
      {...data}
      data-release-gate
      className={cn("max-w-full bg-card px-2 py-1 text-[11px] leading-none", className)}
    >
      <span className="truncate">{gate.label ?? "Coming soon"}</span>
    </Badge>
  );
}
