using System.Collections.Immutable;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Domain;
using TorrentFlow.Store;

namespace TorrentFlow.Metadata;

internal sealed partial class Catalog
{
    private Task<WorkSnapshot?> SnapshotAsync(string id, CancellationToken ct) => SnapshotAsync(dbs, id, ct);

    internal static async Task<WorkSnapshot?> SnapshotAsync(IDbContextFactory<TorrentFlowDbContext> dbs, string id, CancellationToken ct)
    {
        await using var db = await dbs.CreateDbContextAsync(ct);
        var work = await db.Works.AsNoTracking().SingleOrDefaultAsync(w => w.Id == id, ct)
            ?? await db.Works.AsNoTracking().SingleOrDefaultAsync(w => w.WorkKey == id, ct);
        if (work is null) return null;
        var seasons = await db.Seasons.AsNoTracking().Where(s => s.WorkId == work.Id)
            .OrderBy(s => s.Number).ThenBy(s => s.Id).ToListAsync(ct);
        var seasonIds = seasons.Select(s => s.Id).ToArray();
        var episodes = await db.Episodes.AsNoTracking().Where(e => seasonIds.Contains(e.SeasonId))
            .OrderBy(e => e.SeasonId).ThenBy(e => e.Id).ToListAsync(ct);
        var names = await db.WorkNames.AsNoTracking().Where(n => n.WorkId == work.Id)
            .OrderBy(n => n.Ordinal).ThenBy(n => n.Id).ToListAsync(ct);
        var links = await db.WorkLinks.AsNoTracking().Where(l => l.WorkId == work.Id).OrderBy(l => l.Id).ToListAsync(ct);
        return new(work, [.. names], [.. links], [.. seasons], [.. episodes]);
    }

    private Task<List<WorkLinkRow>> LinksAsync(CancellationToken ct) => LinksAsync(dbs, ct);

    private static async Task<List<WorkLinkRow>> LinksAsync(IDbContextFactory<TorrentFlowDbContext> dbs, CancellationToken ct)
    {
        await using var db = await dbs.CreateDbContextAsync(ct);
        return await db.WorkLinks.AsNoTracking().OrderBy(l => l.Id).ToListAsync(ct);
    }

    private Task<ImmutableArray<WorkSnapshot>> PersistListingsAsync(IEnumerable<WorkSnapshot> candidates, CancellationToken ct) => PersistListingsAsync(dbs, candidates, ct);

    internal static async Task<ImmutableArray<WorkSnapshot>> PersistListingsAsync(IDbContextFactory<TorrentFlowDbContext> dbs,
        IEnumerable<WorkSnapshot> candidates, CancellationToken ct)
    {
        await commits.WaitAsync(ct);
        try
        {
            var links = (await LinksAsync(dbs, ct)).Where(l => l.Status == LinkStatus.Verified)
                .GroupBy(l => (l.Provider, l.ProviderKind, l.ExternalId))
                .ToDictionary(g => g.Key, g => g.Select(l => l.WorkId).Distinct().ToArray());
            var rows = new Dictionary<string, StoreRow>();
            var result = ImmutableArray.CreateBuilder<WorkSnapshot>();
            foreach (var proposed in candidates.DistinctBy(w => w.Work.WorkKey))
            {
                var primary = proposed.Links.FirstOrDefault(l => l.IsPrimary && l.Status == LinkStatus.Verified);
                var claimed = proposed.Links.Where(l => l.Status == LinkStatus.Verified)
                    .SelectMany(l => links.GetValueOrDefault((l.Provider, l.ProviderKind, l.ExternalId), []))
                    .Distinct().ToArray();
                var anchor = primary is null ? null :
                    links.GetValueOrDefault((primary.Provider, primary.ProviderKind, primary.ExternalId), []).FirstOrDefault();
                anchor ??= claimed.Length == 1 ? claimed[0] : null;
                if (anchor is not null)
                {
                    result.Add(proposed with { Work = proposed.Work with { Id = anchor } });
                    continue;
                }
                if (claimed.Length > 1) continue;
                foreach (var row in proposed.Links.Cast<StoreRow>()
                    .Concat(proposed.Names.Where(n => n.Label != NameLabel.Synonym)).Concat(proposed.Seasons)
                    .Concat(proposed.Episodes).Prepend(proposed.Work))
                    rows.TryAdd(row.Id, row);
                foreach (var link in proposed.Links.Where(l => l.Status == LinkStatus.Verified))
                    links.TryAdd((link.Provider, link.ProviderKind, link.ExternalId), [proposed.Work.Id]);
                result.Add(proposed);
            }
            if (rows.Count > 0)
            {
                await using var db = await dbs.CreateDbContextAsync(ct);
                db.AddRange(rows.Values);
                try { await db.SaveChangesAsync(ct); }
                catch (DbUpdateException ex) when (ProviderHttp.Conflict(ex))
                {
                    throw new IOException("Catalog listing changed while it was being saved.", ex);
                }
            }
            return result.ToImmutable();
        }
        finally { commits.Release(); }
    }

}
