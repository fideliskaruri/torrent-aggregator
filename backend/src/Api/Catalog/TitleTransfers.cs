using Microsoft.EntityFrameworkCore;
using TorrentFlow.Domain;
using TorrentFlow.Store;
using TorrentFlow.Targets;

namespace TorrentFlow.Api.Catalog;

internal sealed record TitleTransfer(string Status, string State, double Progress, string? InfoHash,
    string? FilePath, string? Error, int? QueuePosition = null, string? WaitReason = null);

internal sealed record TitleTransferProjection(TitleTransfer? Film,
    Dictionary<string, TitleTransfer> Seasons, Dictionary<string, TitleTransfer> Episodes);

internal static class TitleTransfers
{
    internal static async Task<TitleTransferProjection> ReadAsync(string workId, TargetPipeline pipeline,
        TorrentFlowDbContext db, CancellationToken ct)
    {
        var snapshot = await pipeline.ReadAsync(ct);
        var links = await db.DownloadTargets.AsNoTracking().ToListAsync(ct);
        var files = await db.DownloadFiles.AsNoTracking().ToListAsync(ct);
        var media = await db.MediaFiles.AsNoTracking().Where(file => file.WorkId == workId).ToListAsync(ct);
        var episodes = await db.Episodes.AsNoTracking().ToDictionaryAsync(episode => episode.Id, ct);
        var seasons = await db.Seasons.AsNoTracking().ToDictionaryAsync(season => season.Id, ct);
        var downloads = snapshot.Downloads.ToDictionary(download => download.Id);
        var targets = snapshot.Targets.Where(target => target.WorkId == workId &&
                target.State != TargetState.Removed)
            .GroupBy(target => target.EpisodeId)
            .Select(group => group.OrderByDescending(target => target.UpdatedAt)
                .ThenByDescending(target => target.CreatedAt).First())
            .ToArray();
        var positions = snapshot.Queue.Where(item => item.Eligible).OrderBy(item => item.Rank)
            .Select((item, index) => (item.DownloadId, Position: index + 1))
            .ToDictionary(item => item.DownloadId, item => item.Position);

        string? DownloadId(TargetRow target)
        {
            if (target.State is TargetState.Wanted or TargetState.Searching or TargetState.Waiting)
                return null;
            var linked = links.Where(link => link.TargetId == target.Id)
                .Select(link => (Link: link, Download: downloads.GetValueOrDefault(link.DownloadId)))
                .Where(item => item.Download is not null);
            return linked.OrderByDescending(item => item.Download!.Hash == target.ChosenReleaseHash)
                .ThenByDescending(item => item.Link.Role == AssociationRole.Current)
                .ThenByDescending(item => item.Link.Role == AssociationRole.Replacement)
                .ThenByDescending(item => item.Link.CreatedAt)
                .Select(item => item.Download!.Id).FirstOrDefault();
        }

        TitleTransfer CreateTransfer(IReadOnlyCollection<TargetRow> members, string? downloadId)
        {
            var member = members.OrderByDescending(target => target.UpdatedAt).First();
            var episode = member.EpisodeId is null ? null : episodes.GetValueOrDefault(member.EpisodeId);
            var present = media.Any(file => file.EpisodeId == member.EpisodeId && file.Status == FilePresence.Present);
            var download = downloadId is null ? null : downloads.GetValueOrDefault(downloadId);
            var live = download is null ? null : snapshot.Live.FirstOrDefault(item => item.DownloadId == download.Id);
            var selected = download is null ? [] : files.Where(file => file.DownloadId == download.Id &&
                file.Selected && file.Role != FileRole.Unwanted && members.Any(target => target.Id == file.TargetId))
                .ToArray();
            var failed = live?.Failure is not null ||
                member.State == TargetState.Waiting && member.ReasonCode == WaitReason.OwnerPickRequired ||
                member.State == TargetState.Done && !present;
            var ready = member.State == TargetState.Done && present;
            var state = ready ? "complete" : failed ? "error" : member.State switch
            {
                TargetState.Filing => "finishing",
                TargetState.Fetching when live?.Active == true && !live.Complete => "downloading",
                TargetState.Fetching when live?.Intent == DownloadIntent.Queued ||
                    download is not null && positions.ContainsKey(download.Id) => "queued",
                TargetState.Fetching => "error",
                _ => "waiting",
            };
            var error = ready ? null : live?.Failure?.Message ??
                (member.State == TargetState.Done && !present ? "The downloaded file is missing." :
                    failed ? member.ReasonText : null);
            int? queuePosition = download is not null && positions.TryGetValue(download.Id, out var position)
                ? position : null;
            var label = DownloadRowView.Status(state, download is null ? null :
                queuePosition, false, member.ReasonText, error);
            var titleStatus = label.Status switch
            {
                "ready" => "downloaded",
                "downloading" or "finishing" => "downloading",
                "error" => "failed",
                _ => "queued",
            };
            var titleState = label.Status switch
            {
                "ready" => "downloaded",
                "downloading" or "finishing" => "downloading",
                "error" => "failed",
                "queued" when state == "queued" => "queued",
                _ => WaitingState(member),
            };
            var mappedFiles = selected.Where(file => file.TargetId == member.Id).ToArray();
            var total = selected.Sum(file => Math.Max(0, file.ExpectedBytes));
            var completed = selected.Sum(file => file.Filed ? file.ExpectedBytes :
                live?.Files.FirstOrDefault(item => item.Index == file.FileIndex)?.CompletedBytes ?? 0);
            var progress = ready || member.State == TargetState.Filing ? 1d :
                member.State is TargetState.Wanted or TargetState.Searching or TargetState.Waiting ? 0d :
                total > 0 ? Math.Clamp((double)completed / total, 0, 1) : 0d;
            return new(titleStatus, titleState, progress, download?.Hash,
                members.Count == 1 ? mappedFiles.FirstOrDefault()?.FinalPath : null, error,
                label.Status == "queued" ? queuePosition : null);
        }

        var episodeTransfers = new Dictionary<string, TitleTransfer>();
        var filmTargets = targets.Where(target => target.EpisodeId is null).ToArray();
        var film = filmTargets.Length == 0 ? null : CreateTransfer(filmTargets, DownloadId(filmTargets[0]));
        foreach (var target in targets.Where(target => target.EpisodeId is not null))
        {
            if (!episodes.TryGetValue(target.EpisodeId!, out var episode) ||
                !seasons.TryGetValue(episode.SeasonId, out var season)) continue;
            var seasonKey = season.Number.ToString("00", System.Globalization.CultureInfo.InvariantCulture);
            var episodeKey = episode.Number.ToString("00", System.Globalization.CultureInfo.InvariantCulture);
            var key = $"S{seasonKey}E{episodeKey}";
            episodeTransfers[key] = CreateTransfer([target], DownloadId(target));
        }

        var seasonTransfers = new Dictionary<string, TitleTransfer>();
        foreach (var group in targets.Where(target => target.EpisodeId is not null)
                     .Select(target => (Target: target, DownloadId: DownloadId(target)))
                     .Where(item => item.DownloadId is not null)
                     .GroupBy(item => item.DownloadId!))
        {
            var members = group.Select(item => item.Target).Where(target => target.EpisodeId is not null &&
                episodes.TryGetValue(target.EpisodeId, out var episode) &&
                seasons.TryGetValue(episode.SeasonId, out _)).ToArray();
            if (members.Length < 2) continue;
            var seasonNumbers = members.Select(target => seasons[episodes[target.EpisodeId!].SeasonId].Number)
                .Distinct().ToArray();
            if (seasonNumbers.Length != 1) continue;
            var key = seasonNumbers[0].ToString(System.Globalization.CultureInfo.InvariantCulture);
            seasonTransfers[key] = CreateTransfer(members, group.Key);
        }
        return new(film, seasonTransfers, episodeTransfers);
    }

    private static string WaitingState(TargetRow target)
    {
        var label = DownloadRowView.WantedStatusLabel(target.State, target.ReasonText);
        if (label.Contains("episode list", StringComparison.OrdinalIgnoreCase) ||
            label.Contains("season list", StringComparison.OrdinalIgnoreCase))
            return "waiting_season_list";
        if (label.Contains("English", StringComparison.OrdinalIgnoreCase) ||
            label.Contains("non-English", StringComparison.OrdinalIgnoreCase))
            return "waiting_english";
        return "looking";
    }
}
