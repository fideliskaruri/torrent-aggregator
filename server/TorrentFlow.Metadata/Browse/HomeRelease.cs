using System.Collections.Concurrent;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Metadata.Artwork;
using TorrentFlow.Metadata.Providers;

namespace TorrentFlow.Metadata.Browse;

/// <summary>home-release.ts HomeReleaseSignal. Dates are ISO days (yyyy-MM-dd).</summary>
public sealed record HomeReleaseSignal(
    bool Checked,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? TheatricalReleasedAt,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? ReleasedAt,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? NextHomeReleaseAt)
{
    public static readonly HomeReleaseSignal None = new(false, null, null, null);
}

/// <summary>home-release.ts TheatricalGate.</summary>
public sealed record TheatricalGate(bool InTheatricalWindow, string? NextHomeReleaseAt)
{
    public static readonly TheatricalGate Open = new(false, null);
}

/// <summary>One TMDB release_dates entry (type 1-6, release_date ISO).</summary>
public sealed record TmdbReleaseDate(int? Type, string? ReleaseDate);

/// <summary>src/lib/browse/home-release.ts: the theatrical-window rule from TMDB release_dates evidence.</summary>
public static partial class HomeRelease
{
    private static readonly HashSet<int> HomeTypes = [4, 5, 6];
    private static readonly HashSet<int> KnownTypes = [1, 2, 3, 4, 5, 6];
    private static readonly HashSet<string> MovieTypes = new(["movie", "movies", "film", "feature"], StringComparer.Ordinal);

    [GeneratedRegex(@"^(\d{4}-\d{2}-\d{2})")] private static partial Regex IsoDayPrefix();
    [GeneratedRegex(@"^\d{4}-\d{2}-\d{2}$")] private static partial Regex IsoDayExact();

    public static bool IsMovie(string? mediaType) => MovieTypes.Contains(mediaType?.Trim().ToLowerInvariant() ?? "");

    public static string Day(DateTimeOffset now) => now.UtcDateTime.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    public static string? IsoDay(DateTime? value) => value is { } d ? DateTime.SpecifyKind(d, d.Kind == DateTimeKind.Unspecified ? DateTimeKind.Utc : d.Kind)
        .ToUniversalTime().ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) : null;

    public static string? IsoDay(string? value)
    {
        var m = IsoDayPrefix().Match(value?.Trim() ?? "");
        return m.Success ? m.Groups[1].Value : null;
    }

    public static bool IsIsoDayOrNull(string? value) => value is null || IsoDayExact().IsMatch(value);

    /// <summary>Flatten TMDB <c>release_dates.results[].release_dates[]</c>.</summary>
    public static List<TmdbReleaseDate> ReleaseDatesOf(JsonElement? detail)
    {
        var output = new List<TmdbReleaseDate>();
        if (detail is not { ValueKind: JsonValueKind.Object } d || !d.TryGetProperty("release_dates", out var rd)
            || rd.ValueKind != JsonValueKind.Object || !rd.TryGetProperty("results", out var results) || results.ValueKind != JsonValueKind.Array)
            return output;
        foreach (var country in results.EnumerateArray())
        {
            if (country.ValueKind != JsonValueKind.Object || !country.TryGetProperty("release_dates", out var dates) || dates.ValueKind != JsonValueKind.Array) continue;
            foreach (var e in dates.EnumerateArray())
            {
                if (e.ValueKind != JsonValueKind.Object) continue;
                output.Add(new(TmdbClient.Int(e, "type"), TmdbClient.Str(e, "release_date")));
            }
        }
        return output;
    }

    public static HomeReleaseSignal ClassifyHomeReleaseEvidence(IEnumerable<TmdbReleaseDate>? entries, DateTimeOffset now)
    {
        var today = Day(now);
        List<string> theatricalPast = [], past = [], future = [];
        var sawDated = false;
        foreach (var entry in entries ?? [])
        {
            var type = entry.Type ?? 0;
            var date = IsoDay(entry.ReleaseDate);
            if (!KnownTypes.Contains(type) || date is null) continue;
            sawDated = true;
            var onOrBeforeToday = string.CompareOrdinal(date, today) <= 0;
            if (type <= 3 && onOrBeforeToday) theatricalPast.Add(date);
            if (!HomeTypes.Contains(type)) continue;
            (onOrBeforeToday ? past : future).Add(date);
        }
        if (!sawDated) return HomeReleaseSignal.None;
        static string? First(List<string> list) => list.Order(StringComparer.Ordinal).FirstOrDefault();
        return new(true, First(theatricalPast), First(past), First(future));
    }

    /// <summary>
    /// With no TMDB release dates for a film (no key, or TMDB lists none), it counts as in cinemas for this many days
    /// after its release date. Against TMDB's evidence for 121 home films on 1 Oct 2026 it caught 12 of the 24 still in
    /// cinemas and wrongly gated 16; longer windows caught a few more for many more wrong (45 days: 17 and 34).
    /// </summary>
    public const int UncheckedCinemaDays = 21;

    public static TheatricalGate TheatricalGateFromSignal(string? mediaType, string? releaseDay, HomeReleaseSignal? signal, DateTimeOffset now)
    {
        if (!IsMovie(mediaType)) return TheatricalGate.Open;
        var today = Day(now);
        var primary = IsoDay(releaseDay);
        if (primary is null || string.CompareOrdinal(primary, today) > 0) return TheatricalGate.Open;
        if (signal?.Checked != true)
            return string.CompareOrdinal(primary, Day(now.AddDays(-UncheckedCinemaDays))) >= 0 ? new(true, null) : TheatricalGate.Open;
        var theatrical = IsoDay(signal.TheatricalReleasedAt);
        if (theatrical is null || string.CompareOrdinal(theatrical, today) > 0) return TheatricalGate.Open;
        var earliestHome = new[] { signal.ReleasedAt, signal.NextHomeReleaseAt }.Select(IsoDay).OfType<string>()
            .Order(StringComparer.Ordinal).FirstOrDefault();
        if (earliestHome is not null && string.CompareOrdinal(earliestHome, today) <= 0) return TheatricalGate.Open;
        return new(true, earliestHome);
    }
}

