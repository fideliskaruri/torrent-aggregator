/**
 * One release offered for the owner to choose: its name, quality, seeders,
 * size, site, languages and why it is listed. "Find another source"
 * (Downloads and the title page) and "Pick a source yourself" (title,
 * requests, activity) render the same card.
 */
import type { LiHTMLAttributes, ReactNode } from "react";
import { QualityChip } from "@/lib/torrents/quality-chip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadingGlyph } from "@/components/ui/loading";
import { RULE_SOURCE_OPTIONS } from "@/lib/rules/form";
import { formatBytes, formatWhen } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ReleaseLanguages, type ReleaseLanguageInfo } from "./release-language";

/** Why automatic picks skip a release: the owner replaced it, it failed the video check, or it has no English. */
export interface ReleaseBlockInfo {
  reason: "replaced" | "failed_video_check" | "no_english";
  /** When it was blocked, ISO 8601. */
  at: string;
  /** Plain words from the server explaining the block. */
  message: string;
}

export interface ReleaseCardData {
  token: string;
  hash: string;
  title: string;
  seeders: number;
  sizeBytes?: number | null;
  quality?: number | null;
  source: string;
  why: string;
  usedAt?: string | null;
  languages?: ReleaseLanguageInfo | null;
  blocked?: ReleaseBlockInfo | null;
}

/** The button on a blocked release. Picking it by hand overrides the block. */
export const USE_BLOCKED_RELEASE_LABEL = "Use it anyway";

export function releaseSourceLabel(id: string, name?: string): string {
  return RULE_SOURCE_OPTIONS.find((option) => option.value === id)?.label ?? (name?.trim() || id);
}

/** Quality, seeders, size and site on one wrapping line. Seeders are left out when not given. */
export function ReleaseFacts({
  quality,
  seeders,
  sizeBytes,
  source,
}: {
  quality?: number | null;
  seeders?: number;
  sizeBytes?: number | null;
  source?: string | null;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground tabular-nums">
      <QualityChip resolution={quality} />
      {seeders != null ? (
        <>
          <span>{seeders} {seeders === 1 ? "seeder" : "seeders"}</span>
          <span aria-hidden>·</span>
        </>
      ) : null}
      <span>{formatBytes(sizeBytes) ?? "Size unknown"}</span>
      {source ? (
        <>
          <span aria-hidden>·</span>
          <span className="break-all">{releaseSourceLabel(source)}</span>
        </>
      ) : null}
    </div>
  );
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
  // Automatic picks skip a blocked release, so it is never the one shown as recommended.
  const blocked = release.blocked ?? null;
  const featured = highlighted === true && !blocked;
  const label = blocked ? USE_BLOCKED_RELEASE_LABEL : actionLabel;
  const blockedMessage = blocked?.message?.trim();
  return (
    <li
      className={cn(
        "min-w-0 space-y-2 rounded-lg border p-3",
        blocked ? "border-border bg-muted/50" : featured ? "border-brand bg-card" : "border-border bg-card",
        className,
      )}
      data-release-blocked={blocked ? blocked.reason : undefined}
      {...item}
    >
      {blocked ? (
        <Badge variant="danger" data-release-blocked-badge>
          Dropped
        </Badge>
      ) : (
        badge
      )}
      <p className={cn("break-words text-sm font-medium", blocked ? "text-muted-foreground" : "text-foreground")}>
        {release.title}
      </p>
      <ReleaseFacts
        quality={release.quality}
        seeders={release.seeders}
        sizeBytes={release.sizeBytes}
        source={release.source}
      />
      <ReleaseLanguages info={release.languages} />
      {release.usedAt ? (
        <p className="text-[13px] leading-relaxed text-muted-foreground" data-release-used-at>
          Used {formatWhen(release.usedAt)}
        </p>
      ) : null}
      {blockedMessage ? (
        <p className="text-[13px] leading-relaxed text-muted-foreground break-words" data-release-blocked-message>
          {blockedMessage}
        </p>
      ) : null}
      {release.why ? (
        <p className="text-[13px] leading-relaxed text-muted-foreground break-words" data-alternative-reason>
          {release.why}
        </p>
      ) : null}
      <Button
        type="button"
        variant={featured ? "default" : "secondary"}
        className="w-full sm:w-auto"
        disabled={disabled}
        aria-busy={pending}
        aria-label={`${label}: ${release.title}`}
        onClick={onUse}
        data-pending={pending ? "true" : undefined}
        {...buttonData}
      >
        {pending ? <LoadingGlyph /> : null}
        {pending ? pendingLabel : label}
      </Button>
    </li>
  );
}
