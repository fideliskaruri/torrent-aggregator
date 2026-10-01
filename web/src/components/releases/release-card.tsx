/**
 * One release offered for the owner to choose: its name, quality, seeders,
 * size, source and why it is listed. "Find another release" (Downloads) and
 * "Pick a release yourself" (title, requests, activity) render the same card.
 */
import type { LiHTMLAttributes, ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadingGlyph } from "@/components/ui/loading";
import { RULE_SOURCE_OPTIONS } from "@/lib/rules/form";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface ReleaseCardData {
  token: string;
  hash: string;
  title: string;
  seeders: number;
  sizeBytes?: number;
  quality?: number;
  source: string;
  why: string;
}

export function releaseSourceLabel(id: string, name?: string): string {
  return RULE_SOURCE_OPTIONS.find((option) => option.value === id)?.label ?? (name?.trim() || id);
}

type DataAttributes = { [key: `data-${string}`]: string | number | undefined };

export function ReleaseCard({
  release,
  highlighted,
  badge,
  pending,
  disabled,
  actionLabel,
  pendingLabel,
  onUse,
  buttonData,
  className,
  ...item
}: {
  release: ReleaseCardData;
  highlighted?: boolean;
  badge?: ReactNode;
  pending: boolean;
  disabled: boolean;
  actionLabel: string;
  pendingLabel: string;
  onUse: () => void;
  buttonData?: DataAttributes;
} & LiHTMLAttributes<HTMLLIElement> & DataAttributes) {
  return (
    <li
      className={cn(
        "min-w-0 space-y-2 rounded-lg border bg-card p-3",
        highlighted ? "border-brand" : "border-border",
        className,
      )}
      {...item}
    >
      {badge}
      <p className="break-words text-sm font-medium text-foreground">{release.title}</p>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground tabular-nums">
        {release.quality ? <Badge variant="outline">{release.quality}p</Badge> : null}
        <span>{release.seeders} {release.seeders === 1 ? "seeder" : "seeders"}</span>
        <span aria-hidden>·</span>
        <span>{formatBytes(release.sizeBytes) ?? "Size unknown"}</span>
        {release.source ? (
          <>
            <span aria-hidden>·</span>
            <span className="break-all">{releaseSourceLabel(release.source)}</span>
          </>
        ) : null}
      </div>
      {release.why ? (
        <p className="text-[13px] leading-relaxed text-muted-foreground break-words" data-alternative-reason>
          {release.why}
        </p>
      ) : null}
      <Button
        type="button"
        variant={highlighted ? "default" : "secondary"}
        className="w-full sm:w-auto"
        disabled={disabled}
        aria-busy={pending}
        aria-label={`${actionLabel}: ${release.title}`}
        onClick={onUse}
        data-pending={pending ? "true" : undefined}
        {...buttonData}
      >
        {pending ? <LoadingGlyph /> : null}
        {pending ? pendingLabel : actionLabel}
      </Button>
    </li>
  );
}

