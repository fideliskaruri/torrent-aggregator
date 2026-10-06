import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SeasonSwitcher } from "@/components/tf/season-switcher";
import { useCapabilities } from "@/lib/capabilities";
import type { WantedAction } from "@/components/wanted/wanted-actions";
import { type EpisodeRowModel } from "./merge-extras";
import { episodeListView,episodeSeasonCountLabel,type EpisodeListLoadState } from "./episode-list-state";
import { type TitleAction,type TitleActionStatus } from "./title-actions";
import { canOfferSeasonGrab,type SeasonGrabStatus,} from "./season-grab-state";
import type { TitleSeason } from "./types";
import { seasonProgressLabel,type SeasonProgress } from "./season-progress";
import { SeasonProgressMeter } from "./season-progress-meter";

import { ButtonBody } from "./button-body";
import { EpisodeStrip } from "./episode-strip";
export { episodeIntentKey } from "./episode-key";

export interface EpisodeListProps {
  seasons: TitleSeason[];
    seasonProgress?: Record<number, SeasonProgress>;
  season: number | null;
  episodes: EpisodeRowModel[];
    episodeTotal?: number;
  truncated: boolean;
  loadState: EpisodeListLoadState;
    busy: boolean;
  statusFor: (key: string) => TitleActionStatus;
  seasonGrabStatus: SeasonGrabStatus;
    gated?: boolean;
  onSeasonChange: (season: number) => void;
  onSeasonGrab: (season: number) => void;
  onAction: (action: TitleAction, label: string, resolution?: number) => void;
    onFindAnother?: (hash: string, episodeLabel: string, season: number, episode: number, packed: boolean) => void;
    onPickRelease?: (season: number, episode: number) => void;
    onWantedAction?: (season: number, episode: number, action: WantedAction) => void;
}

export function EpisodeList({
  seasons,
  seasonProgress = {},
  season,
  episodes,
  episodeTotal,
  truncated,
  loadState,
  busy,
  statusFor,
  seasonGrabStatus,
  gated = false,
  onSeasonChange,
  onSeasonGrab,
  onAction,
  onFindAnother,
  onPickRelease,
  onWantedAction,
}: EpisodeListProps) {
  const { canDownload } = useCapabilities();

  const view = episodeListView(loadState, episodes.length);
  const showSeasonGrab = !gated && canOfferSeasonGrab(season);
  const seasonDownloadCanRun =
    showSeasonGrab && seasonGrabStatus.status !== "pending" && seasonGrabStatus.status !== "done";
  const seasonCountLabel =
    season != null
      ? episodeSeasonCountLabel(Math.max(episodeTotal ?? 0, episodes.length), loadState, season)
      : null;
  const activeProgress =
    season != null && !busy && view.kind !== "loading" ? seasonProgress[season] ?? null : null;
  const activeProgressLabel = activeProgress ? seasonProgressLabel(activeProgress) : null;
  const seasonLineLabel = activeProgressLabel;

  return (
    <section aria-labelledby="title-episodes-heading" data-title-episodes>
      {seasons.length > 1 || showSeasonGrab || season != null ? (
        <div
          data-season-toolbar
          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 sm:flex sm:flex-wrap"
        >
          <h2 id="title-episodes-heading" className="text-title min-w-0 sm:w-auto">
            Episodes
          </h2>
          <div className="col-span-2 row-start-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 sm:col-auto sm:row-auto">
            {seasons.length > 1 ? (
              <SeasonSwitcher
                variant="select"
                options={seasons.map((s) => ({
                  value: String(s.season),
                  label: `Season ${s.season}`,
                  attrs: { "data-season-option": s.season },
                }))}
                value={season != null ? String(season) : null}
                onValueChange={(value) => {
                  const next = Number(value);
                  if (Number.isFinite(next)) onSeasonChange(next);
                }}
                align="start"
                triggerAttrs={{ "data-season-select": "" }}
                triggerClassName="min-w-0 shrink-0 bg-card font-medium dark:bg-card"
              />
            ) : season != null ? (
              <span
                data-season-label
                className="text-[13px] font-medium text-foreground"
              >
                Season {season}
              </span>
            ) : null}

            {seasonCountLabel && !(activeProgressLabel && activeProgress?.aired != null) ? (
              <p
                data-season-count
                className="text-[12px] tabular-nums text-subtle-foreground"
              >
                {seasonCountLabel}
              </p>
            ) : null}

            {activeProgress && seasonLineLabel ? (
              <SeasonProgressMeter
                progress={activeProgress}
                label={seasonLineLabel}
                data-season-progress
              />
            ) : null}
          </div>

          {showSeasonGrab && canDownload && season != null ? (
            <div className="col-start-2 row-start-1 ml-auto flex items-center justify-end sm:col-auto sm:row-auto sm:w-auto">
              <Button
                type="button"
                size="sm"
                data-season-grab
                data-action="download"
                aria-busy={seasonGrabStatus.status === "pending" || undefined}
                disabled={!seasonDownloadCanRun}
                onClick={() => {
                  if (season != null) onSeasonGrab(season);
                }}
                className="relative min-h-[44px] w-auto lg:min-h-0"
              >
                <ButtonBody
                  pending={seasonGrabStatus.status === "pending"}
                  icon={<Download aria-hidden />}
                >
                  Download season
                </ButtonBody>
              </Button>
            </div>
          ) : null}

        </div>
      ) : (
        <h2 id="title-episodes-heading" className="text-title">Episodes</h2>
      )}

      <EpisodeStrip
        episodes={episodes}
        truncated={truncated}
        view={view}
        busy={busy}
        season={season}
        statusFor={statusFor}
        gated={gated}
        onAction={onAction}
        onFindAnother={onFindAnother}
        onPickRelease={onPickRelease}
        onWantedAction={onWantedAction}
      />

    </section>
  );
}
