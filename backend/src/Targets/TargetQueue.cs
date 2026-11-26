using System.Collections.Immutable;
using TorrentFlow.Domain;
using TorrentFlow.Store;

namespace TorrentFlow.Targets;

internal static class TargetQueue
{
    internal static IOrderedEnumerable<TargetRow> Order(IEnumerable<TargetRow> rows) =>
        rows.OrderBy(t => t.CreatedAt)
            .ThenBy(t => t.Id, StringComparer.Ordinal);

    internal static ImmutableArray<EngineQueueOrder> Build(IEnumerable<DownloadRow> downloads,
        ImmutableArray<DownloadTargetRow> links, ImmutableArray<TargetRow> targets,
        ImmutableArray<RawIntentRow> raws = default)
    {
        var targetsById = targets.ToDictionary(t => t.Id, StringComparer.Ordinal);
        var linksByDownload = links.ToLookup(l => l.DownloadId, StringComparer.Ordinal);
        var rawById = raws.IsDefault ? new Dictionary<string, RawIntentRow>() : raws.ToDictionary(r => r.Id);
        var queue = downloads.Select(download =>
        {
            if (download.RawIntentId is { } rawId && rawById.TryGetValue(rawId, out var raw))
                return (DownloadId: download.Id, CreatedAt: raw.CreatedAt,
                    Now: raw.NowAt is not null, Eligible: download.FinishedAt is null &&
                        raw.State is not (RawDownloadState.Paused or RawDownloadState.Publishing or
                            RawDownloadState.Done or RawDownloadState.Removed));

            var members = linksByDownload[download.Id].Select(link => targetsById.GetValueOrDefault(link.TargetId))
                .OfType<TargetRow>().DistinctBy(target => target.Id).Where(target => target.State == TargetState.Fetching);
            var first = Order(members).FirstOrDefault();
            return (DownloadId: download.Id, CreatedAt: first?.CreatedAt ?? download.AddedAt,
                Now: first?.DownloadNow ?? false, Eligible: first is not null);
        }).OrderBy(row => row.CreatedAt)
            .ThenBy(row => row.DownloadId, StringComparer.Ordinal)
            .ToArray();

        return [.. queue.Select((row, index) =>
            new EngineQueueOrder(row.DownloadId, index, TargetPriority.BackCatalogue, row.Now, row.Eligible))];
    }

    internal static async Task ApplyAsync(IEngine engine, TargetStore store, CancellationToken ct)
    {
        var downloads = await store.ListAsync<DownloadRow>(null, ct);
        var links = await store.ListAsync<DownloadTargetRow>(null, ct);
        var targets = await store.ListAsync<TargetRow>(null, ct);
        var raws = await store.ListAsync<RawIntentRow>(null, ct);
        await engine.ApplyQueueAsync(new([]) { Order = Build(downloads, [.. links], [.. targets], [.. raws]) }, ct);
    }
}
