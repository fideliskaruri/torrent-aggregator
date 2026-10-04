import { Search } from "lucide-react";
import { send } from "@/lib/api";
import { toast } from "@/lib/toast";
import { ConfirmDialog } from "@/components/tf/confirm-dialog";
import { TfEmptyState } from "@/components/tf/empty-state";
import { TfErrorState } from "@/components/tf/error-state";
import { StorageCapDialog } from "@/components/storage/storage-cap-dialog";
import { TitleContent } from "./title-content";
import { TitleDetailSkeleton } from "./title-detail-skeleton";
import type { TitleDetailProps } from "./title-props";
import { useTitleDetail } from "./use-title-detail";

export function TitleDetail(props: TitleDetailProps) {
  const detail = useTitleDetail(props);
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
    cap,
  } = detail;

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
        <TitleContent
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
          provider={props.provider ?? null}
          providerId={props.providerId ?? null}
          routeTitle={props.title ?? null}
        />
      )}

      {findAnother && caps.canDownload ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open && !findingAnother) setFindAnother(null);
          }}
          title={`Find another release for ${findAnother.label}?`}
          description="The current download and its partial files will be removed. TorrentFlow will search again."
          variant="destructive"
          busy={findingAnother}
          confirmLabel="Find another"
          onConfirm={() => void (async () => {
            setFindingAnother(true);
            try {
              const response = await send(`/api/downloads/${encodeURIComponent(findAnother.hash)}/find-another`, {
                method: "POST",
              });
              const result = await response.json().catch(() => null) as { ok?: boolean; message?: string } | null;
              if (!response.ok || result?.ok !== true) {
                toast.error(result?.message ?? "The download could not be removed. Try again.");
                return;
              }
              toast.success(result.message ?? `Looking for another release of ${findAnother.label}.`);
              setFindAnother(null);
              detail.startTransferPoll();
              void refetch();
            } catch {
              toast.error("Couldn't reach TorrentFlow. Try again.");
            } finally {
              setFindingAnother(false);
            }
          })()}
        />
      ) : null}

      <StorageCapDialog {...cap.dialogProps} />
    </div>
  );
}
