using System.Collections.Immutable;
using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Domain;

namespace TorrentFlow.Find;

internal sealed partial class FindService
{
    public async Task<CandidateBatch> SelectAsync(SearchRequest request, string hash, CancellationToken cancellationToken)
    {
        await using var scope = scopes.CreateAsyncScope();
        var store = scope.ServiceProvider.GetRequiredService<IStore>();
        var query = new StoreQuery(hash, null, null, null, null, null, null, null, null, null,
            null, null, null, null, 500, StoreOrder.PrimaryKey);
        var release = (await store.ReadAsync<ReleaseRow>(query, cancellationToken)).SingleOrDefault();
        if (release is null) return new(request.SessionId, 1, [], [], true, SearchNamePhase.English, SourceTier.Core);
        var observations = ImmutableArray.CreateBuilder<ReleaseObservationRow>();
        query = query with { Id = null, Hash = hash };
        while (true)
        {
            var page = await store.ReadAsync<ReleaseObservationRow>(query, cancellationToken);
            observations.AddRange(page);
            if (page.Length < query.Limit) break;
            query = query with { Cursor = Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(page[^1].Id)) };
        }
        var pool = new CandidatePool(parser, request.Work, request.Scope);
        var seen = observations.ToImmutable();
        if (seen.IsEmpty)
            pool.Add(new("owner", SourceOutcome.Success, [new(release.Name, hash, release.TotalBytes,
                null, null, "owner", null, release.Magnet, release.TorrentUri, null, [])], null, null,
                TimeSpan.Zero), "owner pick");
        foreach (var observation in seen)
            pool.Add(new(observation.SourceId, SourceOutcome.Success,
                [new(release.Name, hash, release.TotalBytes, observation.ListedSeeders, observation.ListedLeechers,
                    observation.SourceId, observation.SourceItemId, release.Magnet,
                    observation.TorrentUri ?? release.TorrentUri, observation.UploadedAt, observation.WebSeeds)],
                null, null, TimeSpan.Zero), observation.Query);
        return new(request.SessionId, 1, [.. pool.Candidates.Select(c => c with
            { Release = release with { Parsed = CandidatePool.MergeFlags(release.Parsed, c.Release.Parsed) } })],
            [], true, SearchNamePhase.English, SourceTier.Core) { Rejections = pool.Rejections };
    }
}