/// <summary>
/// src/lib/browse/home-release-cache.ts: TMDB release-date evidence cached in SearchCache under
/// <c>browse:home-release:{tmdb:id, or the work key when the row has no TMDB id}</c>. Reads never touch the network;
/// refreshes are background, bounded to 4.
/// Only checked evidence is persisted (6 h). A miss stays in memory for 15 minutes and is dropped the moment the TMDB
/// key is added, removed or replaced. With no key there is nothing to read or refresh, so the 21-day rule decides.
/// </summary>
public sealed class HomeReleaseCache(
    IDbContextFactory<TorrentFlowDbContext> dbFactory,
    ArtworkResolver artwork,
    TmdbClient tmdb,
    TimeProvider time,
    ILogger<HomeReleaseCache> logger)
{
    public const string CachePrefix = "browse:home-release:";
    public const string PayloadKind = "browse-home-release";
    public const int PayloadVersion = 3;
    private static readonly TimeSpan CheckedTtl = TimeSpan.FromHours(6);
    private static readonly TimeSpan UnknownTtl = TimeSpan.FromMinutes(15);
    private const int Concurrency = 4;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly ConcurrentDictionary<string, (DateTimeOffset ExpiresAt, HomeReleaseSignal Signal)> _memory = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, byte> _pending = new(StringComparer.Ordinal);
    private readonly Lock _keyLock = new();
    private (long Revision, bool HasKey) _keyState;

    /// <summary>The background refresh task of the last <see cref="ScheduleRefresh"/> call (tests await it).</summary>
    public Task LastRefresh { get; private set; } = Task.CompletedTask;

    public void Reset() { _memory.Clear(); _pending.Clear(); }

    /// <summary>On any TMDB key change, drops every unchecked signal so the next home load checks again.</summary>
    private (long Revision, bool HasKey) SyncKeyState()
    {
        var state = (tmdb.CredentialRevision, tmdb.HasKey);
        lock (_keyLock)
        {
            if (_keyState == state) return state;
            _keyState = state;
            foreach (var (key, entry) in _memory)
                if (!entry.Signal.Checked) _memory.TryRemove(key, out _);
        }
        return state;
    }

    private sealed record Payload(string Kind, int Version, HomeReleaseSignal Signal);

    /// <summary>The evidence key: the TMDB id when the row has one (namesakes share a work key), else the work key.</summary>
    public static string KeyOf(CatalogEntry row) => TmdbIdOf(row) is { } id ? $"tmdb:{id}" : row.WorkKey;

    private static int? TmdbIdOf(CatalogEntry row) =>
        row.Provider == "tmdb" && int.TryParse(row.ProviderId, NumberStyles.None, CultureInfo.InvariantCulture, out var id) ? id : null;

    private static List<CatalogEntry> Candidates(IEnumerable<CatalogEntry> rows, DateTimeOffset now)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        return rows.Where(r => !string.IsNullOrEmpty(r.WorkKey) && HomeRelease.IsMovie(r.MediaType)
            && r.ReleaseDate is { } d && DateTime.SpecifyKind(d, DateTimeKind.Utc) <= now.UtcDateTime && seen.Add(KeyOf(r))).ToList();
    }

    public static HomeReleaseSignal? Decode(string payload)
    {
        try
        {
            using var doc = JsonDocument.Parse(payload);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object
                || !root.TryGetProperty("kind", out var kind) || kind.ValueKind != JsonValueKind.String || kind.GetString() != PayloadKind
                || !root.TryGetProperty("version", out var version) || version.ValueKind != JsonValueKind.Number || version.GetDouble() != PayloadVersion
                || !root.TryGetProperty("signal", out var s) || s.ValueKind != JsonValueKind.Object
                || !s.TryGetProperty("checked", out var c) || c.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                return null;
            bool Day(string name, out string? value)
            {
                value = null;
                if (!s.TryGetProperty(name, out var e)) return false;
                if (e.ValueKind == JsonValueKind.Null) return true;
                if (e.ValueKind != JsonValueKind.String) return false;
                value = e.GetString();
                return HomeRelease.IsIsoDayOrNull(value);
            }
            if (!Day("theatricalReleasedAt", out var theatrical) || !Day("releasedAt", out var released) || !Day("nextHomeReleaseAt", out var next)) return null;
            return new(c.GetBoolean(), theatrical, released, next);
        }
        catch (JsonException) { return null; }
    }

    public static string Encode(HomeReleaseSignal signal) => JsonSerializer.Serialize(new Payload(PayloadKind, PayloadVersion, signal), Json);

    public async Task<Dictionary<string, HomeReleaseSignal>> ReadSignalsAsync(IEnumerable<CatalogEntry> rows, CancellationToken ct = default)
    {
        var now = time.GetUtcNow();
        var output = new Dictionary<string, HomeReleaseSignal>(StringComparer.Ordinal);
        if (!SyncKeyState().HasKey) return output;
        var needed = new List<string>();
        foreach (var row in Candidates(rows, now))
        {
            var key = KeyOf(row);
            if (_memory.TryGetValue(key, out var hit) && hit.ExpiresAt > now) output[key] = hit.Signal;
            else { _memory.TryRemove(key, out _); needed.Add(key); }
        }
        if (needed.Count == 0) return output;
        try
        {
            var keys = needed.Select(k => CachePrefix + k).ToList();
            var nowUtc = now.UtcDateTime;
            await using var db = await dbFactory.CreateDbContextAsync(ct).ConfigureAwait(false);
            var cached = await db.SearchCaches.AsNoTracking().Where(r => keys.Contains(r.CacheKey) && r.ExpiresAt > nowUtc)
                .Select(r => new { r.CacheKey, r.Payload, r.ExpiresAt }).ToListAsync(ct).ConfigureAwait(false);
            foreach (var row in cached)
            {
                if (!row.CacheKey.StartsWith(CachePrefix, StringComparison.Ordinal)) continue;
                var key = row.CacheKey[CachePrefix.Length..];
                // Older builds persisted misses too; only checked evidence is trusted from disk.
                if (key.Length == 0 || Decode(row.Payload) is not { Checked: true } signal) continue;
                output[key] = signal;
                _memory[key] = (new DateTimeOffset(DateTime.SpecifyKind(row.ExpiresAt, DateTimeKind.Utc)), signal);
            }
        }
        catch (Exception e) when (e is not OperationCanceledException) { logger.LogDebug(e, "[home-release] cache read failed"); }
        return output;
    }

    /// <summary>scheduleHomeReleaseRefresh: fire-and-forget; never throws into the caller.</summary>
    public void ScheduleRefresh(IEnumerable<CatalogEntry> rows, IReadOnlyDictionary<string, HomeReleaseSignal> known)
    {
        var now = time.GetUtcNow();
        var state = SyncKeyState();
        if (!state.HasKey) return;
        var work = Candidates(rows, now).Where(r => !known.ContainsKey(KeyOf(r)) && _pending.TryAdd(KeyOf(r), 0)).ToList();
        if (work.Count == 0) return;
        LastRefresh = Task.Run(() => Parallel.ForEachAsync(work, new ParallelOptions { MaxDegreeOfParallelism = Concurrency }, async (row, token) =>
        {
            try
            {
                var signal = await FetchSignalAsync(row, now).ConfigureAwait(false);
                await WriteSignalAsync(KeyOf(row), signal, now, state).ConfigureAwait(false);
            }
            catch (Exception e) { logger.LogDebug(e, "[home-release] refresh failed for {WorkKey}", row.WorkKey); }
            finally { _pending.TryRemove(KeyOf(row), out _); }
        }));
    }

    /// <summary>
    /// One film's evidence for the title page when it has no TMDB detail of its own (a Cinemeta card): the same lookup
    /// and cache entry as its home card. Null with no key, so the 21-day rule decides on both pages.
    /// </summary>
    public async Task<HomeReleaseSignal?> SignalForAsync(string title, int? year, CancellationToken ct = default)
    {
        var state = SyncKeyState();
        if (!state.HasKey) return null;
        var now = time.GetUtcNow();
        var row = new CatalogEntry { WorkKey = Catalog.CatalogText.CatalogWorkKey(title, year, "movie"), Title = title, Year = year,
            MediaType = "movie", ReleaseDate = now.UtcDateTime };
        if ((await ReadSignalsAsync([row], ct).ConfigureAwait(false)).TryGetValue(KeyOf(row), out var known)) return known;
        var signal = await FetchSignalAsync(row, now).ConfigureAwait(false);
        await WriteSignalAsync(KeyOf(row), signal, now, state).ConfigureAwait(false);
        return signal;
    }

    private async Task<HomeReleaseSignal> FetchSignalAsync(CatalogEntry row, DateTimeOffset now)
    {
        try
        {
            // A row that knows its TMDB id uses it: a title search can land on a namesake ("The Runner" found "Runner").
            var reference = TmdbIdOf(row) is { } id ? new TmdbRef(id, "movie")
                : await artwork.ResolveTmdbRefAsync(new ArtworkQuery(row.Title, row.Year, "movie")).ConfigureAwait(false);
            if (reference is null || reference.MediaType != "movie") return HomeReleaseSignal.None;
            var detail = await tmdb.FetchDetailAsync("movie", reference.Id, 4_000).ConfigureAwait(false);
            if (detail is null) return HomeReleaseSignal.None;
            return HomeRelease.ClassifyHomeReleaseEvidence(HomeRelease.ReleaseDatesOf(detail), now);
        }
        catch (Exception e) when (e is not OutOfMemoryException) { return HomeReleaseSignal.None; }
    }

    private async Task WriteSignalAsync(string workKey, HomeReleaseSignal signal, DateTimeOffset now, (long Revision, bool HasKey) state)
    {
        if (!signal.Checked)
        {
            // A miss stays in memory only, and only if the key it was fetched with is still the key.
            lock (_keyLock) { if (_keyState == state) _memory[workKey] = (now + UnknownTtl, signal); }
            return;
        }
        var expiresAt = now + CheckedTtl;
        _memory[workKey] = (expiresAt, signal);
        try
        {
            var key = CachePrefix + workKey;
            await using var db = await dbFactory.CreateDbContextAsync().ConfigureAwait(false);
            var row = await db.SearchCaches.FirstOrDefaultAsync(r => r.CacheKey == key).ConfigureAwait(false);
            if (row is null)
            {
                row = new SearchCache { Id = Ids.New(), CacheKey = key, CreatedAt = now.UtcDateTime };
                db.SearchCaches.Add(row);
            }
            row.NormalizedQuery = null;
            row.Payload = Encode(signal);
            row.ExpiresAt = expiresAt.UtcDateTime;
            await db.SaveChangesAsync().ConfigureAwait(false);
        }
        catch (Exception e) { logger.LogDebug(e, "[home-release] cache write failed"); }
    }
}
