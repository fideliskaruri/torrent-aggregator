using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using TorrentFlow.Domain;
using TorrentFlow.Store;

namespace TorrentFlow.Find;

internal sealed class SearchCache(IDbContextFactory<TorrentFlowDbContext> contexts, ILogger<SearchCache> log,
    IParser parser)
{
    private readonly SemaphoreSlim writes = new(1);
    internal async Task SaveFactsAsync(string sourceId, SourceQuery query, SourceResult result,
        ISet<string> seen, CancellationToken ct)
    {
        var rows = result.Results.Select(raw => (Raw: raw,
            Hash: parser.NormalizeInfoHash(raw.Hash) ?? parser.NormalizeInfoHash(raw.Magnet ?? "")))
            .Where(row => row.Hash is not null && row.Raw.Name.Length <= TorrentFlow.Parser.ReleaseParser.MaximumNameLength &&
                !seen.Contains(row.Hash)).DistinctBy(row => row.Hash).ToArray();
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
                        Parsed = CandidatePool.MergeFlags(previous.Parsed, parsed),
                        FirstSeenAt = previous.FirstSeenAt < observedAt ? previous.FirstSeenAt : observedAt,
                        LastSeenAt = previous.LastSeenAt > observedAt ? previous.LastSeenAt : observedAt,
                        Magnet = previous.Magnet ?? raw.Magnet, TorrentUri = previous.TorrentUri ?? raw.TorrentUri,
                        TotalBytes = previous.TotalBytes ?? raw.Bytes
                    });
                else
                    db.Releases.Add(new ReleaseRow { Id = hash!, Name = raw.Name, Parsed = parsed, TotalBytes = raw.Bytes, TorrentUri = raw.TorrentUri, Magnet = raw.Magnet, Files = null, MetadataDigest = null, Private = null, FirstSeenAt = observedAt, LastSeenAt = observedAt });
                var prior = observations.GetValueOrDefault(hash!);
                if (prior is null || observedAt > prior.ObservedAt)
                {
                    var observation = new ReleaseObservationRow { Id = prior?.Id ?? Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(hash + "\0" + sourceId + "\0" + query.Query))), Hash = hash!, SourceId = sourceId, SourceItemId = raw.SourceItemId, Query = query.Query, ListedSeeders = raw.ListedSeeders is >= 0 ? raw.ListedSeeders : null, ListedLeechers = raw.ListedLeechers is >= 0 ? raw.ListedLeechers : null, UploadedAt = raw.UploadedAt, ObservedAt = observedAt, TorrentUri = raw.TorrentUri, WebSeeds = raw.WebSeeds };
                    if (prior is null) db.ReleaseObservations.Add(observation);
                    else db.Entry(prior).CurrentValues.SetValues(observation);
                }
            }
            await db.SaveChangesAsync(ct);
            await transaction.CommitAsync(ct);
            foreach (var row in rows) seen.Add(row.Hash!);
        }
        catch (DbUpdateException ex) when (ex.InnerException is SqliteException { SqliteErrorCode: 19 })
        {
            throw new InvalidOperationException("Find source facts conflicted.", ex);
        }
        finally { writes.Release(); }
    }

    internal async Task<SearchCacheRow?> LoadAsync(string key, string sourceId, SourceQuery query, CancellationToken ct)
    {
        try
        {
            await using var db = await contexts.CreateDbContextAsync(ct);
            var normalized = SearchQueries.Fold(query.Query);
            return await db.SearchCaches.AsNoTracking().SingleOrDefaultAsync(row => row.NormalizedQuery == normalized &&
                row.ScopeKey == key && row.SourceId == sourceId && row.SourceRevision == query.SourceRevision &&
                row.CredentialRevision == query.CredentialRevision && row.ParserVersion == 1, ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            log.LogWarning(ex, "Find cache could not be read; continuing with source search.");
            return null;
        }
    }

    internal async Task SaveAsync(string key, string sourceId, SourceQuery query, SourceResult result,
        SearchCacheRow? previous, CancellationToken ct, DateTimeOffset? expiresAt = null, bool retryAttempted = false)
    {
        await writes.WaitAsync(ct);
        try
        {
            await using var db = await contexts.CreateDbContextAsync(ct);
            var now = DateTimeOffset.UtcNow;
            var id = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(key)));
            var row = new SearchCacheRow { Id = id, NormalizedQuery = SearchQueries.Fold(query.Query), ScopeKey = key, SourceId = sourceId, SourceRevision = query.SourceRevision, CredentialRevision = query.CredentialRevision, ParserVersion = 1, Payload = new([.. result.Results.Select(r => parser.NormalizeInfoHash(r.Hash) ??
                    parser.NormalizeInfoHash(r.Magnet ?? "")).OfType<string>().Distinct()], result)
                    { FailureRetryAttempted = retryAttempted }, Complete = result.Complete, CreatedAt = expiresAt is not null && previous is not null ? previous.CreatedAt : now, ExpiresAt = expiresAt ?? now.AddMinutes(30) };
            var current = await db.SearchCaches.FindAsync([id], ct);
            // A flight replaces only the row it read; the background retry claim relies on losing to newer writes.
            if (current is null != previous is null || current is not null &&
                JsonSerializer.Serialize(current) != JsonSerializer.Serialize(previous))
            {
                log.LogWarning("Find cache write conflicted for {SourceId}.", sourceId);
                return;
            }
            if (current is null) db.SearchCaches.Add(row);
            else db.Entry(current).CurrentValues.SetValues(row);
            await db.SaveChangesAsync(ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            log.LogWarning(ex, "Find cache could not be saved; source results remain usable.");
        }
        finally { writes.Release(); }
    }
}
