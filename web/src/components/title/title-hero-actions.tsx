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
import type { TitleContentModel } from "./use-title-content-model";

const DOWNLOAD_KEY = "download";

export function TitleHeroActions({ model }: { model: TitleContentModel }) {
  const { payload, title, caps, ownedFilm, gated, discoverEpisodes, discoveryPending, refetchExtras, canOpenFile, openingFile, openTitleFile, showDownload, downloadControl, titleTransfer, downloadLabel, downloadStatus, downloadCanRun, alwaysPreferred, setHeroPicker, onAction, downloadAction, downloadLabelTarget, preferredResolution, titleLooking, titleWanted, titleWantedRow, workKey, metaYear, canFindSource, findSourceHash, onFindAnother, seasons, onLibraryChanged } = model;
  return (
              <div
                className="mt-4 grid w-full min-w-0 grid-cols-1 gap-2 empty:hidden md:mt-5 md:flex md:flex-wrap md:items-center"
                data-title-acquire
              >

                {ownedFilm && payload.owned ? (
                  <OwnedQuality
                    variant="title"
                    owned={payload.owned}
                  />
                ) : !caps.canDownload ? (
                  gated ? null : (
                    <RequestAction
                      title={requestTitleFor(payload)}
                      state={parseRequestState(payload)}
                      onRequested={onLibraryChanged}
                    />
                  )
                ) : discoverEpisodes && !gated ? (
                  <Button
                    type="button"
                    size="lg"
                    data-title-primary
                    data-action-kind="discover"
                    aria-label={`Find episodes, ${title}`}
                    aria-busy={discoveryPending || undefined}
                    disabled={discoveryPending}
                    onClick={() => void refetchExtras()}
                    className="relative w-full min-w-0 md:w-auto md:min-w-[9rem]"
                  >
                    <ButtonBody pending={discoveryPending} icon={<Search aria-hidden />}>
                      Find episodes
                    </ButtonBody>
                  </Button>
                ) : null}
                {canOpenFile ? (
                  <>
                    <TfOpenFileButton
                      name={title}
                      busy={openingFile === "open"}
                      disabled={openingFile !== null}
                      variant="default"
                      size="lg"
                      data-title-open
                      onClick={() => void openTitleFile("open")}
                      className="w-full min-w-0 md:w-auto md:min-w-[8rem]"
                    />
                    <Button
                      type="button"
                      size="lg"
                      variant="secondary"
                      data-title-reveal
                      aria-label={`Show ${title} in its folder`}
                      aria-busy={openingFile === "reveal" || undefined}
                      disabled={openingFile !== null}
                      onClick={() => void openTitleFile("reveal")}
                      className="relative w-full min-w-0 md:w-auto"
                    >
                      <ButtonBody pending={openingFile === "reveal"} icon={<FolderOpen aria-hidden />}>
                        Show in folder
                      </ButtonBody>
                    </Button>
                  </>
                ) : showDownload && caps.canDownload && !ownedFilm && downloadControl.opensDownloads ? (
                  <Button
                    asChild
                    size="lg"
                    className="relative w-full min-w-0 md:w-auto md:min-w-[8rem]"
                  >
                    <Link
                      to="/downloads"
                      data-title-download
                      data-transfer-status={titleTransfer?.status}
                      aria-label={`${downloadLabel}, view ${title} in Downloads`}
                    >
                      {titleTransfer?.status === "downloaded" ? (
                        <CheckCircle2 aria-hidden />
                      ) : (
                        <Download aria-hidden />
                      )}
                      {downloadLabel}
                    </Link>
                  </Button>
                ) : showDownload && caps.canDownload && !ownedFilm ? (
                  <Button
                    type="button"
                    size="lg"
                    data-title-download
                    data-action-kind="get"
                    data-transfer-status={titleTransfer?.status}
                    aria-label={`${downloadLabel}, ${title}`}
                    title={downloadControl.error ?? undefined}
                    aria-busy={downloadStatus === "pending" || undefined}
                    disabled={!downloadCanRun}
                    onClick={() => {
                      if (shouldAskForQuality(alwaysPreferred)) {
                        setHeroPicker(true);
                      } else {
                        onAction(
                          downloadAction,
                          DOWNLOAD_KEY,
                          downloadLabelTarget,
                          preferredResolution,
                        );
                      }
                    }}
                    className="relative w-full min-w-0 md:w-auto md:min-w-[8rem]"
                  >
                    <ButtonBody
                      pending={downloadStatus === "pending"}
                      icon={titleTransfer?.state === "looking" ? <Search aria-hidden /> : <Download aria-hidden />}
                    >
                      {downloadLabel}
                    </ButtonBody>
                  </Button>
                ) : null}

                {titleLooking ? (
                  <WantedActions
                    target={{ workKey: payload.workKey, season: null, episode: null }}
                    name={metaYear ? `${title} (${metaYear})` : title}
                    pickTitle={title}
                    looking={titleWantedRow?.looking ?? true}
                    onChanged={async () => {
                      await titleWanted.reload();
                      onLibraryChanged();
                    }}
                    size="lg"
                    className="w-full md:w-auto"
                  />
                ) : null}

                {canFindSource && findSourceHash ? (
                  <Button
                    type="button"
                    size="lg"
                    variant="outline"
                    data-title-find-source
                    aria-label={`${FIND_ANOTHER_SOURCE_LABEL} for ${title}`}
                    onClick={() => onFindAnother({ hash: findSourceHash, label: title })}
                    className="relative w-full min-w-0 md:w-auto"
                  >
                    <Search aria-hidden />
                    {FIND_ANOTHER_SOURCE_LABEL}
                  </Button>
                ) : null}

                {caps.canManage ? (
                  <LibraryControls
                    library={payload.library}
                    isSeries={payload.isSeries}
                    seasons={seasons.map((s) => s.season)}
                    releaseDate={payload.releaseDate}
                    title={title}
                    onChanged={onLibraryChanged}
                    ownedShown={Boolean(ownedFilm) || seasons.some((s) => (s.downloadedEpisodes ?? 0) > 0)}
                  />
                ) : null}
              </div>
  );
}
