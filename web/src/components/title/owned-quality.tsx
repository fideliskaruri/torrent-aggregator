import { Check, CheckCircle2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { qualityLabel } from "@/lib/torrents/quality";
import { cn } from "@/lib/utils";
import { ownedLabel } from "./owned-state";
import type { TitleOwned } from "./types";

export interface OwnedQualityProps {
  owned: TitleOwned;
  variant: "title" | "row";
  pillClassName?: string;
  className?: string;
}

export function OwnedQuality({ owned, variant, pillClassName, className }: OwnedQualityProps) {
  const ownedText = ownedLabel(owned) ?? "In your library";
  const quality = qualityLabel(owned.resolution);

  if (variant === "row") {
    return (
      <span className={cn("flex items-center gap-1.5", className)} data-owned-quality="owned">
        <Badge
          data-episode-owned
          aria-label={ownedText}
          title={ownedText}
          className={cn(pillClassName, "border px-3 text-[13px] font-medium")}
        >
          <Check aria-hidden className="size-3.5 text-brand-foreground" />
          {quality ?? "In library"}
        </Badge>
      </span>
    );
  }

  return (
    <div data-title-owned data-owned-quality="owned"
      className={cn("flex w-full min-w-0 flex-col gap-2 md:mr-2 md:w-auto md:flex-row md:flex-wrap md:items-center", className)}>
      <p className="flex min-h-10 min-w-0 items-center gap-2 text-[14px] font-medium text-foreground">
        <CheckCircle2 aria-hidden className="size-4 shrink-0 text-brand-foreground" />
        <span data-owned-text>{ownedText}</span>
      </p>
    </div>
  );
}
