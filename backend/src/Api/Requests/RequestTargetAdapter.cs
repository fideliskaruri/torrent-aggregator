using System.Collections.Immutable;
using TorrentFlow.Domain;
using TorrentFlow.Targets;

namespace TorrentFlow.Api.Requests;

// Request linkage is request-owned; target state and origin are authored by Targets.
internal static class RequestTargetAdapter
{
    internal static async Task Attach(IStore store, CatalogState catalog, RequestRow request,
        ImmutableArray<string> ids, CancellationToken ct)
    {
        foreach (var id in ids)
        for (var retry = 0; retry < 8; retry++)
        {
            var target = (await catalog.ReadAsync<TargetRow>(CatalogState.Query(id), ct)).Single();
            var items = await catalog.ReadAsync<RequestItemRow>(CatalogState.Query() with { RequestId = request.Id }, ct);
            var item = items.FirstOrDefault(i => i.EpisodeId == target.EpisodeId);
            var now = DateTimeOffset.UtcNow;
            var writes = ImmutableArray.CreateBuilder<RowWrite>();
            if (item is null)
                writes.Add(new(new RequestItemRow(Guid.NewGuid().ToString("N"), request.Id, target.EpisodeId,
                    id, ItemSettlement.Open, null, now, now), null, null));
            else if (item.TargetId != id)
                writes.Add(new(item with { TargetId = id, UpdatedAt = now }, null, item));
            if (writes.Count == 0) break;
            var key = Guid.NewGuid().ToString("N");
            var receipt = new AttemptRow($"commit:requests:{request.Id}:{key}", null, null, null,
                request.UserId, AttemptKind.LegacyEvent, now, now, "Attach request", null, null, null,
                null, null, null, null, null);
            var result = await store.CommitAsync(new(key, StoreOwner.Targets,
                [.. writes, new(receipt, null, null)], []), ct);
            if (result.Applied) break;
            if (retry == 7) throw new InvalidOperationException("The target changed. Retry the request.");
        }
    }
}
