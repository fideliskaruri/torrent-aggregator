using Microsoft.EntityFrameworkCore;
using TorrentFlow.Core;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Core.Text;
using TorrentFlow.Data;
using TorrentFlow.Metadata.Catalog;

namespace TorrentFlow.Metadata.Artwork;

/// <summary>
/// A release name's poster: the work it names (stored or catalog art, through <see cref="WorkPosters"/>), else an
/// artwork lookup on the parsed title and year.
/// </summary>
public sealed class ReleasePosters(ArtworkResolver resolver, IDbContextFactory<TorrentFlowDbContext> dbFactory) : IReleasePosters
{
    public async Task<IReadOnlyDictionary<string, string>> ForReleasesAsync(IReadOnlyDictionary<string, string?> releases, CancellationToken ct = default)
    {
        var found = new Dictionary<string, string>(StringComparer.Ordinal);
        if (releases.Count == 0) return found;
        var identities = releases.Keys.Where(n => !string.IsNullOrWhiteSpace(n))
            .ToDictionary(n => n, ReleaseNames.IdentityFor, StringComparer.Ordinal);
        var keys = identities.ToDictionary(p => p.Key, p => WorkKeySlug.WorkKeyFor(p.Value.Name, p.Value.Year), StringComparer.Ordinal);
        await using (var db = await dbFactory.CreateDbContextAsync(ct).ConfigureAwait(false))
        {
            var known = await WorkPosters.LoadAsync(db, keys.Values, ct).ConfigureAwait(false);
            foreach (var (name, key) in keys)
                if (WorkPosters.Pick(known, key, null) is { } poster) found[name] = poster;
        }
        var misses = identities.Keys.Where(n => !found.ContainsKey(n)).ToList();
        if (misses.Count == 0) return found;
        var queries = misses.Select(n => new ArtworkQuery(identities[n].Name, identities[n].Year, MediaTypes.Normalize(releases[n]))).ToList();
        var art = await resolver.ResolveBatchAsync(queries, ct).ConfigureAwait(false);
        for (var i = 0; i < misses.Count && i < art.Count; i++)
            if (!string.IsNullOrWhiteSpace(art[i].PosterUrl)) found[misses[i]] = art[i].PosterUrl!;
        return found;
    }
}