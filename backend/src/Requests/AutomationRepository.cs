using System.Collections.Immutable;
using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Domain;
using TorrentFlow.Targets;

namespace TorrentFlow.Requests;

public sealed class AutomationRepository(IServiceScopeFactory scopes)
{
    public async Task<ImmutableArray<T>> ReadAsync<T>(CancellationToken ct) where T : StoreRow
    {
        await using var scope = scopes.CreateAsyncScope();
        return await new CatalogState(scope.ServiceProvider.GetRequiredService<IStore>())
            .ReadAsync<T>(CatalogState.Query(userId: typeof(T) == typeof(AutoRuleRow) ? "local" : null), ct);
    }

    public async Task SaveAsync(StoreRow row, long? version, CancellationToken ct) =>
        await CommitAsync([new(row, version, null)], [], ct);

    public async Task SaveAsync(ImmutableArray<RowWrite> writes, CancellationToken ct) =>
        await CommitAsync(writes, [], ct);

    public async Task DeleteAsync(AutoRuleRow row, CancellationToken ct)
    {
        await using (var scope = scopes.CreateAsyncScope())
        {
            var store = scope.ServiceProvider.GetRequiredService<IStore>();
            var catalog = new CatalogState(store);
            var targets = await catalog.ReadAsync<TargetRow>(CatalogState.Query(), ct);
            var attached = targets.Where(target => target.AutoRuleId == row.Id).ToArray();
            if (attached.Length > 0)
                await CommitAsync([.. attached.Select(target => new RowWrite(target with
                {
                    AutoRuleId = null,
                    Version = target.Version + 1,
                }, target.Version, null))], [], ct);
        }
        await CommitAsync([], [new(StoreTable.AutoRule, row.Id, row.Version, null)], ct);
    }

    private async Task CommitAsync(ImmutableArray<RowWrite> writes, ImmutableArray<RowDelete> deletes, CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        var store = scope.ServiceProvider.GetRequiredService<IStore>();
        var key = Guid.NewGuid().ToString("N");
        var now = DateTimeOffset.UtcNow;
        var receipt = new AttemptRow { Id = "commit:automation:" + key, TargetId = null, WorkId = null, ReleaseHash = null, ActorUserId = "local", Kind = AttemptKind.LegacyEvent, StartedAt = now, EndedAt = now, Outcome = "Saved automation", ReasonCode = null, ReasonText = null, Decision = null, LegacyContext = null, BatchId = null, DownloadId = null, DeadlineAt = null, Swap = null };
        var result = await store.CommitAsync(new(key, StoreOwner.Targets,
            [.. writes, new(receipt, null, null)], deletes), ct);
        if (!result.Applied) throw new InvalidOperationException("This changed while you were saving. Refresh and try again.");
    }
}
