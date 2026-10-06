import { Search } from "lucide-react";
import { send } from "@/lib/api";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/tf/confirm-dialog";
import { openReleasePicker } from "@/components/releases/release-picker-store";
import { TfEmptyState } from "@/components/tf/empty-state";
import { TfErrorState } from "@/components/tf/error-state";
import { TitleDetailSkeleton } from "./title-detail-skeleton";
import type { TitleDetailProps } from "./title-props";
import { useTitleDetailQuery } from "./use-title-detail-query";
import { useTitleDetailActions } from "./use-title-detail-actions";
import { useSeasonGrab } from "./use-season-grab";
import { useTitleContentState } from "./use-title-content-state";
import { useTitleContentViewModel } from "./use-title-content-view-model";
import { TitleHero } from "./title-hero";
import { TitleSections } from "./title-sections";
import { QualityPicker } from "./quality-picker";

export function TitleDetail(props: TitleDetailProps) {
  const query = useTitleDetailQuery(props);
  const actions = useTitleDetailActions(query);
  const seasonActions = useSeasonGrab(query);
  const detail = { ...query, ...actions, ...seasonActions };
  const {
    caps,
    loading,
    data,
    error,
    refetch,
    refreshing,
    extras,
    visibleProgress,
    extrasLoading,
    extrasRefreshing,
    extrasError,
    extrasSettled,
    activeSeason,
    refetchExtras,
    season,
    statusFor,
    seasonStatusFor,
    handleSeasonChange,
    runSeasonGrab,
    runAction,
    setFindAnother,
    findAnother,
    findingAnother,
    setFindingAnother,
  } = detail;
  const pickOwnRelease = () => {
    if (!findAnother || !data?.workKey) return;
    setFindAnother(null);
    openReleasePicker({
      workKey: data.workKey,
      title: findAnother.label,
      season: findAnother.season,
      episode: findAnother.packed ? null : findAnother.episode,
      replaceTransferId: `builtin:${findAnother.hash}`,
      onPicked: () => {
        detail.startTransferPoll();
        void refetch();
      },
    });
  };

  return (
    <div
      className="flex min-h-[calc(100dvh_-_var(--header-h)_-_var(--mobile-nav-h)_-_var(--safe-bottom))] min-w-0 flex-col md:min-h-[calc(100dvh_-_var(--header-h)_-_3.5rem)]"
      data-title-detail
    >
      {loading && !data ? (
        <TitleDetailSkeleton />
      ) : error ? (
        <div className="container-app py-10">
          <TfErrorState
            title="Could not load this title"
            message={error}
            onRetry={refetch}
            retrying={refreshing}
          />
        </div>
      ) : !data || !data.known ? (
        <div className="container-app py-10">
          <TfEmptyState
            icon={Search}
            title="We couldn't find this title"
            description="Try another search or browse the catalog."
            actionLabel="Back to browse"
            actionHref="/"
          />
        </div>
      ) : (
        <TitlePage
          payload={data}
          extras={extras}
          progress={visibleProgress}
          extrasLoading={extrasLoading}
          extrasRefreshing={extrasRefreshing}
          extrasError={extrasError}
          extrasSettled={extrasSettled}
          extrasSeason={activeSeason}
          refetchExtras={refetchExtras}
          season={season}
          refreshing={refreshing}
          statusFor={statusFor}
          seasonStatusFor={seasonStatusFor}
          onSeasonChange={handleSeasonChange}
          onSeasonGrab={runSeasonGrab}
          onAction={runAction}
          onLibraryChanged={refetch}
          onFindAnother={setFindAnother}
          routeTitle={props.title ?? null}
        />
      )}

      {findAnother && caps.canDownload ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open && !findingAnother) setFindAnother(null);
          }}
          title={`Find another source for ${findAnother.label}?`}
          description="The current download and its partial files will be removed. TorrentFlow will search again."
          variant="destructive"
          busy={findingAnother}
          confirmLabel="Pick best source"
          onConfirm={() => void (async () => {
            setFindingAnother(true);
            try {
              const response = await send<{ ok?: boolean; message?: string }>(`/api/downloads/${encodeURIComponent(findAnother.hash)}/find-another`, {
                method: "POST",
              });
              const result = response.data;
              if (!response.ok || result?.ok !== true) {
                toast.error(result?.message ?? "The download could not be removed. Try again.");
                return;
              }
              toast.success(result.message ?? `Looking for another source of ${findAnother.label}.`);
              setFindAnother(null);
              detail.startTransferPoll();
              void refetch();
            } catch {
              toast.error("Couldn't reach TorrentFlow. Try again.");
            } finally {
              setFindingAnother(false);
            }
          })()}
          secondaryAction={data?.workKey ? (
            <Button type="button" variant="outline" disabled={findingAnother}
              className="max-md:min-h-11 pointer-coarse:min-h-11"
              data-find-another-pick onClick={pickOwnRelease}>
              Pick my own
            </Button>
          ) : null}
        />
      ) : null}

    </div>
  );
}

function TitlePage(props: Parameters<typeof useTitleContentState>[0]) {
  const state = useTitleContentState(props);
  const model = useTitleContentViewModel(state);
  return (
    <>
      <article aria-labelledby="title-heading" className="flex min-w-0 grow flex-col">
        <TitleHero model={model} />
        <TitleSections model={model} />
      </article>
      {model.caps.canDownload ? (
        <QualityPicker
          open={model.qualityPickerOpen}
          onOpenChange={model.closeDownloadQuality}
          preferredResolution={model.preferredResolution}
          alwaysPreferred={model.alwaysPreferred}
          onAlwaysPreferredChange={model.setAlwaysPreferred}
          onConfirm={model.confirmDownloadQuality}
        />
      ) : null}
    </>
  );
}
