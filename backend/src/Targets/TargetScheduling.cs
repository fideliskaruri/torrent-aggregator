using System.Collections.Immutable;
using TorrentFlow.Domain;

namespace TorrentFlow.Targets;

internal static class TargetScheduling
{
    internal static TargetPriority Priority(TargetRow row) =>
        row.Priority == TargetPriority.Now ? TargetPriority.Now : TargetPriority.BackCatalogue;

    internal static IOrderedEnumerable<TargetRow> Order(IEnumerable<TargetRow> rows) =>
        rows.OrderBy(t => Priority(t)).ThenBy(t =>
                Priority(t) == TargetPriority.Now ? t.NowAt ?? t.CreatedAt : t.CreatedAt)
            .ThenBy(t => t.CreatedAt).ThenBy(t => t.Id, StringComparer.Ordinal);

    internal static ImmutableArray<EngineQueueOrder> Queue(IEnumerable<DownloadRow> downloads,
        ImmutableArray<DownloadTargetRow> links, ImmutableArray<TargetRow> targets,
        ImmutableArray<RawIntentRow> raws = default)
    {
        var queue = downloads.Select(d =>
        {
            if (d.RawIntentId is { } rawId && !raws.IsDefault &&
                raws.SingleOrDefault(r => r.Id == rawId) is { } raw)
                return (DownloadId: d.Id, CreatedAt: raw.CreatedAt, NowAt: raw.NowAt,
                    Priority: raw.NowAt is not null ? TargetPriority.Now : TargetPriority.BackCatalogue,
                    Now: raw.NowAt is not null, Eligible: d.FinishedAt is null &&
                        raw.State is not (RawDownloadState.Paused or RawDownloadState.Done or RawDownloadState.Removed or RawDownloadState.Review));
            var members = targets.Where(t => links.Any(l => l.DownloadId == d.Id && l.TargetId == t.Id) &&
                t.State == TargetState.Fetching);
            var first = Order(members).FirstOrDefault();
            var isNow = first?.Priority == TargetPriority.Now;
            return (DownloadId: d.Id, CreatedAt: first?.CreatedAt ?? d.AddedAt, NowAt: isNow ? first?.NowAt : null,
                Priority: first is null ? TargetPriority.BackCatalogue : Priority(first),
                Now: isNow, Eligible: first is not null);
        }).OrderBy(item => item.Priority).ThenBy(item => item.NowAt ?? item.CreatedAt)
            .ThenBy(item => item.CreatedAt).ThenBy(item => item.DownloadId, StringComparer.Ordinal).ToArray();
        return [.. queue.Select((item, index) =>
            new EngineQueueOrder(item.DownloadId, index, item.Priority, item.Now, item.Eligible))];
    }
}
