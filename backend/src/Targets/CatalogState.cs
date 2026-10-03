using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text;
using TorrentFlow.Domain;

namespace TorrentFlow.Targets;

/// <summary>Catalog intent and inventory reads. The Library phase replaces the empty inventory, not catalog metadata.</summary>
public sealed class CatalogState(IStore store)
{
    public static StoreQuery Query(string? id = null, string? workId = null, string? userId = null) =>
        new(id, workId, null, null, userId, null, null, null, null, null, null, null, null, null, 500, StoreOrder.PrimaryKey);

    public async Task<ImmutableArray<T>> ReadAsync<T>(StoreQuery query, CancellationToken ct) where T : StoreRow
    {
        var result = ImmutableArray.CreateBuilder<T>();
        while (true)
        {
            var page = await store.ReadAsync<T>(query, ct);
            result.AddRange(page);
            if (page.Length < query.Limit) return result.ToImmutable();
            query = query with { Cursor = Convert.ToBase64String(Encoding.UTF8.GetBytes(page[^1].Id)) };
        }
    }

    public async Task<ImmutableArray<MediaFileRow>> OwnedAsync(string workId, CancellationToken ct) =>
        [.. (await ReadAsync<MediaFileRow>(Query(workId: workId), ct))
            .Where(f => f.Role == FileRole.Video && f.Status is FilePresence.Present or FilePresence.Offline)];

    public async Task<WatchItemRow?> SaveAsync(string actor, string workId, WatchStatus? status,
        bool? monitored, string? fromEpisodeId, bool changeStart, string? monitorMode,
        int? resolution, bool changeResolution, CancellationToken ct)
    {
        for (var retry = 0; retry < 6; retry++)
        {
            var prior = (await ReadAsync<WatchItemRow>(Query(workId: workId, userId: actor), ct)).FirstOrDefault();
            var now = DateTimeOffset.UtcNow;
            var id = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(actor + ":" + workId)));
            var row = prior is null
                ? new WatchItemRow(id, actor, workId, status ?? WatchStatus.Planned, false, now, now, 0)
                : prior with { Status = status ?? prior.Status,
                    UpdatedAt = now, Version = prior.Version + 1 };
            var writes = new List<RowWrite> { new(row, prior?.Version, null) };
            if (monitored is not null || changeStart || monitorMode is not null)
            {
                var follow = (await ReadAsync<FollowRow>(Query(workId: workId), ct)).FirstOrDefault();
                var (start, since) = FollowPolicy.Configure(follow, fromEpisodeId, changeStart, monitorMode, now);
                var next = follow is null
                    ? new FollowRow(Guid.CreateVersion7().ToString(), workId, monitored ?? false, start,
                        since, null, now, now, 0)
                    : follow with { Enabled = monitored ?? follow.Enabled,
                        FromEpisodeId = start,
                        NewEpisodesSince = since, UpdatedAt = now, Version = follow.Version + 1 };
                writes.Add(new(next, follow?.Version, null));
            }
            if (changeResolution)
            {
                var preference = (await ReadAsync<WorkPreferenceRow>(Query(workId: workId), ct)).FirstOrDefault();
                var next = preference is null
                    ? new WorkPreferenceRow(Guid.CreateVersion7().ToString(), workId, resolution, resolution, null, null, null, now, 0)
                    : preference with { ResolutionFloor = resolution, PreferredResolution = resolution,
                        UpdatedAt = now, Version = preference.Version + 1 };
                writes.Add(new(next, preference?.Version, null));
            }
            var result = await CommitAsync(actor, [.. writes], [], ct);
            if (result.Applied) return row;
            if (!result.Conflict) break;
        }
        return null;
    }

    public async Task<bool> RemoveAsync(string actor, string id, CancellationToken ct)
    {
        for (var retry = 0; retry < 6; retry++)
        {
            var row = (await ReadAsync<WatchItemRow>(Query(id: id, userId: actor), ct)).FirstOrDefault();
            if (row is null) return true;
            var follow = (await ReadAsync<FollowRow>(Query(workId: row.WorkId), ct)).FirstOrDefault();
            ImmutableArray<RowWrite> writes = follow is null ? [] : [new(follow with
                { Enabled = false, UpdatedAt = DateTimeOffset.UtcNow, Version = follow.Version + 1 }, follow.Version, null)];
            if ((await CommitAsync(actor, writes, [new(StoreTable.WatchItem, id, row.Version, null)], ct)).Applied) return true;
        }
        return false;
    }

    private Task<CommitResult> CommitAsync(string actor, ImmutableArray<RowWrite> writes,
        ImmutableArray<RowDelete> deletes, CancellationToken ct)
    {
        var key = Guid.CreateVersion7().ToString();
        var now = DateTimeOffset.UtcNow;
        var receipt = new AttemptRow("commit:" + actor + ":" + key, null, null, null, actor,
            AttemptKind.LegacyEvent, now, now, "watchlist", null, null, null, null, null, null, null, null);
        return store.CommitAsync(new(key, StoreOwner.Targets, [.. writes, new(receipt, null, null)], deletes), ct);
    }
}
