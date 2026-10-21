using System.Security.Cryptography;
using System.Text;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Domain;
using TorrentFlow.Store;

namespace TorrentFlow.Find;

internal sealed class ReleaseFacts(IDbContextFactory<TorrentFlowDbContext> contexts, IParser parser)
{
    private readonly SemaphoreSlim writes = new(1);

    internal async Task SaveAsync(string sourceId, SourceQuery query, SourceResult result, CancellationToken ct)
    {
        var rows = result.Results.Select(raw => (Raw: raw,
                Hash: parser.NormalizeInfoHash(raw.Hash) ?? parser.NormalizeInfoHash(raw.Magnet ?? "")))
            .Where(row => row.Hash is not null &&
                row.Raw.Name.Length <= TorrentFlow.Parser.ReleaseParser.MaximumNameLength)
            .DistinctBy(row => row.Hash).ToArray();
        if (rows.Length == 0) return;
        await writes.WaitAsync(ct);
        try
        {
            await using var db = await contexts.CreateDbContextAsync(ct);
            await using var transaction = await db.Database.BeginTransactionAsync(ct);
            var hashes = rows.Select(row => row.Hash!).ToArray();
            var releases = await db.Releases.Where(r => hashes.Contains(r.Id)).ToDictionaryAsync(r => r.Id, ct);
            var observations = await db.ReleaseObservations.Where(o => hashes.Contains(o.Hash) &&
                o.SourceId == sourceId && o.Query == query.Query).ToDictionaryAsync(o => o.Hash, ct);
            var observedAt = result.Diagnostics?.StartedAt ?? DateTimeOffset.UtcNow;
            foreach (var (raw, hash) in rows)
            {
                var parsed = parser.Parse(raw.Name);
                if (releases.TryGetValue(hash!, out var previous))
                    db.Entry(previous).CurrentValues.SetValues(previous with
                    {
                        // Re-parse the stored name so parser fixes reach known releases and Parsed stays in step
                        // with Name; safety flags from earlier and this listing stay sticky.
                        Parsed = CandidatePool.MergeFlags(
                            CandidatePool.MergeFlags(parser.Parse(previous.Name), previous.Parsed), parsed),
                        FirstSeenAt = previous.FirstSeenAt < observedAt ? previous.FirstSeenAt : observedAt,
                        LastSeenAt = previous.LastSeenAt > observedAt ? previous.LastSeenAt : observedAt,
                        Magnet = previous.Magnet ?? raw.Magnet, TorrentUri = previous.TorrentUri ?? raw.TorrentUri,
                        TotalBytes = previous.TotalBytes ?? raw.Bytes
                    });
                else
                    db.Releases.Add(new ReleaseRow { Id = hash!, Name = raw.Name, Parsed = parsed,
                        TotalBytes = raw.Bytes, TorrentUri = raw.TorrentUri, Magnet = raw.Magnet,
                        Files = null, MetadataDigest = null, Private = null, FirstSeenAt = observedAt,
                        LastSeenAt = observedAt });
                var prior = observations.GetValueOrDefault(hash!);
                if (prior is null || observedAt > prior.ObservedAt)
                {
                    var observation = new ReleaseObservationRow
                    {
                        Id = prior?.Id ?? Convert.ToHexStringLower(SHA256.HashData(
                            Encoding.UTF8.GetBytes(hash + "\0" + sourceId + "\0" + query.Query))),
                        Hash = hash!, SourceId = sourceId, SourceItemId = raw.SourceItemId,
                        Query = query.Query, ListedSeeders = raw.ListedSeeders is >= 0 ? raw.ListedSeeders : null,
                        ListedLeechers = raw.ListedLeechers is >= 0 ? raw.ListedLeechers : null,
                        UploadedAt = raw.UploadedAt, ObservedAt = observedAt, TorrentUri = raw.TorrentUri,
                        WebSeeds = raw.WebSeeds
                    };
                    if (prior is null) db.ReleaseObservations.Add(observation);
                    else db.Entry(prior).CurrentValues.SetValues(observation);
                }
            }
            await db.SaveChangesAsync(ct);
            await transaction.CommitAsync(ct);
        }
        catch (DbUpdateException ex) when (ex.InnerException is SqliteException { SqliteErrorCode: 19 })
        {
            throw new InvalidOperationException("Find source facts conflicted.", ex);
        }
        finally { writes.Release(); }
    }
}
