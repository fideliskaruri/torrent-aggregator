using System.Collections.Immutable;
using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Domain;
using TorrentFlow.Store;
using TorrentFlow.Targets;

namespace TorrentFlow.Requests;

public sealed class AutomationRepository(IServiceScopeFactory scopes)
{
    public async Task<ImmutableArray<T>> ReadAsync<T>(CancellationToken ct) where T : StoreRow
    {
        await using var scope = scopes.CreateAsyncScope();
        var store = scope.ServiceProvider.GetRequiredService<TargetStore>();
        if (typeof(T) == typeof(AutoRuleRow))
            return [.. (T[])(object)await store.ListAsync<AutoRuleRow>(row => row.UserId == "local", ct)];
        return [.. await store.ListAsync<T>(null, ct)];
    }

    public async Task SaveAsync(StoreRow row, long? version, CancellationToken ct) =>
        await CommitAsync([new(row, version, null)], [], ct);

    public async Task SaveAsync(ImmutableArray<RowWrite> writes, CancellationToken ct) =>
        await CommitAsync(writes, [], ct);

    public async Task DeleteAsync(AutoRuleRow row, CancellationToken ct)
    {
        await using (var scope = scopes.CreateAsyncScope())
        {
            var store = scope.ServiceProvider.GetRequiredService<TargetStore>();
            var targets = await store.ListAsync<TargetRow>(null, ct);
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
        var store = scope.ServiceProvider.GetRequiredService<TargetStore>();
        if (!await store.SaveAsync(writes, deletes, ct))
            throw new InvalidOperationException("This changed while you were saving. Refresh and try again.");
    }
}
