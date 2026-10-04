using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Domain;
using TorrentFlow.Store;

namespace TorrentFlow.Targets;

public sealed partial class TargetPipeline
{
    public async Task<int> ScopeActionAsync(string workKey, int? season, int? episode,
        TargetAction action, CancellationToken ct)
    {
        if (action is not (TargetAction.Remove or TargetAction.TryNow))
            throw new ArgumentException("Choose Remove or Try now for a pending season.");
        var affected = 0;
        await using var resolutionScope = scopes.CreateAsyncScope();
        var canonical = (await resolutionScope.ServiceProvider.GetRequiredService<IMetadata>()
            .GetWorkAsync(workKey, false, ct)).Work?.Work;
        if (canonical is null) return 0;
        if (canonical.Id != workKey && canonical.WorkKey != workKey)
        {
            var aliasStore = resolutionScope.ServiceProvider.GetRequiredService<TargetStore>();
            var seasons = await aliasStore.ListAsync<SeasonRow>(row => row.WorkId == canonical.Id, ct);
            var seasonIds = seasons.Select(row => row.Id).ToArray();
            var episodes = await aliasStore.ListAsync<EpisodeRow>(row => seasonIds.Contains(row.SeasonId), ct);
            var links = await aliasStore.ListAsync<DownloadTargetRow>(null, ct);
            var downloads = await aliasStore.ListAsync<DownloadRow>(null, ct);
            var targets = await aliasStore.ListAsync<TargetRow>(row => row.WorkId == canonical.Id, ct);
            foreach (var target in targets.Where(t =>
                t.State is TargetState.Wanted or TargetState.Waiting or TargetState.Finding or TargetState.Checking or TargetState.Planning))
            {
                var item = episodes.FirstOrDefault(e => e.Id == target.EpisodeId);
                var itemSeason = seasons.FirstOrDefault(s => s.Id == item?.SeasonId);
                if (season is not null && itemSeason?.Number != season ||
                    episode is not null && item?.Number != episode ||
                    links.Any(l => l.TargetId == target.Id && downloads.Any(d => d.Id == l.DownloadId))) continue;
                if ((await ActionAsync(target.Id, action, ct)).Accepted) affected++;
            }
        }
        await stateGate.WaitAsync(ct);
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredService<TargetStore>();
            var pending = (await store.ListAsync<ScopeIntentRow>(row => row.WorkId == canonical.Id, ct))
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
            return affected + pending.Length;
        }
        finally { stateGate.Release(); }
    }
}
