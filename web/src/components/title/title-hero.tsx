/**
 * The title page — the spine of the product.
 *
 * The complaint this answers, in the user's words: *"this is not a product,
 * it's a website you go to view torrent lists."* It was true, and structurally
 * so: clicking a title anywhere in the app landed on `/search`, a table of
 * release names, seeders and magnet links. This page is *see art → click → a
 * page about the title → press Download*.
 *
 * So the layout is built around acquiring the title, never "Search" and never
 * a releases table. Getting is one press, performed by the server, and does
 * not navigate anywhere. Finished files open in the owner's own player from
 * Downloads; nothing on this page plays.
 *
 * Two things about the states on this page:
 *
 *  - `availability: null` means *nobody has checked*, and renders as an
 *    ordinary clickable Download. It is not a disabled control and it is not
 *    `unavailable`.
 *  - Error and empty are one exclusive chain, not two independent `{x ? …}`
 *    blocks — the bug that told `/watchlist` users their library was empty
 *    when the request had actually failed.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { get, send } from "@/lib/api";
import type { ReactNode } from "react";
import { CheckCircle2, Download, FolderOpen, Loader2, Search, Trash2 } from "lucide-react";
import { Link, useNavigate, type NavigateFunction } from "react-router";
import { toast } from "@/lib/toast";
import { useFeatures } from "@/lib/features";
import { openDownload, type OpenDownloadMode } from "@/lib/open-download";
import { ConfirmDialog } from "@/components/tf/confirm-dialog";
import { PosterImage } from "@/components/browse/poster-image";
import { posterTint } from "@/components/browse/poster";
import { cleanDisplayTitle } from "@/lib/title/display-title";
import { headingTitle } from "./heading-title";
import { TfEmptyState } from "@/components/tf/empty-state";
import { TfErrorState } from "@/components/tf/error-state";
import { TfOpenFileButton } from "@/components/tf/open-file-button";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useApiQuery } from "@/hooks/use-api-query";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { cn } from "@/lib/utils";
import { ButtonBody } from "./button-body";
import { requestTitleFor } from "./title-payload";
import { browseReleaseGate } from "@/lib/browse/release-status";
import { ReleaseGateChip } from "@/components/browse/release-gate-chip";
import { EpisodeList, episodeIntentKey } from "./episode-list";
import { extrasRequestPending } from "./episode-list-state";
import { LibraryControls } from "./library-controls";
import { libraryHint } from "./library-hint";
import { mergeEpisodes, mergeSeasons, isUnaired } from "./merge-extras";
import { WatchStateChip } from "./watch-state";
import { ownedLabel } from "./owned-state";
import { OwnedQuality } from "./owned-quality";
import { providerAiredFor, seasonProgressFromRows, seasonProgressFromSummary, seasonProgressLabel, showProgressFromSeasons, type SeasonProgress, } from "./season-progress";
import { SeasonProgressMeter } from "./season-progress-meter";
import { MoreLikeThis } from "./more-like-this";
import { LinkedRecords } from "./linked-records";
import { RequestAction } from "@/components/requests/request-action";
import { WantedActions, stopWanted, tryWantedNow, useWantedRows, wantedRemoveDescription, type WantedAction, } from "@/components/wanted/wanted-actions";
import { useCapabilities } from "@/lib/capabilities";
import { parseRequestState, type RequesterTitle } from "@/lib/requests";
import type { CatalogIdentity } from "@/lib/browse/types";
import { QualityPicker } from "./quality-picker";
import { shouldAskForQuality } from "./quality-picker-state";
import { usePreferredQuality } from "./use-preferred-quality";
import { formatReleaseDate, GenreChips, HeroMetaList, RatingMetaLine, releaseYear, } from "./title-hero-meta";
import { needsEpisodeDiscovery, resolveTitleTransferControl, shouldRunTitleAction, type TitleAction, type TitleActionStatus, } from "./title-actions";
import { SeasonGrabFailureError, seasonGrabFailureDescription, seasonGrabKey, seasonGrabRetryEpisodes, shouldRetrySeasonGrab, shouldRunSeasonGrab, type SeasonGrabReport, type SeasonGrabStatus, } from "./season-grab-state";
import { NoReleaseFoundError, postTitleAction, rethrowAcquisitionFetchError, } from "./title-action-request";
import { encodeKeySegment } from "./work-key";
import { toastDownloadOutcome } from "@/components/releases/download-outcome-toast";
import { canFindAnotherSource, FIND_ANOTHER_SOURCE_LABEL } from "@/components/releases/find-another-source";
import { openReleasePicker } from "@/components/releases/release-picker-store";
import { isValidSeason, nextRememberedSeasonCookieValue, readRememberedSeason, REMEMBERED_SEASON_COOKIE_NAME, } from "@/lib/title/remembered-season";
import { resolveInitialSeason, resolveSeasonOnPropsChange, } from "./season-persistence";
import { StorageCapDialog } from "@/components/storage/storage-cap-dialog";
import { useStorageCapOverride } from "@/components/storage/use-storage-cap-override";
import { parseStorageOverrideFacts, StorageLimitError, } from "@/lib/library/storage-override";
import type { TitleDetailPayload, TitleEpisodeTransfer, TitleExtrasPayload, TitleProgressPayload, TitleSeasonGrabResponse, } from "./types";


import { TitleHeroActions } from "./title-hero-actions";
import { TitleHeroDetails } from "./title-hero-details";
import type { TitleContentModel } from "./use-title-content-model";

const DOWNLOAD_KEY = "download";

export function TitleHero({ model }: { model: TitleContentModel }) {
  const { payload, title, nothingBelowHero, caps, heroPicker, setHeroPicker, preferredResolution, alwaysPreferred, setAlwaysPreferred, onAction, downloadAction, downloadLabelTarget, backdrop, gated, titlePending, heroExtrasPending, releaseGate, metaScore, metaYear, extras, seasonCount, showProgress, showProgressText } = model;
  return (
    <>
      <header
        data-title-hero
        data-hero-fills={nothingBelowHero || undefined}
        className={cn(
          "relative isolate flex flex-col overflow-hidden bg-card",
          nothingBelowHero ? "grow justify-start" : "justify-end border-b border-border",
        )}
      >
        <div
          className="absolute inset-0 -z-10"
          style={{ background: posterTint(title) }}
        >
          {backdrop ? (

            <PosterImage
              src={backdrop}
              title={title}
              sizes="100vw"
              priority
              variant="plain"
              className={cn(
                "scale-[1.06] object-cover object-[center_22%] blur-[3px]",
                gated && "grayscale",
              )}
            />
          ) : null}
        </div>

        <div
          aria-hidden
          className="absolute inset-0 -z-10 bg-background/52"
        />
        <div
          aria-hidden
          className="absolute inset-0 -z-10 bg-[linear-gradient(to_top,var(--bg)_0%,color-mix(in_srgb,var(--bg)_88%,transparent)_34%,color-mix(in_srgb,var(--bg)_45%,transparent)_68%,transparent_100%)]"
        />
        <div
          aria-hidden
          className="absolute inset-0 -z-10 bg-[linear-gradient(to_right,var(--bg)_0%,color-mix(in_srgb,var(--bg)_70%,transparent)_45%,transparent_88%)]"
        />

        <div className="container-app">


          <div
            className={cn(
              "grid grid-cols-1 items-end gap-x-4 gap-y-5 py-5 sm:py-8 md:grid-cols-[168px_minmax(0,1fr)] md:gap-x-6 md:py-10 lg:grid-cols-[196px_minmax(0,1fr)] lg:py-10",
              payload.isSeries
                ? "min-h-0 md:min-h-[18rem] lg:min-h-[20rem]"
                : "min-h-0 md:min-h-[21rem] lg:min-h-[24rem]",
            )}
          >

            <div className="w-[104px] shrink-0 self-end sm:w-[120px] md:row-span-2 md:w-[168px] lg:w-[196px]">
              <div
                className={cn(
                  "relative aspect-[2/3] w-full overflow-hidden rounded-lg border border-border bg-muted shadow-md",
                  gated && "grayscale",
                )}
              >
                {titlePending && !payload.posterUrl ? (
                  <Skeleton className="size-full rounded-none" aria-hidden="true" data-title-poster-pending />
                ) : (
                  <PosterImage
                    src={payload.posterUrl}
                    title={title}
                    sizes="(min-width: 1024px) 196px, (min-width: 768px) 168px, (min-width: 640px) 120px, 104px"
                    priority
                  />
                )}
              </div>
            </div>

            <div className="min-w-0 flex-1">
              <h1
                id="title-heading"
                title={titlePending ? undefined : title}
                aria-busy={titlePending || undefined}
                data-title-heading-pending={titlePending ? "" : undefined}
                className="break-words text-[clamp(1.75rem,7vw,2.25rem)] font-semibold leading-[1.05] tracking-[-0.03em] text-foreground md:text-display"
              >
                {titlePending ? (
                  <>
                    <span className="sr-only">Loading title</span>

                    <span aria-hidden="true" className="block h-[1em] w-3/4 max-w-[28rem] animate-pulse rounded bg-muted" />
                  </>
                ) : (
                  title
                )}
              </h1>


              <div
                className={cn(
                  "mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-2",
                  heroExtrasPending && "min-h-7",
                )}
              >
                {gated ? (
                  <ReleaseGateChip gate={releaseGate} data-title-coming />
                ) : null}
                <RatingMetaLine
                  rating={metaScore.rating}
                  voteCount={metaScore.voteCount}
                  ratingSource={metaScore.source}
                  year={metaYear}
                  isSeries={payload.isSeries}
                  seasonCount={seasonCount}
                />
                <WatchStateChip state={payload.watchState} nextUp={payload.jellyfinNextUp}
                  className="mt-2 h-7 rounded-full bg-background/60 px-2.5" />
              </div>


              {extras?.partOf ? (
                <p className="mt-1 text-[13px] text-muted-foreground" data-title-part-of>
                  {extras.seasons.length > 0
                    ? `Season ${extras.seasons.join(", ")} of `
                    : "Part of "}
                  <Button asChild variant="link" size="sm" className="h-auto min-h-11 px-0 align-middle text-[13px]">
                    <Link to={extras.partOf.href}>{extras.partOf.title}</Link>
                  </Button>
                </p>
              ) : null}


              {showProgress && showProgressText ? (
                <SeasonProgressMeter
                  progress={showProgress}
                  label={showProgressText}
                  className="mt-3 text-[13px]"
                  data-show-progress
                />
              ) : null}


              <TitleHeroActions model={model} />

            </div>



            <TitleHeroDetails model={model} />
          </div>
        </div>
      </header>


      {caps.canDownload ? (
      <QualityPicker
        open={heroPicker}
        onOpenChange={setHeroPicker}
        preferredResolution={preferredResolution}
        alwaysPreferred={alwaysPreferred}
        onAlwaysPreferredChange={setAlwaysPreferred}
        onConfirm={(resolution) => {
          setHeroPicker(false);
          onAction(
            downloadAction,
            DOWNLOAD_KEY,
            downloadLabelTarget,
            resolution,
          );
        }}
      />
      ) : null}


    </>
  );
}
