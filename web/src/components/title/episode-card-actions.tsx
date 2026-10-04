import { MoreHorizontal,RotateCw,Search,X } from "lucide-react";
import { DownloadGlyph } from "./episode-card-progress";
import { PICK_RELEASE_LABEL } from "@/components/releases/release-picker-store";
import { FIND_ANOTHER_SOURCE_LABEL } from "@/components/releases/find-another-source";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AvailabilityChip } from "@/components/browse/availability-chip";
import { cn } from "@/lib/utils";
import { DropdownMenu,DropdownMenuContent,DropdownMenuItem,DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { OwnedQuality } from "./owned-quality";
import { TfOpenFileButton } from "@/components/tf/open-file-button";
import type { WantedAction } from "@/components/wanted/wanted-actions";
import type { EpisodeRowModel } from "./merge-extras";
import type { TitleAction,TitleActionStatus } from "./title-actions";
import { CARD_ACTION_PILL,CARD_ACTION_SLOT } from "./episode-card-layout";

type EpisodeCardActionModel = {
  episode: EpisodeRowModel; canDownload: boolean; canOpen: boolean; opening: boolean;
  openEpisodeFile: () => void; offerFindSource: boolean; sourceHash: string | null;
  onFindAnother?: (hash: string, episodeLabel: string) => void; waitingForSeasonList: boolean;
  onWantedAction?: (season: number, episode: number, action: WantedAction) => void;
  waitingForEnglish: boolean; onPickRelease?: (season: number, episode: number) => void;
  ownedText: string | null; downloadDisplayLabel: string; downloadAction: TitleAction;
  downloadStatus: TitleActionStatus; downloadCanRun: boolean; transfer: EpisodeRowModel["transfer"];
  held: boolean; onAction: (action: TitleAction, label: string, resolution?: number) => void;
  available: boolean; requesterLabel: string | null;
};

export function EpisodeCardActions({ model }: { model: EpisodeCardActionModel }) {
  const { episode, canDownload, canOpen, opening, openEpisodeFile, offerFindSource, sourceHash, onFindAnother, waitingForSeasonList, onWantedAction, waitingForEnglish, onPickRelease, ownedText, downloadDisplayLabel, downloadAction, downloadStatus, downloadCanRun, transfer, held, onAction, available, requesterLabel } = model;
  const findSourceMenu = offerFindSource && sourceHash ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon-lg"
          aria-label={`More actions for ${episode.label}`}
          data-episode-more
          onClick={(event) => event.stopPropagation()}
          className={cn(CARD_ACTION_PILL, "w-11")}
        >
          <MoreHorizontal aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onClick={() => onFindAnother?.(sourceHash, episode.label)}
          data-episode-find-source
        >
          <Search />
          {FIND_ANOTHER_SOURCE_LABEL}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;
  const wantedMenu = canDownload && waitingForSeasonList && onWantedAction != null ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon-lg"
          aria-label={`More actions for ${episode.label}`}
          data-episode-more
          onClick={(event) => event.stopPropagation()}
          className={cn(CARD_ACTION_PILL, "w-11")}
        >
          <MoreHorizontal aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onClick={() => onWantedAction(episode.season, episode.episode, "try-now")}
          data-episode-try-now
        >
          <RotateCw />
          Try now
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => onWantedAction(episode.season, episode.episode, "remove")}
          data-episode-remove
        >
          <X />
          Remove
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;

  return (
    <>
          {canOpen ? (
            <span className={CARD_ACTION_SLOT}>
              {findSourceMenu}
              <TfOpenFileButton
                name={episode.label}
                busy={opening}
                variant="outline"
                size="icon-lg"
                data-episode-action
                data-action="open"
                onClick={(event) => {
                  event.stopPropagation();
                  void openEpisodeFile();
                }}
                className={cn(CARD_ACTION_PILL, "w-auto px-3 text-[13px]")}
              />
            </span>
          ) : canDownload && ownedText && episode.owned ? (
            <span className={CARD_ACTION_SLOT}>
              <OwnedQuality
                variant="row"
                owned={episode.owned}
                pillClassName={CARD_ACTION_PILL}
              />
            </span>
          ) : canDownload && waitingForEnglish ? (
            <span className={CARD_ACTION_SLOT}>
              <Button
                type="button"
                variant="outline"
                size="icon-lg"
                data-episode-action
                data-action="pick-release"
                aria-label={`${PICK_RELEASE_LABEL}, ${episode.label}`}
                title={downloadDisplayLabel}
                onClick={(event) => {
                  event.stopPropagation();
                  onPickRelease?.(episode.season, episode.episode);
                }}
                className={cn(CARD_ACTION_PILL, "w-auto px-3 text-[13px]")}
              >
                <Search aria-hidden />
                Pick a release
              </Button>
            </span>
          ) : canDownload ? (
          <span className={CARD_ACTION_SLOT}>
            {findSourceMenu ?? wantedMenu}
            <Button
              type="button"
              variant="outline"
              size="icon-lg"
              data-episode-action
              data-action="download"
              data-action-kind={downloadAction.kind}
              aria-label={`${downloadDisplayLabel}, ${episode.label}`}
              aria-busy={downloadStatus === "pending" || undefined}
              disabled={!downloadCanRun}
              onClick={(event) => {
                event.stopPropagation();
                onAction(downloadAction, episode.label);
              }}
              className={cn(
                CARD_ACTION_PILL,
                transfer?.status === "downloading"
                  ? "w-auto px-2.5 text-brand-foreground"
                  : "w-11",
              )}
            >
              <DownloadGlyph
                transferStatus={transfer?.status ?? null}
                transferState={transfer?.state ?? null}
                queuePosition={transfer?.queuePosition ?? null}
                progress={transfer?.progress ?? null}
                held={held}
                status={downloadStatus}
              />
            </Button>
          </span>
          ) : available ? (
            <AvailabilityChip
              state="ready"
              data-episode-available
              className="absolute bottom-2 right-2 z-10 hidden sm:bottom-auto sm:top-2 sm:inline-flex"
            />
          ) : requesterLabel ? (
            <Badge
              data-episode-state={episode.state ?? undefined}
              className="absolute bottom-2 right-2 z-10 hidden bg-card/82 backdrop-blur-sm sm:bottom-auto sm:top-2 sm:inline-flex"
            >
              {requesterLabel}
            </Badge>
          ) : null}
    </>
  );
}
