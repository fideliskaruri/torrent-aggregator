using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using static TorrentFlow.Metadata.Enrichment.TitleCleaning;

namespace TorrentFlow.Metadata.Browse;

/// <summary>types.ts Availability: state is ready | warm | fetchable | unavailable | null (unknown).</summary>
public sealed record Availability(string? State, string? InfoHash = null, double? Progress = null)
{
    public static readonly Availability Unknown = new((string?)null);
}

/// <summary>availability.ts AvailabilityQuery.</summary>
public sealed record AvailabilityQuery(string Title, int? Season = null, int? Episode = null, string? MediaType = null);

/// <summary>One cached search result, as the viable-match scanner sees it.</summary>
public sealed record CachedSearchHit(string Title, int Seeders, EpisodeFacts? Episode);

public sealed record EpisodeFacts(int? Season, int? Episode, bool IsSeasonPack);

/// <summary>
/// src/lib/browse/availability.ts: derived ready / warm / fetchable / unavailable / unknown state from EngineTorrent,
/// live-engine presence and the indexer search cache. Search-derived states are memoised 30 s; local states never.
/// </summary>
public sealed class AvailabilityResolver(
    IDbContextFactory<TorrentFlowDbContext> dbFactory,
    ITorrentPresenceProbe presence,
    TimeProvider time)
{
    public const int MinViableSeeders = 3;
    private static readonly TimeSpan MemoryTtl = TimeSpan.FromSeconds(30);
    private readonly ConcurrentDictionary<string, (DateTimeOffset Expires, Availability Value)> _memory = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, (DateTimeOffset Expires, IReadOnlyList<CachedSearchHit> Value)> _searchMemory = new(StringComparer.Ordinal);

    public void Reset() { _memory.Clear(); _searchMemory.Clear(); }

    /// <summary>resolveAvailabilityBatch: local first, then the search cache for queries with no local row.</summary>
    public async Task<List<Availability>> ResolveBatchAsync(string userId, IReadOnlyList<AvailabilityQuery> queries, CancellationToken ct = default)
    {
        if (queries.Count == 0) return [];
        var torrents = await ReadTorrentsAsync(userId, ct).ConfigureAwait(false);
        var filePresence = LocalFiles.Lookup(torrents);
        var local = queries.Select(q => ResolveLocalOnly(q, torrents, h => presence.Presence(userId, h), filePresence) ?? GetCached(CacheKey(userId, q))).ToList();
        var titles = queries.Where((_, i) => local[i] is null).Select(q => q.Title).ToList();
        var searchMap = await BatchGetSearchByTitleAsync(titles, ct).ConfigureAwait(false);
        var results = new List<Availability>(queries.Count);
        for (var i = 0; i < queries.Count; i++)
        {
            var cached = local[i] is null ? searchMap.GetValueOrDefault(NormalizeTitle(queries[i].Title)) : null;
            var result = ResolveWithSearchCache(queries[i], local[i], cached);
            SetCached(CacheKey(userId, queries[i]), result);
            results.Add(result);
        }
        return results;
    }

    /// <summary>resolveLocalAvailabilityBatch: ready / warm from EngineTorrent, otherwise unknown — never unavailable.</summary>
    public async Task<List<Availability>> ResolveLocalBatchAsync(string userId, IReadOnlyList<AvailabilityQuery> queries, CancellationToken ct = default)
    {
        if (queries.Count == 0) return [];
        var torrents = await ReadTorrentsAsync(userId, ct).ConfigureAwait(false);
        var filePresence = LocalFiles.Lookup(torrents);
        return queries.Select(q => ResolveLocalOnly(q, torrents, h => presence.Presence(userId, h), filePresence) ?? Availability.Unknown).ToList();
    }

    private async Task<List<EngineTorrent>> ReadTorrentsAsync(string userId, CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct).ConfigureAwait(false);
        return await db.EngineTorrents.AsNoTracking().Where(t => t.UserId == userId).ToListAsync(ct).ConfigureAwait(false);
    }

    private static string CacheKey(string userId, AvailabilityQuery q) =>
        $"avail:{userId}:{NormalizeTitle(q.Title)}:S{(q.Season?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "X")}E{(q.Episode?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "X")}";

    private Availability? GetCached(string key)
    {
        if (!_memory.TryGetValue(key, out var entry)) return null;
        if (entry.Expires >= time.GetUtcNow()) return entry.Value;
        _memory.TryRemove(key, out _);
        return null;
    }

    private void SetCached(string key, Availability value)
    {
        if (value.State is null or "ready" or "warm") return;
        _memory[key] = (time.GetUtcNow() + MemoryTtl, value);
    }

    private async Task<Dictionary<string, IReadOnlyList<CachedSearchHit>>> BatchGetSearchByTitleAsync(IEnumerable<string> titles, CancellationToken ct)
    {
        var result = new Dictionary<string, IReadOnlyList<CachedSearchHit>>(StringComparer.Ordinal);
        var needed = new List<string>();
        var now = time.GetUtcNow();
        foreach (var key in titles.Select(NormalizeTitle).Where(k => k.Length > 0).Distinct(StringComparer.Ordinal))
        {
            if (_searchMemory.TryGetValue(key, out var mem) && mem.Expires > now) result[key] = mem.Value;
            else needed.Add(key);
        }
        if (needed.Count == 0) return result;
        try
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct).ConfigureAwait(false);
            var rows = await db.SearchCaches.AsNoTracking().Where(r => r.NormalizedQuery != null && needed.Contains(r.NormalizedQuery))
                .OrderByDescending(r => r.ExpiresAt).Select(r => new { r.NormalizedQuery, r.Payload, r.ExpiresAt }).ToListAsync(ct).ConfigureAwait(false);
            foreach (var row in rows)
            {
                var q = row.NormalizedQuery!;
                if (result.ContainsKey(q) || ParsePayload(row.Payload) is not { } hits) continue;
                _searchMemory[q] = (new DateTimeOffset(DateTime.SpecifyKind(row.ExpiresAt, DateTimeKind.Utc)), hits);
                result[q] = hits;
            }
        }
        catch (Exception e) when (e is not OperationCanceledException) { }
        return result;
    }

    /// <summary>A SearchResponse payload's results; null on corrupt JSON.</summary>
    public static IReadOnlyList<CachedSearchHit>? ParsePayload(string payload)
    {
        try
        {
            using var doc = JsonDocument.Parse(payload);
            if (!doc.RootElement.TryGetProperty("results", out var results) || results.ValueKind != JsonValueKind.Array) return [];
            var hits = new List<CachedSearchHit>();
            foreach (var r in results.EnumerateArray())
            {
                if (r.ValueKind != JsonValueKind.Object) continue;
                var title = r.TryGetProperty("title", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString()! : "";
                var seeders = r.TryGetProperty("seeders", out var s) && s.ValueKind == JsonValueKind.Number ? (int)Math.Min(s.GetDouble(), int.MaxValue) : 0;
                EpisodeFacts? ep = null;
                if (r.TryGetProperty("episode", out var e) && e.ValueKind == JsonValueKind.Object)
                    ep = new(IntOf(e, "season"), IntOf(e, "episode"), e.TryGetProperty("isSeasonPack", out var p) && p.ValueKind == JsonValueKind.True);
                hits.Add(new(title, seeders, ep));
            }
            return hits;
        }
        catch (JsonException) { return null; }
    }

    private static int? IntOf(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var i) ? i : null;

    // ------------------------------------------------------------------ pure rules (exported for tests in TS)

    public static bool TorrentMatchesQuery(string torrentName, AvailabilityQuery query)
    {
        if (!NormalizeTitle(torrentName).Contains(NormalizeTitle(query.Title), StringComparison.Ordinal)) return false;
        if (query.Season is null && query.Episode is null) return true;
        var parsed = ReleaseNames.ParseEpisode(torrentName);
        if (parsed.IsSeasonPack && parsed.Season is { } packSeason)
        {
            if (query.Season == packSeason) return true;
            if (parsed.IsMultiSeason == true && query.Season is { } qs) return qs >= packSeason;
        }
        if (query.Season is not null && query.Episode is not null) return parsed.Season == query.Season && parsed.Episode == query.Episode;
        if (query.Season is not null) return parsed.Season == query.Season;
        return parsed.Episode == query.Episode;
    }

    /// <summary>resolveLocalOnly: null when no matching local row; {state:null} when a match exists but live state is unknown.</summary>
    public static Availability? ResolveLocalOnly(AvailabilityQuery query, IEnumerable<EngineTorrent> torrents,
        Func<string, TorrentPresence> readyPresence, Func<string, LocalFilePresence>? filePresence = null)
    {
        filePresence ??= _ => LocalFilePresence.Unknown;
        var matching = torrents.Where(t => TorrentMatchesQuery(t.Name, query) && filePresence(t.Hash) != LocalFilePresence.Absent).ToList();
        var sawAny = false;
        foreach (var ready in matching.Where(t => LocalFiles.PersistedTorrentIsDownloaded(t.Progress, t.VerifiedBitfield, t.VerifiedFilesJson) && t.Status != "removed"))
        {
            if (filePresence(ready.Hash) == LocalFilePresence.Present) return new("ready", ready.Hash);
            var live = readyPresence(ready.Hash);
            if (live == TorrentPresence.Present) return new("ready", ready.Hash);
            sawAny = true;
        }
        foreach (var warm in matching.Where(t => t.Progress > 0 && t.Progress < 1 && t.Status != "removed" && t.Status != "error"))
        {
            if (readyPresence(warm.Hash) == TorrentPresence.Present) return new("warm", warm.Hash, warm.Progress);
            sawAny = true;
        }
        return sawAny ? Availability.Unknown : null;
    }

    public static bool HasViableMatch(IEnumerable<CachedSearchHit> results, AvailabilityQuery query)
    {
        var title = NormalizeTitle(query.Title);
        foreach (var r in results)
        {
            if (!NormalizeTitle(r.Title).Contains(title, StringComparison.Ordinal)) continue;
            if (r.Seeders < MinViableSeeders) continue;
            if (query.Season is not null || query.Episode is not null)
            {
                var parsed = r.Episode ?? Facts(r.Title);
                if (parsed.IsSeasonPack && parsed.Season is not null)
                {
                    if (query.Season is not null && parsed.Season == query.Season) return true;
                    continue;
                }
                if (query.Season is not null && parsed.Season != query.Season) continue;
                if (query.Episode is not null && parsed.Episode != query.Episode) continue;
            }
            return true;
        }
        return false;
    }

    private static EpisodeFacts Facts(string title)
    {
        var ep = ReleaseNames.ParseEpisode(title);
        return new(ep.Season, ep.Episode, ep.IsSeasonPack);
    }

    public static Availability ResolveFromSearchCache(AvailabilityQuery query, IReadOnlyList<CachedSearchHit>? cached) =>
        cached is null ? Availability.Unknown : HasViableMatch(cached, query) ? new("fetchable") : new("unavailable");

    public static Availability ResolveWithSearchCache(AvailabilityQuery query, Availability? local, IReadOnlyList<CachedSearchHit>? cached) =>
        local ?? ResolveFromSearchCache(query, cached);
}
