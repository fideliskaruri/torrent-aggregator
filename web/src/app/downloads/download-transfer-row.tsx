/**
 * The one download row (a film on the page, an episode in the series dialog)
 * and the one series summary (the page's group row and the dialog's header).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Check, Download, Search, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatBytes, formatEta, formatSpeed } from "@/lib/format";
import { useDisplayPath, useFeatures } from "@/lib/features";
import { Badge } from "@/components/ui/badge";
import { QualityChip } from "@/lib/torrents/quality-chip";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleTrigger } from "@/components/ui/collapsible";
import { TfWorkThumb } from "@/components/tf/work-thumb";
import { TfOpenFileButton } from "@/components/tf/open-file-button";
import { progressPercent } from "@/components/tf/active-row-state";
import { seasonProgressLabel } from "@/components/title/season-progress";
import { artworkQueryForRelease } from "@/lib/metadata/release-art";
import {
  isDownloaded,
  isDownloading,
  isError,
  isPaused,
  seriesEpisodeTally,
  type SeriesGroup,
} from "./grouping";
import {
  canDownloadNow,
  canOpenFinishedFile,
  forcedStartLabel,
  packLabel,
  rollupChip,
  releaseDisplayFacts,
  rowStateBadge,
  showsProgressBar,
  transferErrorMessage,
  waitReasonLabel,
  canFindAnotherSourceFor,
} from "./release-display";
import { FIND_ANOTHER_SOURCE_LABEL } from "@/components/releases/find-another-source";
import {
  IconMenuButton,
  rowAttr,
  torrentRowMenuItems,
  type TorrentRowMenuHandlers,
  type TransferRowKind,
} from "./row-menu";
import { TransferProgress, transferBarTone } from "./transfer-progress";
import type { ClientTorrent } from "./types";

/** Every download poster on the page and in the dialog is this size. */
export const TRANSFER_THUMB_PX = 40;

function transferTitleParts({
  title,
  href,
  posterUrl,
  heading = false,
}: {
  title: string;
  href: string | null;
  posterUrl?: string | null;
  heading?: boolean;
}) {
  const thumb = <TfWorkThumb title={title} posterUrl={posterUrl ?? undefined} sizePx={TRANSFER_THUMB_PX} />;
  const Text = heading ? "h2" : "p";
  return {
    thumb: href ? (
      <Link to={href} tabIndex={-1} aria-hidden data-dense-ui className="shrink-0">
        {thumb}
      </Link>
    ) : (
      thumb
    ),
    text: href ? (
      <Link
        to={href}
        className="flex items-center min-h-[44px] rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring lg:block lg:min-h-0"
        data-dialog-title-link={heading ? "" : undefined}
      >
        <Text className="text-[13px] font-medium text-foreground line-clamp-2 leading-snug hover:text-brand-foreground">
          {title}
        </Text>
      </Link>
    ) : (
      <Text className="text-[13px] font-medium text-foreground line-clamp-2 leading-snug">{title}</Text>
    ),
  };
}

export interface DownloadTransferRowProps extends TorrentRowMenuHandlers {
  torrent: ClientTorrent;
  /** `torrent` is a film row on the page; `episode` a card in the series dialog. */
  kind: TransferRowKind;
  /** The film's name, or the episode label ("E05"). */
  title: string;
  /** Films link to their title page and show a poster; episodes do neither. */
  titleHref?: string | null;
  posterUrl?: string | null;
  showThumb?: boolean;
  /** A season pack is many episodes, so it never offers Open. */
  isSeasonPack?: boolean;
  isSelected: boolean;
  highlighted: boolean;
  openingHash: string | null;
  onToggleSelect: (transferId: string, additive: boolean) => void;
}

