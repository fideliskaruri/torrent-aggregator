using System.Collections.Immutable;
using TorrentFlow.Domain;

namespace TorrentFlow.Targets;

internal static class TargetScheduling
{
    internal static TargetPriority Priority(TargetRow row, DateTimeOffset now) =>
        row.NowAt is not null ? TargetPriority.Now :
        row.OwnerRanked ? TargetPriority.OwnerRank :
        row.EpisodeId is not null && row.ExpectedAt is { } expected &&
            expected >= now.AddHours(-48) && expected <= now.AddHours(6) ? TargetPriority.FreshRelease :
        row.Origin == IntentOrigin.Request ? TargetPriority.Request :
        row.Kind != TargetKind.Acquire || row.Origin == IntentOrigin.Upgrade ? TargetPriority.UpgradeWatch :
        TargetPriority.BackCatalogue;

    internal static IOrderedEnumerable<TargetRow> Order(IEnumerable<TargetRow> rows, DateTimeOffset now) =>
        rows.OrderBy(t => Priority(t, now)).ThenBy(t => t.Rank)
            .ThenBy(t => t.ExpectedAt ?? t.ClickedAt ?? t.CreatedAt).ThenBy(t => t.Id, StringComparer.Ordinal);

    internal static ImmutableArray<EngineQueueOrder> Queue(IEnumerable<DownloadRow> downloads,
        ImmutableArray<DownloadTargetRow> links, ImmutableArray<TargetRow> targets, DateTimeOffset now) =>
        [.. downloads.Select(d =>
        {
            var members = targets.Where(t => links.Any(l => l.DownloadId == d.Id && l.TargetId == t.Id) &&
                t.State == TargetState.Fetching);
            var first = Order(members, now).FirstOrDefault();
            return new EngineQueueOrder(d.Id, first?.Rank ?? 0,
                first is null ? TargetPriority.BackCatalogue : Priority(first, now),
                first?.NowAt is not null, first is not null);
        })];
}
