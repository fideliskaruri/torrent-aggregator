using System.Collections.Immutable;
using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Domain;
using TorrentFlow.Library;

namespace TorrentFlow.Targets;

internal sealed record ItemAdmission(ImmutableArray<OwnedItem> Owned, ImmutableHashSet<string> Held)
{
    internal bool Holds(string? episodeId) => Held.Contains(episodeId ?? "film");
}

internal static class TargetAdmission
{
    internal static async Task<ItemAdmission> ReadAsync(IServiceProvider services, TargetScope scope,
        CancellationToken ct, ImmutableArray<ImportReviewItem>? pending = null)
    {
        var owned = await services.GetRequiredService<ILibraryPlacement>().OwnedAsync(scope, ct);
        var held = ImmutableHashSet.CreateBuilder<string>();
        if (scope.Film ? owned.Any(o => o.EpisodeId is null) :
            scope.EpisodeIds.All(id => owned.Any(o => o.EpisodeId == id)))
            return new(owned, held.ToImmutable());
        var reviews = pending ?? await services.GetRequiredService<ImportReviews>().CandidatesAsync(scope.WorkId, ct);
        if (reviews.IsEmpty) return new(owned, held.ToImmutable());
        if (scope.Film)
        {
            if (reviews.Any(i => i.Candidates.Any(c => c.Kind != WorkKind.Series)))
                held.Add("film");
        }
        else
        {
            var catalog = new CatalogState(services.GetRequiredKeyedService<IStore>("targets"));
            var seasons = await catalog.ReadAsync<SeasonRow>(CatalogState.Query(workId: scope.WorkId), ct);
            var episodes = await catalog.ReadAsync<EpisodeRow>(CatalogState.Query(), ct);
            foreach (var id in scope.EpisodeIds.Where(id => !owned.Any(o => o.EpisodeId == id)))
            {
                var episode = episodes.FirstOrDefault(e => e.Id == id);
                var season = seasons.FirstOrDefault(s => s.Id == episode?.SeasonId);
                if (reviews.Any(i => i.Candidates.Any(c => Covers(i, c, id, episode, season))))
                    held.Add(id);
            }
        }
        return new(owned, held.ToImmutable());
    }

    internal static async Task<bool> HoldsAsync(IServiceProvider services, TargetRow target, CancellationToken ct) =>
        (await ReadAsync(services, new(target.WorkId,
            target.EpisodeId is null ? [] : [target.EpisodeId], target.EpisodeId is null), ct)).Holds(target.EpisodeId);

    internal static async Task<ImmutableHashSet<string>> HeldTargetsAsync(IServiceProvider services,
        IEnumerable<TargetRow> targets, CancellationToken ct)
    {
        var held = ImmutableHashSet.CreateBuilder<string>();
        var groups = targets.GroupBy(t => t.WorkId).ToArray();
        if (groups.Length == 0) return held.ToImmutable();
        var pending = await services.GetRequiredService<ImportReviews>().CandidatesAsync(
            [.. groups.Select(g => g.Key)], ct);
        foreach (var group in groups)
        {
            var admission = await ReadAsync(services, new(group.Key,
                [.. group.Where(t => t.EpisodeId is not null).Select(t => t.EpisodeId!).Distinct()],
                group.Any(t => t.EpisodeId is null)), ct, pending[group.Key]);
            foreach (var target in group.Where(t => admission.Holds(t.EpisodeId))) held.Add(target.Id);
        }
        return held.ToImmutable();
    }

    private static bool Covers(ImportReviewItem item, ImportCandidate candidate, string id,
        EpisodeRow? episode, SeasonRow? season)
    {
        if (candidate.Kind == WorkKind.Film) return false;
        if (candidate.EpisodeId == id) return true;
        if (candidate.Season is not null || candidate.Episode is not null)
            return episode is not null && (candidate.Season is null || candidate.Season == season?.Number) &&
                (candidate.Episode is null || candidate.Episode == episode.Number);
        if (candidate.EpisodeId is not null) return false;
        var parsed = item.Parsed;
        var seasons = parsed.Seasons.IsEmpty
            ? item.Parents.FirstOrDefault(p => !p.Seasons.IsEmpty)?.Seasons ?? [] : parsed.Seasons;
        if (seasons.IsEmpty && parsed.Episodes.IsEmpty && parsed.AbsoluteNumbers.IsEmpty) return true;
        return episode is not null &&
            (seasons.IsEmpty || season is not null && seasons.Contains(season.Number)) &&
            (parsed.Episodes.IsEmpty || parsed.Episodes.Contains(episode.Number)) &&
            (parsed.AbsoluteNumbers.IsEmpty || parsed.AbsoluteNumbers.Contains(episode.AbsoluteNumber ?? -1));
    }
}
