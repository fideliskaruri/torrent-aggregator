import { Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/tf/confirm-dialog";
import { EpisodeList } from "./episode-list";
import { MoreLikeThis } from "./more-like-this";
import { LinkedRecords } from "./linked-records";
import { wantedRemoveDescription } from "@/components/wanted/wanted-actions";
import type { TitleContentViewModel } from "./use-title-content-view-model";

export function TitleSections({ model }: { model: TitleContentViewModel }) {
  const { nothingBelowHero, payload, seasons, activeSeason, rows, allRows, truncated, episodeListState, refreshing, season, statusFor, activeSeasonGrabStatus, gated, onSeasonChange, requestSeasonGrab, handleEpisodeListAction, caps, handleFindEpisodeSource, handlePickEpisodeRelease, handleWantedAction, removingEpisode, setRemovingEpisode, episodeName, workKey, removingBusy, confirmRemoveEpisode, similar, similarLoading, hint } = model;
  return (
    <>
      {nothingBelowHero ? null : (
      <div className="container-app space-y-7 py-6 md:space-y-10 md:py-8">
        {payload.isSeries ? (
          <EpisodeList
            seasons={seasons}
            season={activeSeason}
            episodes={rows}
            episodeTotal={allRows.length}
            truncated={truncated}
            loadState={episodeListState}
            busy={rows.length === 0 && refreshing && season != null && season !== payload.season}
            statusFor={statusFor}
            seasonGrabStatus={activeSeasonGrabStatus}
            gated={gated}
            onSeasonChange={onSeasonChange}
            onSeasonGrab={requestSeasonGrab}
            onAction={handleEpisodeListAction}
            onFindAnother={caps.canDownload ? handleFindEpisodeSource : undefined}
            onPickRelease={caps.canDownload ? handlePickEpisodeRelease : undefined}
            onWantedAction={caps.canDownload ? handleWantedAction : undefined}
          />

        ) : null}

        {removingEpisode ? (
          <ConfirmDialog
            open
            onOpenChange={(open) => {
              if (!open) setRemovingEpisode(null);
            }}
            contentData={{ "data-looking-remove-dialog": true }}
            confirmData={{ "data-looking-remove-confirm": true }}
            title={`Remove ${episodeName(removingEpisode.season, removingEpisode.episode)}?`}
            description={wantedRemoveDescription({ workKey, ...removingEpisode })}
            variant="destructive"
            busy={removingBusy}
            icon={<Trash2 className="h-3.5 w-3.5" />}
            confirmLabel="Remove"
            onConfirm={() => void confirmRemoveEpisode()}
          />
        ) : null}


        <MoreLikeThis
          items={similar}
          loading={similarLoading}
        />


        {caps.canManage ? <LinkedRecords workKey={payload.workKey} /> : null}

        {hint ? (
          <p className="text-[12px] text-subtle-foreground" data-library-hint>
            {hint}
          </p>
        ) : null}
      </div>
      )}
    </>
  );
}
