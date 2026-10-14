using System.Globalization;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Domain;
using TorrentFlow.Store;
using TorrentFlow.Targets;

namespace TorrentFlow.Api.Catalog;

internal sealed record TitleTransfer(string Status, string State, double Progress, string? InfoHash,
    string? FilePath, string? Error, int? QueuePosition = null, string? WaitReason = null);

internal sealed record TitleTransferProjection(TitleTransfer? Film,
    Dictionary<string, TitleTransfer> Seasons, Dictionary<string, TitleTransfer> Episodes);

/// The title page's view of its targets, built on the same state rule as the downloads list.
internal static class TitleTransfers
{
    internal static async Task<TitleTransferProjection> ReadAsync(string workId, TargetPipeline pipeline,
        TorrentFlowDbContext db, CancellationToken ct)
    {
        var snapshot = await pipeline.ReadAsync(ct);
        var targets = snapshot.Targets.Where(target => target.WorkId == workId && target.State != TargetState.Removed)
            .GroupBy(target => target.EpisodeId)
            .Select(group => group.OrderByDescending(target => target.UpdatedAt).First())
            .ToArray();
        var targetIds = targets.Select(target => target.Id).ToArray();
        var links = await db.DownloadTargets.AsNoTracking().Where(link => targetIds.Contains(link.TargetId))
            .ToListAsync(ct);
        var downloadIds = links.Select(link => link.DownloadId).Distinct().ToArray();
        var files = await db.DownloadFiles.AsNoTracking().Where(file => downloadIds.Contains(file.DownloadId))
            .ToListAsync(ct);
        var present = (await db.MediaFiles.AsNoTracking()
                .Where(file => file.WorkId == workId && file.Status == FilePresence.Present)
                .Select(file => file.EpisodeId).ToListAsync(ct)).ToHashSet();
        var seasons = await db.Seasons.AsNoTracking().Where(season => season.WorkId == workId)
            .ToDictionaryAsync(season => season.Id, season => season.Number, ct);
        var seasonIds = seasons.Keys.ToArray();
        var episodes = await db.Episodes.AsNoTracking().Where(episode => seasonIds.Contains(episode.SeasonId))
            .ToDictionaryAsync(episode => episode.Id, episode => (Season: seasons[episode.SeasonId], episode.Number), ct);
        var downloads = snapshot.Downloads.ToDictionary(download => download.Id);
        var positions = snapshot.Queue.Where(item => item.Eligible).OrderBy(item => item.Rank)
            .Select((item, index) => (item.DownloadId, Position: index + 1))
            .ToDictionary(item => item.DownloadId, item => item.Position);

        DownloadRow? DownloadFor(TargetRow target) =>
            target.State is TargetState.Wanted or TargetState.Searching or TargetState.Waiting ? null :
            links.Where(link => link.TargetId == target.Id && downloads.ContainsKey(link.DownloadId))
                .OrderByDescending(link => downloads[link.DownloadId].Hash == target.ChosenReleaseHash)
                .ThenByDescending(link => link.Role == AssociationRole.Current)
                .ThenByDescending(link => link.CreatedAt)
                .Select(link => downloads[link.DownloadId]).FirstOrDefault();

        TitleTransfer Transfer(IReadOnlyCollection<TargetRow> members, DownloadRow? download)
        {
            var member = members.OrderByDescending(target => target.UpdatedAt).First();
            var owned = present.Contains(member.EpisodeId);
            if (member.State == TargetState.Done)
                return owned ? new("downloaded", "downloaded", 1, download?.Hash, FinalPath(members, download), null)
                    : new("failed", "failed", 0, download?.Hash, null, "The downloaded file is missing.");
            if (download is null)
                return member.ReasonCode == WaitReason.OwnerPickRequired
                    ? new("failed", "failed", 0, null, null, member.ReasonText)
                    : WaitingState(member) == "waiting_sources"
                        ? new("queued", "waiting_sources", 0, null, null, null, null, member.ReasonText)
                        : new("queued", WaitingState(member), 0, null, null, null);

            var live = snapshot.Live.FirstOrDefault(item => item.DownloadId == download.Id);
            var state = DownloadRowView.State(false, member.IsPaused(), member.State == TargetState.Filing, live);
            if (state == "error")
                return new("failed", "failed", 0, download.Hash, null, live?.Failure?.Message ?? member.ReasonText);
            var selected = files.Where(file => file.DownloadId == download.Id && file.Selected &&
                file.Role != FileRole.Unwanted && members.Any(target => target.Id == file.TargetId)).ToArray();
            var held = DownloadRowView.HeldStatus(state, live,
                selected.Select(file => (file.FileIndex, file.Filed)));
            if (state is "queued" or "paused" || held is not null)
            {
                int? position = held is null && positions.TryGetValue(download.Id, out var value) ? value : null;
                return new("queued", "queued", 0, download.Hash, null, null, position, held?.StatusLabel);
            }
            var total = selected.Sum(file => Math.Max(0, file.ExpectedBytes));
            var completed = selected.Sum(file => file.Filed ? file.ExpectedBytes :
                live?.Files.FirstOrDefault(item => item.Index == file.FileIndex)?.CompletedBytes ?? 0);
            var progress = state == "finishing" ? 1d : total > 0 ? Math.Clamp((double)completed / total, 0, 1) : 0d;
            return new("downloading", "downloading", progress, download.Hash, null, null);
        }

        string? FinalPath(IReadOnlyCollection<TargetRow> members, DownloadRow? download) =>
            members.Count != 1 || download is null ? null :
            files.FirstOrDefault(file => file.DownloadId == download.Id && file.TargetId == members.First().Id)?.FinalPath;

        var film = targets.FirstOrDefault(target => target.EpisodeId is null);
        var episodeTargets = targets
            .Where(target => target.EpisodeId is not null && episodes.ContainsKey(target.EpisodeId))
            .Select(target => (Target: target, Episode: episodes[target.EpisodeId!], Download: DownloadFor(target)))
            .ToArray();
        var episodeTransfers = episodeTargets.ToDictionary(
            item => $"S{item.Episode.Season.ToString("00", CultureInfo.InvariantCulture)}E{item.Episode.Number.ToString("00", CultureInfo.InvariantCulture)}",
            item => Transfer([item.Target], item.Download));
        var seasonTransfers = new Dictionary<string, TitleTransfer>();
        foreach (var pack in episodeTargets.Where(item => item.Download is not null).GroupBy(item => item.Download!.Id))
        {
            var seasonNumbers = pack.Select(item => item.Episode.Season).Distinct().ToArray();
            if (pack.Count() < 2 || seasonNumbers.Length != 1) continue;
            seasonTransfers[seasonNumbers[0].ToString(CultureInfo.InvariantCulture)] =
                Transfer([.. pack.Select(item => item.Target)], pack.First().Download);
        }
        return new(film is null ? null : Transfer([film], DownloadFor(film)), seasonTransfers, episodeTransfers);
    }

    private static string WaitingState(TargetRow target) => target.ReasonCode switch
    {
        WaitReason.MetadataUnavailable => "waiting_season_list",
        WaitReason.MappingUncertain => "waiting_english",
        _ when target.State == TargetState.Waiting && target.ReasonCode is WaitReason.WaitingForSeeders or
            WaitReason.NoResults or WaitReason.RejectedCandidates or WaitReason.SourceFailure => "waiting_sources",
        _ => "looking",
    };
}