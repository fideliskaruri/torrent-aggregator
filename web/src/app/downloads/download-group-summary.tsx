import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { formatBytes, formatEta, formatSpeed } from "@/lib/format";
import { seasonProgressLabel } from "@/components/title/season-progress";
import { progressPercent } from "@/components/tf/active-row-state";
import { seriesEpisodeTally, type SeriesGroup } from "./grouping";
import {
  rollupChip,
  showsProgressBar,
} from "./release-display";
import { TransferProgress, transferBarTone } from "./transfer-progress";
import { transferTitleParts } from "./download-transfer-title";
import type { ClientTorrent } from "./types";
import { SearchingBadge } from "./searching-badge";
import type { WantedGroup } from "./wanted-groups";

export function DownloadGroupSummary({
  group,
  titleHref,
  posterUrl,
  heading = false,
  children,
  wantedGroups = [],
}: {
  group: SeriesGroup<ClientTorrent>;
  titleHref: string | null;
  posterUrl?: string | null;
  heading?: boolean;
  children?: ReactNode;
  wantedGroups?: readonly WantedGroup[];
}) {
  const pct = progressPercent(group.progress);
  const chip = rollupChip(group);
  const tallyText = seasonProgressLabel({ ...seriesEpisodeTally(group), aired: null });
  const missingFiles = group.torrents.filter((t) => t.filesMissing === true).length;
  const errorRow = group.counts.error === 1
    ? group.torrents.find((torrent) => torrent.status === "error")
    : undefined;
  const errorMessage = errorRow?.statusLabel;
  const title = transferTitleParts({ title: group.title, href: titleHref, posterUrl, heading });
  return (
    <div className="flex min-w-0 flex-1 items-start gap-2.5">
      {title.thumb}
      <div className="min-w-0 flex-1 space-y-1">
        {title.text}
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={chip.variant} data-group-state>{chip.label}</Badge>
          <SearchingBadge groups={wantedGroups} />
          {missingFiles > 0 ? (
            <Badge variant="danger" title={`${missingFiles} download files are no longer on disk`} data-files-missing>
              Files missing
            </Badge>
          ) : null}
          <span className="text-[12px] tabular-nums text-subtle-foreground">
            {group.releaseCount} {group.releaseCount === 1 ? "source" : "sources"}
            {" · "}{group.seasonCount} {group.seasonCount === 1 ? "season" : "seasons"}
            {group.sizeBytes > 0 ? ` · ${formatBytes(group.sizeBytes)}` : null}
          </span>
        </div>
        {tallyText ? <p data-group-episodes className="text-[12px] tabular-nums text-muted-foreground">{tallyText}</p> : null}
        {errorMessage ? <p className="text-[12px] leading-snug text-destructive" data-group-error-message>{errorMessage}</p> : null}
        {showsProgressBar(group) ? (
          <TransferProgress percent={pct} tone={transferBarTone(group.status, chip.failing)}
            label={`${group.title} combined download progress`}
            speed={["downloading", "finishing", "waiting"].includes(group.status)
              ? [formatSpeed(group.dlspeed), group.eta != null ? formatEta(group.eta) : null]
                .filter(Boolean).join(" · ")
              : null}
            className="pt-0.5" barClassName="max-w-[18rem]" />
        ) : null}
        {children}
      </div>
    </div>
  );
}
