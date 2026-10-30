import { CheckCircle2, Download, FolderOpen, Play, Search } from "lucide-react";
import { Link } from "react-router";
import { TfOpenFileButton } from "@/components/tf/open-file-button";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ButtonBody } from "./button-body";
import { requestTitleFor } from "./title-payload";
import { LibraryControls } from "./library-controls";
import { OwnedQuality } from "./owned-quality";
import { RequestAction } from "@/components/requests/request-action";
import { WantedActions } from "@/components/wanted/wanted-actions";
import { parseRequestState } from "@/lib/requests";
import { FIND_ANOTHER_SOURCE_LABEL } from "@/components/releases/find-another-source";
import { DOWNLOAD_KEY } from "./title-actions";
import type { TitleContentViewModel } from "./use-title-content-view-model";

export function TitleHeroActions({ model }: { model: TitleContentViewModel }) {
  const {
    payload,
    title,
    caps,
    ownedFilm,
    gated,
    filmAvailabilitySettled,
    heroExtrasPending,
    discoverEpisodes,
    discoveryPending,
    refetchExtras,
    canOpenFile,
    openingFile,
    openTitleFile,
    showDownload,
    downloadControl,
    titleTransfer,
    downloadLabel,
    downloadStatus,
    downloadCanRun,
    onAction,
    downloadAction,
    titleLooking,
    titleWanted,
    titleWantedRow,
    metaYear,
    canFindSource,
    findSourceHash,
    onFindAnother,
    seasons,
    onLibraryChanged,
    titlePending,
  } = model;
  const playUrl = payload.jellyfin?.playUrl ?? null;
  // Once Jellyfin has the title, playing it comes first and getting it again is the quieter choice.
  const getLabel = playUrl && !payload.isSeries ? "Download anyway" : downloadLabel;
  return (
              <div
                className={cn(
                  "mt-4 grid w-full min-w-0 grid-cols-1 gap-2 md:mt-5 md:flex md:flex-wrap md:items-center",
                  titlePending || heroExtrasPending ? "min-h-10 max-md:min-h-11" : "empty:hidden",
                )}
                data-title-acquire
              >
                {playUrl ? (
                  <Button asChild size="lg" className="relative w-full min-w-0 md:w-auto md:min-w-[9rem]">
                    <a href={playUrl} target="_blank" rel="noopener noreferrer" data-title-play-jellyfin
                      aria-label={`Play ${title} in Jellyfin (opens in a new tab)`}>
                      <Play aria-hidden />
                      Play in Jellyfin
                    </a>
                  </Button>
                ) : null}

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
                      variant={playUrl ? "secondary" : "default"}
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
                    variant={playUrl ? "secondary" : "default"}
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
                    variant={playUrl ? "secondary" : "default"}
                    data-title-download
                    data-action-kind="get"
                    data-transfer-status={titleTransfer?.status}
                    aria-label={`${getLabel}, ${title}`}
                    title={downloadControl.error ?? undefined}
                    aria-busy={downloadStatus === "pending" || undefined}
                    disabled={!downloadCanRun}
                    onClick={() => {
                      onAction(downloadAction, DOWNLOAD_KEY, title);
                    }}
                    className="relative w-full min-w-0 md:w-auto md:min-w-[8rem]"
                  >
                    <ButtonBody
                      pending={downloadStatus === "pending"}
                      icon={titleTransfer?.state === "looking" ? <Search aria-hidden /> : <Download aria-hidden />}
                    >
                      {getLabel}
                    </ButtonBody>
                  </Button>
                ) : null}
                {!payload.isSeries && heroExtrasPending && caps.canDownload && !ownedFilm ? (
                  <div
                    aria-hidden="true"
                    className="h-10 w-full animate-pulse rounded-md bg-muted max-md:min-h-11 pointer-coarse:min-h-11 md:w-32"
                    data-title-acquire-placeholder
                  />
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
                    gated={gated}
                    settled={filmAvailabilitySettled}
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