export function DownloadTransferRow({
  torrent: t,
  kind,
  title,
  titleHref = null,
  posterUrl,
  showThumb = false,
  isSeasonPack = false,
  isSelected,
  highlighted,
  openingHash,
  onToggleSelect,
  ...handlers
}: DownloadTransferRowProps) {
  const { onAction, onOpenFile } = handlers;
  const { openFolder } = useFeatures();
  const displayPath = useDisplayPath();
  const card = kind === "episode";
  const pct = progressPercent(t.progress);
  const badge = rowStateBadge(t);
  const busy = openingHash === t.transferId;
  // A pack's largest file is one episode of many, so a pack only gets Show in folder.
  const canOpen = openFolder && canOpenFinishedFile(t) && !isSeasonPack && !t.packEpisodes;
  const isBuiltin = t.ownerClientType === "builtin";
  const errorMessage = transferErrorMessage(t);
  const [errorExpanded, setErrorExpanded] = useState(false);
  const showEta = isDownloading(t.state) && t.eta != null && t.eta > 0;
  const speed = isDownloading(t.state) ? formatSpeed(t.dlspeed) : null;
  const done = isDownloaded(t.state);
  const quality = releaseDisplayFacts(t, artworkQueryForRelease(t.name, t.category)).qualityChip;
  const heading = transferTitleParts({ title, href: titleHref, posterUrl });
  const rowRef = useRef<HTMLDivElement>(null);
  // Bring the linked row into view and give it focus, so the keyboard and a
  // screen reader start from the download the user asked to see.
  useEffect(() => {
    if (!highlighted) return;
    rowRef.current?.scrollIntoView({ block: "center" });
    rowRef.current?.focus({ preventScroll: true });
  }, [highlighted]);

  const actions = (
    <>
      {canDownloadNow(t) && isBuiltin ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => onAction("force", t)}
          aria-label={`Download ${title} now`}
          {...rowAttr(kind, "force-now")}
        >
          <Zap className="h-3.5 w-3.5" />
          Download now
        </Button>
      ) : null}
      {isError(t.state) ? (
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={() => onAction("resume", t)}
          aria-label={`Retry ${title}`}
          {...rowAttr(kind, "retry")}
          {...rowAttr(kind, "resume")}
        >
          <Download className="h-3.5 w-3.5" />
          Retry
        </Button>
      ) : isPaused(t.state) && t.progress < 1 ? (
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={() => onAction("resume", t)}
          aria-label={`Resume ${title}`}
          {...rowAttr(kind, "resume")}
        >
          <Download className="h-3.5 w-3.5" />
          Resume
        </Button>
      ) : null}
      {isError(t.state) && canFindAnotherSourceFor(t) ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => onAction("swap", t)}
          aria-label={`${FIND_ANOTHER_SOURCE_LABEL} for ${title}`}
          {...rowAttr(kind, "find-release")}
        >
          <Search className="h-3.5 w-3.5" />
          {FIND_ANOTHER_SOURCE_LABEL}
        </Button>
      ) : null}
      {canOpen ? (
        <TfOpenFileButton name={title} busy={busy} onClick={() => onOpenFile(t, "open")} />
      ) : null}
    </>
  );

  const menu = (
    <IconMenuButton label={`More actions for ${title}`} triggerProps={rowAttr(kind, "more")}>
      {torrentRowMenuItems({ torrent: t, kind, busy, displayPath, handlers })}
    </IconMenuButton>
  );

  return (
    <div
      ref={rowRef}
      className={cn(
        "group transition-colors",
        card
          ? "flex min-w-0 flex-col gap-2 rounded-lg border border-border p-3"
          : "grid grid-cols-1 sm:grid-cols-[auto_minmax(0,1fr)_auto] gap-2 sm:gap-3 items-center px-3 py-2.5",
        isSelected ? "bg-brand-dim" : card ? "bg-muted/40" : "hover:bg-muted/60",
        highlighted && (card ? "ring-2 ring-brand" : "ring-2 ring-inset ring-brand"),
      )}
      {...(card ? { "data-episode-card": "" } : { "data-client-torrent": "" })}
      data-highlighted={highlighted || undefined}
      role="button"
      tabIndex={0}
      aria-pressed={isSelected}
      aria-label={`${isSelected ? "Deselect" : "Select"} ${title}`}
      data-hash={t.hash}
      data-owner-client={t.ownerClientType}
      data-retention={t.retentionState}
      data-torrent-error={isError(t.state) ? "true" : undefined}
      title={t.name}
      onClick={(e) => {
        if (
          e.target instanceof HTMLElement &&
          (e.target.closest("button") ||
            e.target.closest("select") ||
            e.target.closest('[role="checkbox"]') ||
            e.target.closest("a"))
        ) {
          return;
        }
        onToggleSelect(t.transferId, e.ctrlKey || e.metaKey || e.shiftKey);
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggleSelect(t.transferId, e.ctrlKey || e.metaKey || e.shiftKey);
        }
      }}
    >
      <div className={cn("flex gap-2", card ? "items-start" : "items-center sm:contents")}>
        <Checkbox
          checked={isSelected}
          onCheckedChange={() => onToggleSelect(t.transferId, true)}
          aria-label={`Select ${title}`}
          className={cn("shrink-0", card && "mt-0.5")}
        />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-start gap-2.5">
            {showThumb ? heading.thumb : null}
            <div className="min-w-0 flex-1 space-y-1">
              {card ? (
                <span className="text-[13px] font-semibold tabular-nums text-foreground">{title}</span>
              ) : (
                heading.text
              )}
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge
                  variant={badge.variant}
                  title={badge.filesMissing ? "The downloaded files are no longer on disk" : undefined}
                  {...rowAttr(kind, "state")}
                  data-files-missing={badge.filesMissing || undefined}
                >
                  {done && !badge.filesMissing ? <Check className="h-3 w-3" aria-hidden /> : null}
                  {badge.label}
                </Badge>
                {t.imported && <Badge variant="outline">Imported</Badge>}
                {packLabel(t) ? (
                  <span className="text-[12px] text-muted-foreground" data-season-pack>
                    {packLabel(t)}
                  </span>
                ) : null}
                {forcedStartLabel(t) ? (
                  <span className="text-[12px] text-muted-foreground" {...rowAttr(kind, "forced")}>
                    {forcedStartLabel(t)}
                  </span>
                ) : waitReasonLabel(t.state, t.waitReason) ? (
                  <span
                    className="text-[12px] text-subtle-foreground"
                    data-wait-reason={t.waitReason ?? undefined}
                  >
                    {waitReasonLabel(t.state, t.waitReason)}
                  </span>
                ) : null}
                {/*
                  One quality tag at most (resolution). Source tags, peers and
                  the folder path are torrent mechanics: they live in the
                  menu's Details.
                */}
                <QualityChip label={quality} />
                {t.sizeBytes > 0 || showEta ? (
                  <span className="text-[12px] text-subtle-foreground tabular-nums">
                    {[t.sizeBytes > 0 ? formatBytes(t.sizeBytes) : null, showEta ? formatEta(t.eta) : null]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                ) : null}
              </div>
              {errorMessage ? (
                // One line keeps a list of failed rows scannable; the full
                // text is on hover and one tap away.
                <Collapsible open={errorExpanded} onOpenChange={setErrorExpanded}>
                  <CollapsibleTrigger
                    title={errorMessage}
                    className="block w-full truncate rounded-sm text-left text-[12px] leading-snug text-destructive outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:whitespace-normal max-md:min-h-11 pointer-coarse:min-h-11"
                    {...rowAttr(kind, "error-message")}
                  >
                    {errorMessage}
                  </CollapsibleTrigger>
                </Collapsible>
              ) : null}
              {showsProgressBar(t) ? (
                <TransferProgress
                  percent={pct}
                  tone={transferBarTone(t.state)}
                  label={`${title} download progress`}
                  speed={speed}
                  className="pt-0.5"
                  barClassName={card ? undefined : "max-w-[18rem]"}
                />
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {card ? (
        <div className="flex items-center justify-between gap-2 pt-0.5">
          <div className="flex min-w-0 flex-wrap items-center gap-2">{actions}</div>
          {menu}
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-2 lg:gap-1.5">
          {actions}
          {menu}
        </div>
      )}
    </div>
  );
}

/**
 * A series' summary: poster, title, rollup chip, facts, episode tally, the
 * one error worth repeating and the combined bar. The page's group row and
 * the dialog header both render it, so a series reads the same in both.
 */
export function DownloadGroupSummary({
  group,
  titleHref,
  posterUrl,
  heading = false,
  children,
}: {
  group: SeriesGroup<ClientTorrent>;
  titleHref: string | null;
  posterUrl?: string | null;
  /** The dialog's header names the dialog, so its title is a heading. */
  heading?: boolean;
  children?: ReactNode;
}) {
  const pct = progressPercent(group.progress);
  const chip = rollupChip(group);
  const tally = seriesEpisodeTally(group);
  // The title page's season line, worded the same; no aired total is known here.
  const tallyText = seasonProgressLabel({ ...tally, aired: null });
  const missingFiles = group.torrents.filter((t) => t.filesMissing === true).length;
  // Once several members failed the chip carries the count; repeating one
  // member's error text would read as if it were the whole series' story.
  const groupErrorMessage =
    group.counts.error === 1
      ? transferErrorMessage(group.torrents.find((t) => isError(t.state)) ?? { state: group.state })
      : null;
  const title = transferTitleParts({ title: group.title, href: titleHref, posterUrl, heading });
  return (
    <div className="flex min-w-0 flex-1 items-start gap-2.5">
      {title.thumb}
      <div className="min-w-0 flex-1 space-y-1">
        {title.text}
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={chip.variant} data-group-state>
            {chip.label}
          </Badge>
          {missingFiles > 0 ? (
            <Badge
              variant="danger"
              title={`${missingFiles} ${missingFiles === 1 ? "download's files are" : "downloads' files are"} no longer on disk`}
              data-files-missing
            >
              Files missing
            </Badge>
          ) : null}
          <span className="text-[12px] text-subtle-foreground tabular-nums">
            {group.releaseCount} {group.releaseCount === 1 ? "release" : "releases"}
            {" · "}
            {group.seasonCount} {group.seasonCount === 1 ? "season" : "seasons"}
            {group.sizeBytes > 0 ? ` · ${formatBytes(group.sizeBytes)}` : null}
          </span>
        </div>
        {tallyText ? (
          <p data-group-episodes className="text-[12px] tabular-nums text-muted-foreground">
            {tallyText}
          </p>
        ) : null}
        {groupErrorMessage ? (
          <p className="text-[12px] leading-snug text-destructive" data-group-error-message>
            {groupErrorMessage}
          </p>
        ) : null}
        {showsProgressBar(group) ? (
          <TransferProgress
            percent={pct}
            tone={transferBarTone(group.state, chip.failing)}
            label={`${group.title} combined download progress`}
            speed={isDownloading(group.state) ? formatSpeed(group.dlspeed) : null}
            className="pt-0.5"
            barClassName="max-w-[18rem]"
          />
        ) : null}
        {children}
      </div>
    </div>
  );
}
