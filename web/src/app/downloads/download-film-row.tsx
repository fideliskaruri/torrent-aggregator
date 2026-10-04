import { DownloadTransferRow,type DownloadTransferRowProps } from "./download-transfer-row";
import { releaseDisplayFacts,titleWithYear } from "./release-display";
import { downloadTitleHref } from "./download-links";
import type { useDownloads } from "./use-downloads";

type WantedState = ReturnType<typeof useDownloads>["wanted"];

export function DownloadFilmRow({
  torrent,
  ...rest
}: Omit<DownloadTransferRowProps, "kind" | "title" | "titleHref" | "posterUrl" | "showThumb"> & {
  wantedGroups: NonNullable<DownloadTransferRowProps["wantedGroups"]>;
  wantedState: WantedState;
}) {
  const display = releaseDisplayFacts(torrent);
  return (
    <DownloadTransferRow
      torrent={torrent}
      kind="torrent"
      title={titleWithYear(display.title, display.year)}
      titleHref={downloadTitleHref(torrent)}
      posterUrl={torrent.posterUrl}
      showThumb
      {...rest}
    />
  );
}
