using System.Security.Cryptography;
using System.Text;
using TorrentFlow.Domain;
using TorrentFlow.Store;

namespace TorrentFlow.Targets;

public sealed class CatalogState(TargetStore store)
{
    public async Task<MediaFileRow[]> OwnedAsync(string workId, CancellationToken ct) =>
        [.. (await store.ListAsync<MediaFileRow>(f => f.WorkId == workId, ct))
            .Where(f => f.Role == FileRole.Video && f.Status is FilePresence.Present or FilePresence.Offline)];

    public async Task<WatchItemRow?> SaveAsync(string actor, string workId, WatchStatus? status,
        bool? monitored, string? fromEpisodeId, bool changeStart, string? monitorMode,
        int? resolution, bool changeResolution, CancellationToken ct)
    {
        for (var retry = 0; retry < 6; retry++)
        {
            var prior = (await store.ListAsync<WatchItemRow>(row => row.WorkId == workId && row.UserId == actor, ct)).FirstOrDefault();
            var now = DateTimeOffset.UtcNow;
            var id = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(actor + ":" + workId)));
            var row = prior is null
                ? new WatchItemRow { Id = id, UserId = actor, WorkId = workId, Status = status ?? WatchStatus.Planned, UpgradeWatch = false, CreatedAt = now, UpdatedAt = now, Version = 0 }
                : prior with { Status = status ?? prior.Status,
                    UpdatedAt = now, Version = prior.Version + 1 };
            var writes = new List<RowWrite> { new(row, prior?.Version, null) };
            if (monitored is not null || changeStart || monitorMode is not null)
            {
                var follow = (await store.ListAsync<FollowRow>(row => row.WorkId == workId, ct)).FirstOrDefault();
                var (start, since) = FollowPolicy.Configure(follow, fromEpisodeId, changeStart, monitorMode, now);
                var next = follow is null
                    ? new FollowRow { Id = Guid.CreateVersion7().ToString(), WorkId = workId, Enabled = monitored ?? false, FromEpisodeId = start, NewEpisodesSince = since, LastMaterializedAt = null, CreatedAt = now, UpdatedAt = now, Version = 0 }
                    : follow with { Enabled = monitored ?? follow.Enabled,
                        FromEpisodeId = start,
                        NewEpisodesSince = since, UpdatedAt = now, Version = follow.Version + 1 };
                writes.Add(new(next, follow?.Version, null));
            }
            if (changeResolution)
            {
                var preference = (await store.ListAsync<WorkPreferenceRow>(row => row.WorkId == workId, ct)).FirstOrDefault();
                var next = preference is null
                    ? new WorkPreferenceRow { Id = Guid.CreateVersion7().ToString(), WorkId = workId, ResolutionFloor = resolution, PreferredResolution = resolution, AudioLanguage = null, MaxBytesPerItem = null, StorageRootOverrideId = null, UpdatedAt = now, Version = 0 }
                    : preference with { ResolutionFloor = resolution, PreferredResolution = resolution,
                        UpdatedAt = now, Version = preference.Version + 1 };
                writes.Add(new(next, preference?.Version, null));
            }
            if (await store.SaveAsync(writes, [], ct)) return row;
        }
        return null;
    }

    public async Task<bool> RemoveAsync(string actor, string id, CancellationToken ct)
    {
        for (var retry = 0; retry < 6; retry++)
        {
            var row = (await store.ListAsync<WatchItemRow>(item => item.Id == id && item.UserId == actor, ct)).FirstOrDefault();
            if (row is null) return true;
            var follow = (await store.ListAsync<FollowRow>(item => item.WorkId == row.WorkId, ct)).FirstOrDefault();
            RowWrite[] writes = follow is null ? [] : [new(follow with
                { Enabled = false, UpdatedAt = DateTimeOffset.UtcNow, Version = follow.Version + 1 }, follow.Version, null)];
            if (await store.SaveAsync(writes, [new(StoreTable.WatchItem, id, row.Version, null)], ct)) return true;
        }
        return false;
    }

}
