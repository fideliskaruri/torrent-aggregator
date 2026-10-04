import type { EpisodeCardProps } from "./episode-card";

export function areEpisodeCardsEqual(a: EpisodeCardProps, b: EpisodeCardProps): boolean {

  if (a.gated !== b.gated) return false;
  if (a.downloadStatus !== b.downloadStatus) return false;
  if (a.onAction !== b.onAction) return false;
  if (a.onFindAnother !== b.onFindAnother) return false;
  if (a.onPickRelease !== b.onPickRelease) return false;
  if (a.onWantedAction !== b.onWantedAction) return false;

  const pe = a.episode;
  const ne = b.episode;
  if (
    pe.season !== ne.season ||
    pe.episode !== ne.episode ||
    pe.label !== ne.label ||
    pe.availability !== ne.availability ||
    pe.infoHash !== ne.infoHash ||
    pe.downloadFraction !== ne.downloadFraction ||
    pe.nextUp !== ne.nextUp ||
    pe.fromPack !== ne.fromPack ||
    (pe.owned?.resolution ?? -1) !== (ne.owned?.resolution ?? -1) ||
    Boolean(pe.owned) !== Boolean(ne.owned) ||
    (pe.state ?? null) !== (ne.state ?? null)
  ) {
    return false;
  }
  const pt = pe.transfer;
  const nt = ne.transfer;
  if (
    (pt?.status ?? null) !== (nt?.status ?? null) ||
    (pt?.state ?? null) !== (nt?.state ?? null) ||
    (pt?.queuePosition ?? null) !== (nt?.queuePosition ?? null) ||
    (pt?.progress ?? null) !== (nt?.progress ?? null) ||
    (pt?.infoHash ?? null) !== (nt?.infoHash ?? null) ||
    (pt?.filePath ?? null) !== (nt?.filePath ?? null) ||
    (pt?.error ?? null) !== (nt?.error ?? null)
  ) {
    return false;
  }
  const pm = pe.meta;
  const nm = ne.meta;
  return (
    (pm?.name ?? null) === (nm?.name ?? null) &&
    (pm?.overview ?? null) === (nm?.overview ?? null) &&
    (pm?.airDate ?? null) === (nm?.airDate ?? null) &&
    (pm?.runtimeMin ?? null) === (nm?.runtimeMin ?? null) &&
    (pm?.stillUrl ?? null) === (nm?.stillUrl ?? null)
  );
}
