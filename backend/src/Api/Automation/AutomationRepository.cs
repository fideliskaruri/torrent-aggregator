using System.Collections.Immutable;
using TorrentFlow.Domain;
using TorrentFlow.Targets;

namespace TorrentFlow.Api.Automation;

internal sealed class AutomationRepository(IServiceScopeFactory scopes)
{
    internal async Task<ImmutableArray<T>> ReadAsync<T>(CancellationToken ct) where T : StoreRow
    {
        await using var scope = scopes.CreateAsyncScope();
        return await new CatalogState(scope.ServiceProvider.GetRequiredKeyedService<IStore>("targets"))
            .ReadAsync<T>(CatalogState.Query(userId: typeof(T) == typeof(AutoRuleRow) ? "local" : null), ct);
    }

    internal async Task SaveAsync(StoreRow row, long? version, CancellationToken ct) =>
        await CommitAsync([new(row, version, null)], [], ct);

    internal async Task SaveAsync(ImmutableArray<RowWrite> writes, CancellationToken ct) =>
        await CommitAsync(writes, [], ct);

    internal async Task DeleteAsync(AutoRuleRow row, CancellationToken ct) =>
        await CommitAsync([], [new(StoreTable.AutoRule, row.Id, row.Version, null)], ct);

    private async Task CommitAsync(ImmutableArray<RowWrite> writes, ImmutableArray<RowDelete> deletes, CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        var store = scope.ServiceProvider.GetRequiredKeyedService<IStore>("targets");
        var key = Guid.NewGuid().ToString("N");
        var now = DateTimeOffset.UtcNow;
        var receipt = new AttemptRow("commit:automation:" + key, null, null, null, "local",
            AttemptKind.LegacyEvent, now, now, "Saved automation", null, null, null, null, null, null, null, null);
        var result = await store.CommitAsync(new(key, StoreOwner.Targets,
            [.. writes, new(receipt, null, null)], deletes), ct);
        if (!result.Applied) throw new InvalidOperationException("This changed while you were saving. Refresh and try again.");
    }
}
