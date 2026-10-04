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
import type { TitleContentModel } from "./use-title-content-model";
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


export function TitleHeroDetails({ model }: { model: TitleContentModel }) {
  const { payload, extras, heroExtrasPending, genres, metaListPresent, releaseDate } = model;
  return (
            <div className="min-w-0 flex flex-col gap-4 md:col-start-2 md:flex-row md:gap-8">

                <div className="min-w-0 flex-1 md:max-w-2xl md:min-h-[9.40625rem]">
                  {payload.overview ?? extras?.overview ? (
                    <p
                      data-title-overview
                      className="text-body line-clamp-5 max-w-xl"
                    >
                      {payload.overview ?? extras?.overview}
                    </p>
                  ) : heroExtrasPending ? (
                    <div aria-hidden data-title-overview-placeholder className="max-w-xl">
                      <div className="text-body">
                        {["w-full", "w-full", "w-11/12", "w-full", "w-2/3"].map((width, i) => (
                          <div key={i} className="flex h-lh items-center">
                            <Skeleton className={cn("h-3 rounded", width)} />
                          </div>
                        ))}
                      </div>
                      <div className="mt-4 flex gap-2">
                        <Skeleton className="h-[1.625rem] w-16 rounded-full" />
                        <Skeleton className="h-[1.625rem] w-20 rounded-full" />
                        <Skeleton className="h-[1.625rem] w-14 rounded-full" />
                      </div>
                    </div>
                  ) : null}

                  <GenreChips genres={genres} />
                </div>

                {metaListPresent ? (
                  <div className="w-full md:w-[260px] md:shrink-0">
                    <HeroMetaList
                      originalLanguage={extras?.originalLanguage ?? null}
                      releaseDate={releaseDate}
                      certification={extras?.certification ?? null}
                    />
                  </div>
                ) : heroExtrasPending ? (
                  <div aria-hidden className="grid w-full gap-y-2 text-[13px] md:w-[260px] md:shrink-0">
                    {["w-40", "w-48", "w-32"].map((width) => (
                      <div key={width} className="flex h-lh items-center">
                        <Skeleton className={cn("h-3 rounded", width)} />
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
  );
}
