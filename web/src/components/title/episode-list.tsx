import { useCallback,useEffect,useRef,useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SeasonSwitcher } from "@/components/tf/season-switcher";
import { useCapabilities } from "@/lib/capabilities";
import type { WantedAction } from "@/components/wanted/wanted-actions";
import { type EpisodeRowModel } from "./merge-extras";
import { episodeListView,episodeSeasonCountLabel,type EpisodeListLoadState } from "./episode-list-state";
import { type TitleAction,type TitleActionStatus } from "./title-actions";
import { canOfferSeasonGrab,shouldRunSeasonGrab,type SeasonGrabStatus,} from "./season-grab-state";
import { QualityPicker } from "./quality-picker";
import { shouldAskForQuality } from "./quality-picker-state";
import { usePreferredQuality } from "./use-preferred-quality";
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
  onSeasonGrab: (season: number, episodes: number[], resolution?: number) => void;
  onAction: (action: TitleAction, label: string, resolution?: number) => void;
    onFindAnother?: (hash: string, episodeLabel: string) => void;
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
  const { preferredResolution, alwaysPreferred, setAlwaysPreferred } = usePreferredQuality();
  type PendingDownload =
    | { kind: "episode"; action: TitleAction; label: string }
    | { kind: "season"; targetSeason: number; episodeNums: number[] };
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pendingDownload, setPendingDownload] = useState<PendingDownload | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const stripViewport = useCallback(
    () =>
      stripRef.current?.querySelector<HTMLElement>(
        '[data-slot="scroll-area-viewport"]',
      ) ?? null,
    [],
  );
  const [edges, setEdges] = useState({ start: false, end: false });
  const updateEdges = useCallback(() => {
    const el = stripViewport();
    if (!el) return;
    const start = el.scrollLeft > 4;
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
    setEdges((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, [stripViewport]);
  useEffect(() => {
    const el = stripViewport();
    if (!el || typeof ResizeObserver === "undefined") return;
    updateEdges();
    el.addEventListener("scroll", updateEdges, { passive: true });
    const observer = new ResizeObserver(updateEdges);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", updateEdges);
      observer.disconnect();
    };
  }, [stripViewport, updateEdges, episodes.length, loadState.status, busy]);

  const openPickerFor = useCallback((pending: PendingDownload) => {
    setPendingDownload(pending);
    setPickerOpen(true);
  }, []);
  const handleCardAction = useCallback(
    (action: TitleAction, label: string) => {
      if (shouldAskForQuality(alwaysPreferred)) {
        openPickerFor({ kind: "episode", action, label });
      } else {
        onAction(action, label, preferredResolution);
      }
    },
    [alwaysPreferred, preferredResolution, onAction, openPickerFor],
  );

  function handlePickerConfirm(resolution: number) {
    setPickerOpen(false);
    if (!pendingDownload) return;
    if (pendingDownload.kind === "episode") {
      onAction(pendingDownload.action, pendingDownload.label, resolution);
    } else {
      onSeasonGrab(pendingDownload.targetSeason, pendingDownload.episodeNums, resolution);
    }
    setPendingDownload(null);
  }

  function handlePickerOpenChange(open: boolean) {
    setPickerOpen(open);
    if (!open) setPendingDownload(null);
  }

  function scrollStrip(direction: -1 | 1) {
    const el = stripViewport();
    if (!el) return;
    el.scrollBy({ left: direction * Math.round(el.clientWidth * 0.9), behavior: "smooth" });
  }

  const view = episodeListView(loadState, episodes.length);
  const showSeasonGrab = !gated && canOfferSeasonGrab(season, episodes.length);
  const seasonDownloadCanRun =
    showSeasonGrab && shouldRunSeasonGrab(seasonGrabStatus);
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
                  if (season == null) return;
                  const episodeNums = episodes.map((e) => e.episode);
                  if (shouldAskForQuality(alwaysPreferred)) {
                    openPickerFor({ kind: "season", targetSeason: season, episodeNums });
                  } else {
                    onSeasonGrab(season, episodeNums, preferredResolution);
                  }
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
        loadState={loadState}
        busy={busy}
        season={season}
        stripRef={stripRef}
        edges={edges}
        scrollStrip={scrollStrip}
        statusFor={statusFor}
        gated={gated}
        onAction={handleCardAction}
        onFindAnother={onFindAnother}
        onPickRelease={onPickRelease}
        onWantedAction={onWantedAction}
      />

      <QualityPicker
        open={pickerOpen}
        onOpenChange={handlePickerOpenChange}
        preferredResolution={preferredResolution}
        alwaysPreferred={alwaysPreferred}
        onAlwaysPreferredChange={setAlwaysPreferred}
        onConfirm={handlePickerConfirm}
      />
    </section>
  );
}
