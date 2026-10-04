using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Domain;

namespace TorrentFlow.Targets;

public sealed partial class TargetPipeline
{
    public async Task<TargetActionReply> RawActionAsync(string id, TargetAction action, CancellationToken ct)
    {
        if (action is not (TargetAction.Pause or TargetAction.Resume))
            throw new ArgumentException("Choose Pause or Resume for this download.");
        await stateGate.WaitAsync(ct);
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredService<IStore>();
            var catalog = new CatalogState(store);
            var raw = (await catalog.ReadAsync<RawIntentRow>(CatalogState.Query(id), ct)).SingleOrDefault()
                ?? throw new ArgumentException("This download no longer exists.");
            var download = raw.DownloadId is null ? null :
                (await catalog.ReadAsync<DownloadRow>(CatalogState.Query(raw.DownloadId), ct)).SingleOrDefault();
            if (raw.State is RawDownloadState.Done or RawDownloadState.Removed or RawDownloadState.Review ||
                download?.FinishedAt is not null)
                return new(false, 0, 0, [id], "This download is already finished.");
            var pause = action == TargetAction.Pause;
            if (pause == (raw.State == RawDownloadState.Paused))
                return new(true, 0, 0, [id], pause ? "Already paused" : "Already running");
            var now = DateTimeOffset.UtcNow;
            var resume = raw.ResumeState ?? (download is null ? RawDownloadState.Wanted : RawDownloadState.Fetching);
            if (resume is RawDownloadState.Checking or RawDownloadState.Planning) resume = RawDownloadState.Wanted;
            var next = raw with { State = pause ? RawDownloadState.Paused : resume,
                ResumeState = pause ? raw.State : null, LeaseToken = null, LeaseUntil = null,
                UpdatedAt = now, Version = raw.Version + 1 };
            await CommitAsync(store, [new(next, raw.Version, null),
                .. download is null ? Array.Empty<RowWrite>() : new[] { new RowWrite(download with
                    { Intent = pause ? DownloadIntent.Paused : DownloadIntent.Run,
                        Version = download.Version + 1 }, download.Version, null) }], [], ct);
            if (download is not null)
            {
                await engine.ApplyQueueAsync(new([]) { Order = TargetScheduling.Queue(
                    await catalog.ReadAsync<DownloadRow>(CatalogState.Query(), ct),
                    await catalog.ReadAsync<DownloadTargetRow>(CatalogState.Query(), ct),
                    await catalog.ReadAsync<TargetRow>(CatalogState.Query(), ct),
                    await catalog.ReadAsync<RawIntentRow>(CatalogState.Query(), ct)) }, ct);
                await engine.SetIntentAsync(download.Id, !pause, ct);
            }
            return new(true, 0, 0, [id], pause ? "Paused" : "Resumed");
        }
        finally { stateGate.Release(); }
    }

    public async Task<TargetActionReply> BulkActionAsync(TargetAction action, CancellationToken ct)
    {
        if (action is not (TargetAction.Pause or TargetAction.Resume))
            throw new ArgumentException("Choose Pause all or Resume all.");
        var snapshot = await ReadAsync(ct);
        var ids = System.Collections.Immutable.ImmutableArray.CreateBuilder<string>();
        foreach (var target in snapshot.Targets.Where(t => action == TargetAction.Pause
            ? t.State is not (TargetState.Paused or TargetState.Done or TargetState.Removed)
            : t.State == TargetState.Paused))
        {
            if ((await ActionAsync(target.Id, action, ct)).Accepted) ids.Add(target.Id);
        }
        foreach (var raw in snapshot.RawIntents.Where(r => action == TargetAction.Pause
            ? r.State is not (RawDownloadState.Paused or RawDownloadState.Done or RawDownloadState.Removed or RawDownloadState.Review)
            : r.State == RawDownloadState.Paused))
        {
            if ((await RawActionAsync(raw.Id, action, ct)).Accepted) ids.Add(raw.Id);
        }
        return new(true, 0, 0, ids.ToImmutable(), $"{ids.Count} {(action == TargetAction.Pause ? "paused" : "resumed")}");
    }
}
