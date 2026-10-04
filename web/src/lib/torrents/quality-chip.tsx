import { Badge } from "@/components/ui/badge";
import { qualityLabel } from "./quality";

/**
 * The quality chip every download row and release card wears.
 *
 * Takes the resolution (or an already-made label) and prints the one name for
 * it from `qualityLabel`, so a 2160 release reads "4K" everywhere, the same word
 * the quality picker uses. Renders nothing when the quality is unknown.
 */
export function QualityChip({
  resolution,
  label,
  className,
}: {
  resolution?: number | null;
  /** A label already supplied by the server. */
  label?: string | null;
  className?: string;
}) {
  const text = label ?? qualityLabel(resolution);
  if (!text) return null;
  return (
    <Badge variant="outline" data-quality-chip className={className}>
      {text}
    </Badge>
  );
}
