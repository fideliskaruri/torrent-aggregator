using TorrentFlow.Domain;
using TorrentFlow.Engine;
using TorrentFlow.Store;
using Microsoft.Extensions.DependencyInjection;

namespace TorrentFlow.Targets;

public sealed partial class RawDownloads
{
    public async Task<object> DownloadNowAsync(string hash, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredService<TargetStore>();
            var old = (await store.ListAsync<RawIntentRow>(row => row.Id == Prefix + hash, ct)).Single();
            var next = old with { NowAt = DateTimeOffset.UtcNow, State = RawDownloadState.Fetching,
                UpdatedAt = DateTimeOffset.UtcNow, Version = old.Version + 1 };
            await CommitAsync(store, [new(next, old.Version, null)], [], ct);
            await TargetQueue.ApplyAsync(engine, store, ct);
            if (next.DownloadId is not null)
            {
                var download = (await store.ListAsync<DownloadRow>(row => row.Id == next.DownloadId, ct)).Single();
                await CommitAsync(store, [new(download with { Intent = DownloadIntent.Run,
                    Version = download.Version + 1 }, download.Version, null)], [], ct);
                await engine.SetIntentAsync(next.DownloadId, true, ct);
            }
            await engine.SaveDevStateAsync(ct);
            return new { live = await engine.SnapshotAsync(ct) };
        }
        finally { gate.Release(); }
    }

    public async Task<TargetActionReply> PauseAsync(string id, bool pause, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredService<TargetStore>();
            var raw = (await store.ListAsync<RawIntentRow>(row => row.Id == id, ct)).SingleOrDefault()
                ?? throw new ArgumentException("This download no longer exists.");
            var download = raw.DownloadId is null ? null :
                (await store.ListAsync<DownloadRow>(row => row.Id == raw.DownloadId, ct)).SingleOrDefault();
            if (raw.State is RawDownloadState.Done or RawDownloadState.Removed ||
                download?.FinishedAt is not null)
                return new(false, 0, 0, [id], "This download is already finished.");
            if (pause == (raw.State == RawDownloadState.Paused))
                return new(true, 0, 0, [id], pause ? "Already paused" : "Already running");
            var now = DateTimeOffset.UtcNow;
            var next = raw with { State = pause ? RawDownloadState.Paused : RawDownloadState.Fetching,
                UpdatedAt = now, Version = raw.Version + 1 };
            await CommitAsync(store, [new(next, raw.Version, null),
                .. download is null ? Array.Empty<RowWrite>() : new[] { new RowWrite(download with
                    { Intent = pause ? DownloadIntent.Paused : DownloadIntent.Run,
                        Version = download.Version + 1 }, download.Version, null) }], [], ct);
            if (download is not null)
            {
                await TargetQueue.ApplyAsync(engine, store, ct);
                await engine.SetIntentAsync(download.Id, !pause, ct);
            }
            return new(true, 0, 0, [id], pause ? "Paused" : "Resumed");
        }
        finally { gate.Release(); }
    }
}
