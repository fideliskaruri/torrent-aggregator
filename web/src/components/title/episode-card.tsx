import { useState } from "react";
import { EpisodeStillImage } from "./episode-card-image";
import { Tv,X } from "lucide-react";
import { canFindAnotherSource } from "@/components/releases/find-another-source";
import { Badge } from "@/components/ui/badge";
import { WatchStateChip,watchStateLabel } from "./watch-state";
import { ownedLabel } from "./owned-state";
import { MediaPoster } from "@/components/browse/media-poster-card";
import { Button } from "@/components/ui/button";
import { Collapsible,CollapsibleContent,CollapsibleTrigger,} from "@/components/ui/collapsible";
import { Progress } from "@/components/ui/progress";
import { formatRuntimeMinutes } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useCapabilities } from "@/lib/capabilities";
import { useFeatures } from "@/lib/features";
import { openDownload } from "@/lib/open-download";
import type { WantedAction } from "@/components/wanted/wanted-actions";
import { formatAirDate,isUnaired,type EpisodeRowModel,} from "./merge-extras";
import { transferStateLabel,type TitleAction,type TitleActionStatus,} from "./title-actions";
import { EpisodeCardActions } from "./episode-card-actions";
import { CARD_WIDTH } from "./episode-card-layout";
import { titleDownloadPresentation } from "./title-download-state";
import { audioCheck, audioCheckLabel } from "@/lib/library/audio-check";
function progressPercent(fraction: number | null | undefined): number {
  if (fraction == null || !Number.isFinite(fraction)) return 0;
  return Math.round(Math.min(1, Math.max(0, fraction)) * 100);
}
function EpisodeCardImpl({
  episode,
  gated = false,
  downloadStatus,
  onAction,
  onFindAnother,
  onPickRelease,
  onWantedAction,
  onFilesChanged,
}: {
  episode: EpisodeRowModel;
    gated?: boolean;
  downloadStatus: TitleActionStatus;
  onAction: (action: TitleAction, label: string, resolution?: number) => void;
  onFindAnother?: (hash: string, episodeLabel: string, season: number, episode: number, packed: boolean) => void;
  onPickRelease?: (season: number, episode: number) => void;
  onWantedAction?: (season: number, episode: number, action: WantedAction) => void;
  onFilesChanged?: () => void;
}) {
  const { canDownload, canSeePaths } = useCapabilities();
  const { openFolder } = useFeatures();
  const transfer = episode.transfer;
  const downloadAction: TitleAction = {
    kind: "get",
    label: "Download",
    season: episode.season,
    episode: episode.episode,
    infoHash: episode.infoHash,
  };
  const presentation = titleDownloadPresentation({
    available: episode.available,
    owned: episode.owned,
    transfer,
    fromPack: episode.fromPack,
    actionStatus: downloadStatus,
  });
  const onDisk = presentation.onDisk;
  const held = presentation.held;
  const ownedText = ownedLabel(episode.owned);
  const audio = onFilesChanged ? audioCheck(episode.owned) : ({ kind: "ok" } as const);
  const audioLabel = audioCheckLabel(audio);
  const audioProblem = audio.kind === "wrong-audio" || audio.kind === "failed";
  const downloadDisplayLabel = presentation.label;
  const waitingForEnglish = transfer?.state === "waiting_english" && onPickRelease != null;
  const waitingForSeasonList = transfer?.state === "waiting_season_list";
  const downloadCanRun =
    !held &&
    (presentation.state === "download" || presentation.state === "retry");
  const openHash = held && !episode.fromPack ? (transfer?.infoHash ?? episode.infoHash) : null;
  const canOpen = canSeePaths && openFolder && Boolean(openHash);
  const [opening, setOpening] = useState(false);
  const openEpisodeFile = async () => {
    if (!openHash || opening) return;
    setOpening(true);
    try {
      await openDownload(openHash, "open");
    } finally {
      setOpening(false);
    }
  };
  const sourceHash = transfer?.infoHash ?? (held ? episode.infoHash : null);
  const offerFindSource =
    canDownload &&
    onFindAnother != null &&
    sourceHash != null &&
    canFindAnotherSource({
      builtin: true,
      hash: sourceHash,
      pack: episode.fromPack,
      finished: held || (transfer?.progress ?? 0) >= 0.9999,
    });
  const meta = episode.meta;
  const airDate = formatAirDate(meta?.airDate ?? null);
  const unaired = !onDisk && (gated || isUnaired(meta?.airDate ?? null));
  const downloadingProgress =
    transfer?.status === "downloading" ? transfer.progress : null;
  const progressPct = held
    ? 0
    : progressPercent(episode.downloadFraction ?? downloadingProgress);
  const episodeName = meta?.name?.trim() || `Episode ${episode.episode}`;
  const [synopsisOpen, setSynopsisOpen] = useState(false);
  const overview = meta?.overview?.trim() || null;
  const overviewClamped = overview != null && overview.length > 90;
  const runtime = formatRuntimeMinutes(meta?.runtimeMin ?? null);
  const desktopFacts = [airDate, runtime].filter(Boolean).join(" · ");
  const still = (
    <MediaPoster
      variant="episode"
      src={meta?.stillUrl}
      title={episodeName}
      data-episode-still
      image={
        meta?.stillUrl ? (
          <EpisodeStillImage src={meta.stillUrl} title={episodeName} />
        ) : (
          <span aria-hidden className="absolute inset-0 flex items-center justify-center text-input">
            <Tv className="size-6 sm:size-8" />
          </span>
        )
      }
    >
      <Badge
        data-episode-badge
        className="absolute left-2 top-2 border-transparent bg-background/80 font-semibold tabular-nums text-foreground backdrop-blur-sm"
      >
        E{episode.episode}
      </Badge>
      <WatchStateChip state={episode.watchState} className="absolute bottom-2 left-2 hidden sm:inline-flex" />
      {progressPct > 0 ? (
        <Progress
          data-episode-progress
          value={progressPct}
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-1 rounded-none bg-background/55"
          indicatorClassName="bg-brand-foreground"
        />
      ) : null}
    </MediaPoster>
  );

  const available = presentation.onDisk;
  const requesterLabel = available ? "Ready" : transferStateLabel(episode.state);
  const mobileMeta = [
    airDate,
    watchStateLabel(episode.watchState),
    canDownload ? (audioLabel ?? ownedText ?? downloadDisplayLabel) : requesterLabel,
  ]
    .filter(Boolean)
    .join(" · ");

  const caption = (
    <span className={cn("min-w-0 flex-1 p-3 sm:flex sm:flex-col sm:p-3", !unaired && "pb-14 sm:pb-3")}>
      <span
        data-episode-name
        title={episodeName}
        className="line-clamp-2 break-words text-[13px] font-medium text-foreground sm:block sm:truncate"
      >
        {episodeName}
      </span>
      {mobileMeta ? (
        <span className="mt-1 block break-words text-[12px] leading-relaxed text-subtle-foreground sm:hidden">
          {mobileMeta}
        </span>
      ) : null}

      <span
        data-episode-overview
        className="mt-1 hidden min-h-[calc(2*1.625*12px)] text-[12px] leading-relaxed text-subtle-foreground sm:line-clamp-2"
      >
        {overview ?? ""}
      </span>

      <span
        data-episode-unaired={unaired || undefined}
        data-episode-audio={audioLabel ? audio.kind : undefined}
        className={cn(
          "mt-2 hidden min-h-5 items-center text-[12px] tabular-nums sm:flex",
          audioLabel ? (audioProblem ? "font-medium text-destructive" : "font-medium text-info") : "text-subtle-foreground",
        )}
      >
        {unaired
          ? airDate ? `Airs ${airDate}` : "Not aired yet"
          : audioLabel ?? (waitingForEnglish || waitingForSeasonList ? downloadDisplayLabel : desktopFacts)}
      </span>
    </span>
  );
  const closeSynopsis = (from: HTMLElement) => {
    const toggle = from
      .closest("li")
      ?.querySelector<HTMLButtonElement>("[data-episode-synopsis-toggle]");
    setSynopsisOpen(false);
    toggle?.focus();
  };
  const synopsis = overviewClamped && overview ? (
    <Collapsible open={synopsisOpen} onOpenChange={setSynopsisOpen}>
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="link"
          data-episode-synopsis-toggle
          aria-label={`Read the synopsis of ${episodeName}`}
          onClick={(event) => event.stopPropagation()}
          className="absolute bottom-0 right-0 z-10 hidden h-11 rounded-none px-3 text-xs text-muted-foreground underline-offset-2 hover:text-foreground focus-visible:ring-inset sm:inline-flex"
        >
          More
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent asChild>
        <div
          data-episode-synopsis
          role="region"
          aria-label={`Synopsis of ${episodeName}`}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            closeSynopsis(event.currentTarget);
          }}
          className="absolute inset-0 z-20 hidden flex-col bg-card p-3 sm:flex"
        >
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 text-[13px] font-medium text-foreground">
              <span className="tabular-nums text-subtle-foreground">E{episode.episode}</span>{" "}
              {episodeName}
            </p>
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              aria-label="Close synopsis"
              onClick={(event) => closeSynopsis(event.currentTarget)}
              autoFocus
              className="-mr-2 -mt-2 size-11 text-muted-foreground"
            >
              <X aria-hidden />
            </Button>
          </div>
          <p className="mt-1 min-h-0 flex-1 overflow-y-auto pr-1 text-[12px] leading-relaxed text-muted-foreground">
            {overview}
          </p>
          {desktopFacts ? (
            <p className="mt-2 text-[12px] tabular-nums text-subtle-foreground">{desktopFacts}</p>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  ) : null;
  return (
    <li
      data-episode-row
      data-episode={episode.episode}
      data-availability={episode.availability ?? "unresolved"}
      className={cn("surface relative overflow-hidden p-0", CARD_WIDTH)}
    >
      {unaired ? (
        <div className="flex min-h-[96px] sm:block">{still}{caption}</div>
      ) : (
        <>
          <div className="flex min-h-[96px] w-full items-stretch text-left sm:block sm:min-h-0">
            <span className="relative block shrink-0">{still}</span>{caption}
          </div>
          <EpisodeCardActions
            episode={episode}
            canDownload={canDownload}
            canOpen={canOpen}
            opening={opening}
            openEpisodeFile={openEpisodeFile}
            offerFindSource={offerFindSource}
            sourceHash={sourceHash}
            onFindAnother={onFindAnother}
            waitingForSeasonList={waitingForSeasonList}
            onWantedAction={onWantedAction}
            waitingForEnglish={waitingForEnglish}
            onPickRelease={onPickRelease}
            ownedText={ownedText}
            downloadDisplayLabel={downloadDisplayLabel}
            downloadAction={downloadAction}
            downloadStatus={downloadStatus}
            downloadCanRun={downloadCanRun}
            transfer={transfer}
            onAction={onAction}
            available={available}
            requesterLabel={requesterLabel}
            presentation={presentation}
            audio={audio}
            onFilesChanged={onFilesChanged}
          />
        </>
      )}
      {synopsis}
    </li>
  );
}

export type EpisodeCardProps = Parameters<typeof EpisodeCardImpl>[0];

export const EpisodeCard = EpisodeCardImpl;
