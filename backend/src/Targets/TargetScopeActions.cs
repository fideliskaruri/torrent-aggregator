using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Domain;

namespace TorrentFlow.Targets;

public sealed partial class TargetPipeline
{
    public async Task<int> ScopeActionAsync(string workKey, int? season, int? episode,
        TargetAction action, CancellationToken ct)
    {
        if (action is not (TargetAction.Remove or TargetAction.TryNow))
            throw new ArgumentException("Choose Remove or Try now for a pending season.");
        await stateGate.WaitAsync(ct);
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredKeyedService<IStore>("targets");
            var catalog = new CatalogState(store);
            var work = (await catalog.ReadAsync<WorkRow>(CatalogState.Query(), ct))
                .FirstOrDefault(w => w.Id == workKey || w.WorkKey == workKey);
            if (work is null) return 0;
            var pending = (await catalog.ReadAsync<ScopeIntentRow>(CatalogState.Query(workId: work.Id), ct))
                .Where(s => s.State == ScopeIntentState.Pending &&
                    (season is null || s.ScopeData.Seasons.Contains(season.Value)) &&
                    (episode is null || s.Scope == RequestScope.Episodes &&
                        int.TryParse(s.Id.Split(':')[^1], out var number) && number == episode)).ToArray();
            var now = DateTimeOffset.UtcNow;
            if (pending.Length > 0)
                await CommitAsync(store, [.. pending.Select(s => new RowWrite(s with
                {
                    State = action == TargetAction.Remove && (season is null || s.ScopeData.Seasons.Length == 1)
                        ? ScopeIntentState.Cancelled : ScopeIntentState.Pending,
                    ScopeData = action == TargetAction.Remove && season is not null && s.ScopeData.Seasons.Length > 1
                        ? s.ScopeData with { Seasons = [.. s.ScopeData.Seasons.Where(n => n != season)] } : s.ScopeData,
                    NextTryAt = now, UpdatedAt = now, Version = s.Version + 1,
                }, s.Version, null))], [], ct);
            return pending.Length;
        }
        finally { stateGate.Release(); }
    }
}
