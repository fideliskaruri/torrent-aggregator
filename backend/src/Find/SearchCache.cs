using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using TorrentFlow.Domain;

namespace TorrentFlow.Find;

internal sealed class SearchCache(IServiceScopeFactory scopes, ILogger<SearchCache> log, IParser parser)
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
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredKeyedService<IStore>("find");
            var changes = new List<RowWrite>();
            var observedAt = result.Diagnostics?.StartedAt ?? DateTimeOffset.UtcNow;
            foreach (var (raw, hash) in rows)
            {
                var previous = (await store.ReadAsync<ReleaseRow>(ById(hash!), ct)).FirstOrDefault();
                var parsed = parser.Parse(raw.Name);
                var release = previous is null
                    ? new ReleaseRow(hash!, raw.Name, parsed, raw.Bytes, raw.TorrentUri, raw.Magnet,
                        null, null, null, observedAt, observedAt)
                    : previous with
                    {
                        Parsed = CandidatePool.MergeFlags(previous.Parsed, parsed),
                        FirstSeenAt = previous.FirstSeenAt < observedAt ? previous.FirstSeenAt : observedAt,
                        LastSeenAt = previous.LastSeenAt > observedAt ? previous.LastSeenAt : observedAt,
                        Magnet = previous.Magnet ?? raw.Magnet, TorrentUri = previous.TorrentUri ?? raw.TorrentUri,
                        TotalBytes = previous.TotalBytes ?? raw.Bytes
                    };
                if (release != previous) changes.Add(new(release, null, previous));
                var observationId = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(
                    hash + "\0" + sourceId + "\0" + query.Query)));
                var prior = await ObservationAsync(store, observationId, hash!, sourceId, query.Query, ct);
                if (prior is null || observedAt > prior.ObservedAt)
                {
                    var observation = new ReleaseObservationRow(prior?.Id ?? observationId, hash!, sourceId, raw.SourceItemId,
                        query.Query, raw.ListedSeeders is >= 0 ? raw.ListedSeeders : null,
                        raw.ListedLeechers is >= 0 ? raw.ListedLeechers : null, raw.UploadedAt, observedAt,
                        raw.TorrentUri, raw.WebSeeds);
                    changes.Add(new(observation, null, prior));
                }
            }
            if (changes.Count > 0)
            {
                var receiptKey = Guid.NewGuid().ToString("N");
                var now = DateTimeOffset.UtcNow;
                changes.Add(new(new AttemptRow("commit:find-facts:" + receiptKey, null, null, null, null,
                    AttemptKind.LegacyEvent, now, now, "source_facts", null, null, null, null, null, null, null, null), null, null));
                var committed = await store.CommitAsync(new(receiptKey, StoreOwner.Find, [.. changes], []), ct);
                if (!committed.Applied) throw new InvalidOperationException("Find source facts conflicted.");
            }
            foreach (var row in rows) seen.Add(row.Hash!);
        }
        finally { writes.Release(); }
    }

    private static StoreQuery ById(string id) => new(id, null, null, null, null, null, null,
        null, null, null, null, null, null, null, 1, StoreOrder.PrimaryKey);

    private static async Task<ReleaseObservationRow?> ObservationAsync(IStore store, string id, string hash,
        string sourceId, string query, CancellationToken ct)
    {
        var exact = (await store.ReadAsync<ReleaseObservationRow>(ById(id), ct)).FirstOrDefault();
        if (exact is not null) return exact;
        // Earlier writers may use a different primary key; the Store identity is hash/source/query.
        string? cursor = null;
        while (true)
        {
            var rows = await store.ReadAsync<ReleaseObservationRow>(new(null, null, null, null, null, hash,
                null, null, null, null, sourceId, null, null, cursor, 500, StoreOrder.PrimaryKey), ct);
            var matching = rows.FirstOrDefault(row => row.Query == query);
            if (matching is not null || rows.Length < 500) return matching;
            cursor = Convert.ToBase64String(Encoding.UTF8.GetBytes(rows[^1].Id));
        }
    }
    internal async Task<SearchCacheRow?> LoadAsync(string key, string sourceId, SourceQuery query, CancellationToken ct)
    {
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredKeyedService<IStore>("find");
            var rows = await store.ReadAsync<SearchCacheRow>(new(null, null, null, null, null, null,
                SearchQueries.Fold(query.Query), null, null, null, sourceId, null, null, null, 200,
                StoreOrder.PrimaryKey), ct);
            return rows.Where(row => row.ScopeKey == key && row.SourceRevision == query.SourceRevision &&
                row.CredentialRevision == query.CredentialRevision && row.ParserVersion == 1)
                .OrderByDescending(row => row.CreatedAt).FirstOrDefault();
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            log.LogWarning(ex, "Find cache could not be read; continuing with source search.");
            return null;
        }
    }

    internal async Task SaveAsync(string key, string sourceId, SourceQuery query, SourceResult result,
        SearchCacheRow? previous, CancellationToken ct)
    {
        await writes.WaitAsync(ct);
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredKeyedService<IStore>("find");
            var now = DateTimeOffset.UtcNow;
            var id = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(key)));
            var row = new SearchCacheRow(id, SearchQueries.Fold(query.Query), key, sourceId,
                query.SourceRevision, query.CredentialRevision, 1,
                new([.. result.Results.Select(r => parser.NormalizeInfoHash(r.Hash) ??
                    parser.NormalizeInfoHash(r.Magnet ?? "")).OfType<string>().Distinct()], result),
                true, now, now.AddMinutes(30));
            var receiptKey = Guid.NewGuid().ToString("N");
            var receipt = new AttemptRow("commit:find:" + receiptKey, null, null, null, null,
                AttemptKind.LegacyEvent, now, now, "cache", null, null, null, null, null, null, null, null);
            var committed = await store.CommitAsync(new(receiptKey, StoreOwner.Find,
                [new(row, null, previous), new(receipt, null, null)], []), ct);
            if (!committed.Applied) log.LogWarning("Find cache write conflicted for {SourceId}.", sourceId);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            log.LogWarning(ex, "Find cache could not be saved; source results remain usable.");
        }
        finally { writes.Release(); }
    }
}
