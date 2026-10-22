using Microsoft.EntityFrameworkCore;
using TorrentFlow.Domain;

namespace TorrentFlow.Find;

internal sealed partial class FindService
{
    public async Task<CandidateBatch> SelectAsync(SearchRequest request, string hash,
        CancellationToken cancellationToken, bool ownerPick = false)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var release = await db.Releases.AsNoTracking().SingleOrDefaultAsync(r => r.Id == hash, cancellationToken);
        if (release is null) return new(request.SessionId, 1, [], [], true, SearchNamePhase.English, SourceTier.Core);
        var seen = await db.ReleaseObservations.AsNoTracking().Where(o => o.Hash == hash).OrderBy(o => o.Id)
            .ToListAsync(cancellationToken);
        var pool = new CandidatePool(parser, request.Work, request.Scope, ownerPick ? hash : null);
        if (seen.Count == 0)
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
