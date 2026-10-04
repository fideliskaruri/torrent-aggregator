using System.Collections.Immutable;
using TorrentFlow.Domain;
using TorrentFlow.Store;
using TorrentFlow.Targets;

namespace TorrentFlow.Requests;

// Request linkage is request-owned; target state and origin are authored by Targets.
public static class RequestTargetAdapter
{
    public static async Task Attach(TargetStore store, RequestRow request,
        ImmutableArray<string> ids, CancellationToken ct)
    {
        foreach (var id in ids)
        for (var retry = 0; retry < 8; retry++)
        {
            var target = (await store.ListAsync<TargetRow>(row => row.Id == id, ct)).Single();
            var items = await store.ListAsync<RequestItemRow>(row => row.RequestId == request.Id, ct);
            var item = items.FirstOrDefault(i => i.EpisodeId == target.EpisodeId);
            var now = DateTimeOffset.UtcNow;
            var writes = ImmutableArray.CreateBuilder<RowWrite>();
            if (item is null)
                writes.Add(new(new RequestItemRow { Id = Guid.NewGuid().ToString("N"), RequestId = request.Id, EpisodeId = target.EpisodeId, TargetId = id, Settlement = ItemSettlement.Open, SettledAt = null, CreatedAt = now, UpdatedAt = now }, null, null));
            else if (item.TargetId != id)
                writes.Add(new(item with { TargetId = id, UpdatedAt = now }, null, item));
            if (writes.Count == 0) break;
            if (await store.SaveAsync(writes, [], ct)) break;
            if (retry == 7) throw new InvalidOperationException("The target changed. Retry the request.");
        }
    }
}
