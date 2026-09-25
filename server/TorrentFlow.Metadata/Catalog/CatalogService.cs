using System.Globalization;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Metadata.Artwork;
using TorrentFlow.Metadata.Browse;
using TorrentFlow.Metadata.Enrichment;
using TorrentFlow.Metadata.Providers;

namespace TorrentFlow.Metadata.Catalog;

/// <summary>One title from a TMDB chart (src/lib/catalog/tmdb.ts TmdbTitle).</summary>
public sealed record CatalogTitle(int TmdbId, string Kind, string Title, int? Year, string MediaType, string? PosterUrl,
    string? BackdropUrl, string? Overview, double? Rating, string? ReleaseDate);

/// <summary>One release from an apibay precompiled top-100 feed.</summary>
public sealed record FeedRelease(string Name, int Seeders, int Leechers, string? InfoHash, long? SizeBytes);

public sealed record CatalogFeed(string Id, int Category, string Label, string MediaType, string Source);

/// <summary>works.ts CatalogWork: one work collapsed from chart releases.</summary>
public sealed record ChartWork(string WorkKey, string Title, int? Year, string MediaType, int TotalSeeders, int PeakSeeders, string BestRelease, int ReleaseCount);

/// <summary>detail.ts CatalogDetail.</summary>
public sealed record CatalogDetail(string? Overview, double? Rating, string? ReleaseDate);

/// <summary>A row to be written into CatalogEntry.</summary>
public sealed record CatalogDraft(string WorkKey, string Title, int? Year, string MediaType, string? PosterUrl, string? BackdropUrl,
    string? Overview, double? Rating, int Seeders, string? BestRelease, DateTime? ReleaseDate);

/// <summary>Pure catalog helpers ported from src/lib/catalog/{tmdb,feeds,availability,store}.ts and src/lib/metadata/slop.ts.</summary>
public static partial class CatalogText
{
    public static readonly IReadOnlyList<CatalogFeed> Feeds =
    [
        new("movies-hd", 207, "HD Movies", "movie", "trending"),
        new("tv-hd", 208, "HD TV", "tv", "popular"),
        new("tv", 205, "TV", "tv", "popular"),
    ];

    private static readonly HashSet<string> Placeholders =
        ["unknown title", "untitled", "no title", "tba", "tbd", "n a", "null", "undefined", "none", "placeholder", "coming soon"];

    [GeneratedRegex(@"^untitled\b")] private static partial Regex UntitledPrefix();
    [GeneratedRegex(@"^(?:episode|ep|season|movie|film|part|chapter|vol(?:ume)?|pt)\s*#?\s*\d+$")] private static partial Regex BareCoordinate();
    [GeneratedRegex(@"^(?:s\d{1,3}\s*e\d{1,4}|\d{1,3}x\d{1,4}|e(?:p(?:isode)?)?\s*\d{1,4})$")] private static partial Regex EpisodeCode();
    [GeneratedRegex(@"[\p{L}\p{N}]")] private static partial Regex LetterOrDigit();
    [GeneratedRegex(@"[._\-–—|/]+")] private static partial Regex SlopSeparators();
    [GeneratedRegex(@"\s+")] private static partial Regex Spaces();
    [GeneratedRegex(@"['’`]")] private static partial Regex Apostrophes();
    [GeneratedRegex(@"[^\p{L}\p{N}]+")] private static partial Regex NonAlnum();
    [GeneratedRegex(@"^(\d{4})")] private static partial Regex LeadingYear();
    [GeneratedRegex(@"^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?")] private static partial Regex IsoDate();
    [GeneratedRegex(@"\p{L}")] private static partial Regex AnyLetter();

    /// <summary>slop.ts isSlopTitle: placeholder / coordinate / structural junk.</summary>
    public static bool IsSlopTitle(string? raw)
    {
        if (string.IsNullOrEmpty(raw)) return true;
        var trimmed = raw.Trim();
        if (trimmed.Length < 2 || !LetterOrDigit().IsMatch(trimmed)) return true;
        var norm = Spaces().Replace(SlopSeparators().Replace(trimmed.ToLowerInvariant(), " "), " ").Trim();
        return norm.Length == 0 || Placeholders.Contains(norm) || UntitledPrefix().IsMatch(norm) ||
               BareCoordinate().IsMatch(norm) || EpisodeCode().IsMatch(norm);
    }

    /// <summary>work-identity.ts normalizeForKey.</summary>
    public static string NormalizeForKey(string s) =>
        Spaces().Replace(NonAlnum().Replace(Apostrophes().Replace(s.ToLowerInvariant(), ""), " "), " ").Trim();

    /// <summary>
    /// availability.ts catalogWorkKey: the key a release of this title would produce under workIdentity — series
    /// through a synthetic "S01E01", films through "{title} {year}".
    /// </summary>
    public static string CatalogWorkKey(string title, int? year, string? mediaType)
    {
        var trimmed = title.Trim();
        if (trimmed.Length == 0) return "";
        if (MediaTypes.IsSeries(mediaType)) return ReleaseNames.WorkIdentity($"{trimmed} S01E01").Key;
        return ReleaseNames.WorkIdentity(year is { } y && y != 0 ? $"{trimmed} {y.ToString(CultureInfo.InvariantCulture)}" : trimmed).Key;
    }

    /// <summary>store.ts catalogEntryId: sha1(source \0 seed \0 workKey).</summary>
    public static string CatalogEntryId(string source, string? seedTitle, string workKey) =>
        Convert.ToHexStringLower(SHA1.HashData(Encoding.UTF8.GetBytes($"{source}\0{seedTitle ?? ""}\0{workKey}")));

    public static int? ParseYear(string? value)
    {
        if (value is null) return null;
        var m = LeadingYear().Match(value.Trim());
        return m.Success && int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture) is var y && y > 1800 ? y : null;
    }

    /// <summary>tmdb.ts parseReleaseDate: full or year-only date to YYYY-MM-DD, else null.</summary>
    public static string? ParseReleaseDate(string? value)
    {
        if (value is null) return null;
        var m = IsoDate().Match(value.Trim());
        if (!m.Success) return null;
        var y = int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture);
        var mo = m.Groups[2].Success ? int.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture) : 1;
        var d = m.Groups[3].Success ? int.Parse(m.Groups[3].Value, CultureInfo.InvariantCulture) : 1;
        if (y <= 1800 || mo is < 1 or > 12 || d < 1 || d > DateTime.DaysInMonth(y, mo)) return null;
        return $"{y:D4}-{mo:D2}-{d:D2}";
    }

    public static double? ParseRating(JsonElement e, string name) =>
        TmdbClient.Num(e, name) is { } v && double.IsFinite(v) && v > 0 && v <= 10 ? Math.Round(v * 10, MidpointRounding.AwayFromZero) / 10 : null;

    private static string? FirstString(params string?[] values) =>
        values.Select(v => v?.Trim()).FirstOrDefault(v => !string.IsNullOrEmpty(v));

    /// <summary>tmdb.ts parseTmdbList.</summary>
    public static List<CatalogTitle> ParseTmdbList(JsonElement data, string kind, string imageBase = "https://image.tmdb.org/t/p")
    {
        var output = new List<CatalogTitle>();
        if (data.ValueKind != JsonValueKind.Object || !data.TryGetProperty("results", out var results) || results.ValueKind != JsonValueKind.Array) return output;
        var seen = new HashSet<int>();
        foreach (var row in results.EnumerateArray())
        {
            if (row.ValueKind != JsonValueKind.Object) continue;
            if (!row.TryGetProperty("id", out var idEl) || idEl.ValueKind != JsonValueKind.Number || !idEl.TryGetInt32(out var id) || id <= 0 || seen.Contains(id)) continue;
            var title = FirstString(TmdbClient.Str(row, "title"), TmdbClient.Str(row, "name"));
            if (title is null) continue;
            string? rowKind = kind;
            if (row.TryGetProperty("media_type", out var mtEl) && mtEl.ValueKind != JsonValueKind.Null)
                rowKind = mtEl.ValueKind == JsonValueKind.String && mtEl.GetString() is "movie" or "tv" ? mtEl.GetString() : null;
            if (rowKind is null || MediaTypes.Normalize(rowKind) is not { } mediaType) continue;
            seen.Add(id);
            var date = TmdbClient.Str(row, "release_date") ?? TmdbClient.Str(row, "first_air_date");
            output.Add(new CatalogTitle(id, rowKind, title, ParseYear(date), mediaType,
                Image(imageBase, TmdbClient.Str(row, "poster_path"), "w500"), Image(imageBase, TmdbClient.Str(row, "backdrop_path"), "w1280"),
                FirstString(TmdbClient.Str(row, "overview")), ParseRating(row, "vote_average"), ParseReleaseDate(date)));
        }
        return output;
    }

    public static string? Image(string imageBase, string? path, string size) =>
        string.IsNullOrWhiteSpace(path) ? null : $"{imageBase}/{size}{(path.StartsWith('/') ? path : "/" + path)}";

    private static int ToInt(JsonElement e)
    {
        if (e.ValueKind == JsonValueKind.Number) return e.TryGetInt64(out var l) ? (int)Math.Clamp(l, int.MinValue, int.MaxValue) : (int)e.GetDouble();
        return e.ValueKind == JsonValueKind.String && e.GetString() is { } str && Controllers.TitleSearchController.ParseIntPrefix(str) is { } v ? v : 0;
    }

    /// <summary>feeds.ts parseFeedBody.</summary>
    public static List<FeedRelease> ParseFeedBody(JsonElement data)
    {
        var releases = new List<FeedRelease>();
        if (data.ValueKind != JsonValueKind.Array) return releases;
        foreach (var raw in data.EnumerateArray())
        {
            if (raw.ValueKind != JsonValueKind.Object) continue;
            var name = TmdbClient.Str(raw, "name")?.Trim() ?? "";
            if (name.Length == 0 || name == "No results returned") continue;
            var hash = TmdbClient.Str(raw, "info_hash")?.Trim();
            long size = raw.TryGetProperty("size", out var s) ? ToInt(s) : 0;
            releases.Add(new FeedRelease(name,
                raw.TryGetProperty("seeders", out var se) ? ToInt(se) : 0,
                raw.TryGetProperty("leechers", out var le) ? ToInt(le) : 0,
                string.IsNullOrEmpty(hash) ? null : hash.ToLowerInvariant(),
                size == 0 ? null : size));
        }
        return releases;
    }

    /// <summary>works.ts isRenderableWorkName.</summary>
    public static bool IsRenderableWorkName(string name)
    {
        var trimmed = name.Trim();
        return trimmed.Length >= 2 && AnyLetter().IsMatch(trimmed) && !IsSlopTitle(trimmed);
    }

    /// <summary>works.ts resolveWorkMediaType: a release that parses as a series is never filed as a film.</summary>
    public static string? ResolveWorkMediaType(string? declared, bool isSeries)
    {
        var normalized = MediaTypes.Normalize(declared);
        return isSeries && !MediaTypes.IsSeries(normalized) ? "tv" : normalized;
    }

    /// <summary>works.ts collapseToWorks: group chart releases by workIdentity key, rank by total then peak seeders.</summary>
    public static List<ChartWork> CollapseToWorks(IEnumerable<(FeedRelease Release, string MediaType)> items)
    {
        var works = new Dictionary<string, ChartWork>(StringComparer.Ordinal);
        foreach (var (release, declared) in items)
        {
            var name = release.Name?.Trim();
            if (string.IsNullOrEmpty(name)) continue;
            var identity = ReleaseNames.WorkIdentity(name);
            if (!IsRenderableWorkName(identity.Name)) continue;
            if (ResolveWorkMediaType(declared, identity.IsSeries) is not { } mediaType) continue;
            var seeders = Math.Max(0, release.Seeders);
            if (!works.TryGetValue(identity.Key, out var existing))
            {
                works[identity.Key] = new ChartWork(identity.Key, identity.Name, identity.Year, mediaType, seeders, seeders, name, 1);
                continue;
            }
            works[identity.Key] = seeders > existing.PeakSeeders
                ? existing with { TotalSeeders = existing.TotalSeeders + seeders, ReleaseCount = existing.ReleaseCount + 1, PeakSeeders = seeders, BestRelease = name }
                : existing with { TotalSeeders = existing.TotalSeeders + seeders, ReleaseCount = existing.ReleaseCount + 1 };
        }
        // localeCompare parity for the final tiebreak.
        return works.Values.OrderByDescending(w => w.TotalSeeders).ThenByDescending(w => w.PeakSeeders)
            .ThenBy(w => w.Title, StringComparer.InvariantCulture).ToList();
    }

    /// <summary>works.ts seedWorkKeys: the seed's own keys as a film and as a series.</summary>
    public static HashSet<string> SeedWorkKeys(string seedTitle) =>
        new([ReleaseNames.WorkIdentity(seedTitle).Key, ReleaseNames.WorkIdentity($"{seedTitle} S01E01").Key], StringComparer.Ordinal);

    /// <summary>works.ts pickRelated: same-type neighbours of the seed in the chart pool, unseen first.</summary>
    public static List<CatalogEntry> PickRelated(IReadOnlyList<CatalogEntry> pool, string seedTitle, string? seedMediaType, int limit,
        IReadOnlySet<string>? alreadyOnScreen = null)
    {
        var seedKeys = SeedWorkKeys(seedTitle);
        var onScreen = alreadyOnScreen ?? new HashSet<string>();
        var seedIndex = pool.Select((w, i) => (w, i)).FirstOrDefault(x => seedKeys.Contains(x.w.WorkKey), (null!, -1)).Item2;
        return pool.Select((work, index) => (work, index))
            .Where(x => !seedKeys.Contains(x.work.WorkKey))
            .Where(x => seedMediaType is null || MediaTypes.Normalize(x.work.MediaType) == seedMediaType)
            .OrderBy(x => onScreen.Contains(x.work.WorkKey) ? 1 : 0)
            .ThenBy(x => seedIndex >= 0 ? Math.Abs(x.index - seedIndex) : 0)
            .ThenBy(x => x.index)
            .Take(limit).Select(x => x.work).ToList();
    }

    public static CatalogDraft DraftFromRow(CatalogEntry row) =>
        new(row.WorkKey, row.Title, row.Year, row.MediaType, row.PosterUrl, row.BackdropUrl, row.Overview, row.Rating, row.Seeders, row.BestRelease, row.ReleaseDate);

    /// <summary>store.ts draftFromWork: a chart-derived work plus whatever the detail lookup resolved.</summary>
    public static CatalogDraft DraftFromWork(ChartWork work, string? posterUrl, string? backdropUrl, CatalogDetail? detail) =>
        new(work.WorkKey, work.Title, work.Year, work.MediaType, posterUrl, backdropUrl, detail?.Overview, detail?.Rating,
            work.PeakSeeders, work.BestRelease, ReleaseDateToDate(detail?.ReleaseDate));

    public static DateTime? ReleaseDateToDate(string? value) =>
        ParseReleaseDate(value) is { } d ? DateTime.SpecifyKind(DateTime.ParseExact(d, "yyyy-MM-dd", CultureInfo.InvariantCulture), DateTimeKind.Utc) : null;

    /// <summary>store.ts dedupeByWorkKey: the first draft claiming a key wins.</summary>
    public static List<CatalogDraft> DedupeByWorkKey(IEnumerable<CatalogDraft> drafts)
    {
        var seen = new HashSet<string>();
        return drafts.Where(d => d.WorkKey.Length > 0 && seen.Add(d.WorkKey)).ToList();
    }

    public static CatalogDraft DraftFromTmdb(CatalogTitle t, string workKey, int seeders = 0, string? bestRelease = null) =>
        new(workKey, t.Title, t.Year, t.MediaType, t.PosterUrl, t.BackdropUrl, t.Overview, t.Rating, seeders, bestRelease,
            t.ReleaseDate is { } d ? DateTime.SpecifyKind(DateTime.ParseExact(d, "yyyy-MM-dd", CultureInfo.InvariantCulture), DateTimeKind.Utc) : null);
}

/// <summary>media-type.ts normalizeMediaType.</summary>
public static class MediaTypes
{
    private static readonly Dictionary<string, string> Aliases = new()
    {
        ["anime"] = "anime", ["movie"] = "movie", ["movies"] = "movie", ["film"] = "movie",
        ["tv"] = "tv", ["series"] = "tv", ["show"] = "tv", ["tvshow"] = "tv",
    };

    public static string? Normalize(string? raw) =>
        string.IsNullOrEmpty(raw) ? null : Aliases.GetValueOrDefault(raw.Trim().ToLowerInvariant());

    /// <summary>media-type.ts isSeriesMediaType.</summary>
    public static bool IsSeries(string? raw) => Normalize(raw) is "tv" or "anime";
}

/// <summary>
/// Catalog store + refresh (src/lib/catalog/{store,refresh,feeds,tmdb}.ts). Reads are one indexed query against
/// CatalogEntry; refreshes are single-flight and never empty a catalog on outage.
/// </summary>
public sealed class CatalogService(
    IDbContextFactory<TorrentFlowDbContext> dbFactory,
    TmdbClient tmdb,
    IHttpClientFactory httpFactory,
    IOptions<MetadataOptions> options,
    TimeProvider time,
    ILogger<CatalogService> logger,
    ArtworkResolver? artwork = null) : ICatalogLookup
{
    public static readonly TimeSpan CatalogTtl = TimeSpan.FromHours(1);
    public const int ColdStartBudgetMs = 12_000;
    public const int RelatedBudgetMs = 4_000;
    public const int WorksPerSource = 48;
    public const int RailHead = 24;
    public const int FeedTimeoutMs = 8_000;
    public const int TmdbTimeoutMs = 8_000;
    public const int TmdbReadTimeoutMs = 3_500;
    private const int TmdbPages = 2;

    public const string BrowserUserAgent =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

    private readonly Lock _gate = new();
    private Task<CatalogRefreshResult>? _inFlight;
    private readonly Dictionary<string, Task<int>> _relatedInFlight = new(StringComparer.Ordinal);

    public sealed record CatalogRefreshResult(Dictionary<string, int> Written, List<string> Errors, bool Offline, Dictionary<string, string> Origin, long TookMs);

    public async Task<CatalogWork?> FindByWorkKeyAsync(string workKey, CancellationToken ct = default)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct).ConfigureAwait(false);
        var row = await db.CatalogEntries.AsNoTracking()
            .Where(e => e.WorkKey == workKey)
            .OrderBy(e => e.Source == "related").ThenBy(e => e.Rank)
            .FirstOrDefaultAsync(ct).ConfigureAwait(false);
        return row is null ? null : ToWork(row);
    }

    public static CatalogWork ToWork(CatalogEntry e) =>
        new(e.Id, e.WorkKey, e.Title, e.Year, e.MediaType, e.PosterUrl, e.BackdropUrl, e.Overview, e.Rating, e.Source, e.Rank,
            e.ReleaseDate?.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), e.WorkId);

    public async Task<List<CatalogEntry>> ReadRowsAsync(string source, string? seedTitle, int limit, CancellationToken ct = default)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct).ConfigureAwait(false);
        return await db.CatalogEntries.AsNoTracking()
            .Where(e => e.Source == source && e.SeedTitle == seedTitle)
            .OrderBy(e => e.Rank).ThenBy(e => e.Title)
            .Take(limit).ToListAsync(ct).ConfigureAwait(false);
    }

    public async Task<(int EntryCount, DateTime? RefreshedAt)> ReadStatusAsync(CancellationToken ct = default)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct).ConfigureAwait(false);
        var count = await db.CatalogEntries.CountAsync(ct).ConfigureAwait(false);
        var newest = await db.CatalogEntries.OrderByDescending(e => e.RefreshedAt)
            .Select(e => (DateTime?)e.RefreshedAt).FirstOrDefaultAsync(ct).ConfigureAwait(false);
        return (count, newest);
    }

    public bool IsStale(DateTime? refreshedAt) => refreshedAt is null || time.GetUtcNow().UtcDateTime - refreshedAt.Value > CatalogTtl;

    /// <summary>refresh.ts ensureCatalogFresh: cold waits up to 12 s; stale refreshes behind. Never throws.</summary>
    public async Task<(int EntryCount, DateTime? RefreshedAt, bool Blocked)> EnsureFreshAsync(CancellationToken ct = default)
    {
        (int, DateTime?) status;
        try { status = await ReadStatusAsync(ct).ConfigureAwait(false); }
        catch (Exception e) when (e is not OperationCanceledException) { return (0, null, false); }

        if (status.Item1 == 0)
        {
            var refresh = RefreshAsync();
            await Task.WhenAny(refresh, Task.Delay(TimeSpan.FromMilliseconds(ColdStartBudgetMs), time, ct)).ConfigureAwait(false);
            try { var after = await ReadStatusAsync(ct).ConfigureAwait(false); return (after.EntryCount, after.RefreshedAt, true); }
            catch (Exception e) when (e is not OperationCanceledException) { return (0, null, true); }
        }
        if (IsStale(status.Item2)) _ = RefreshAsync();
        return (status.Item1, status.Item2, false);
    }

    /// <summary>Single-flight catalog refresh. Returned, never thrown.</summary>
    public Task<CatalogRefreshResult> RefreshAsync()
    {
        lock (_gate)
        {
            if (_inFlight is not null) return _inFlight;
            var task = Task.Run(RunRefreshAsync);
            _inFlight = task;
            _ = task.ContinueWith(_ => { lock (_gate) _inFlight = null; }, TaskScheduler.Default);
            return task;
        }
    }

    private async Task<CatalogRefreshResult> RunRefreshAsync()
    {
        var started = time.GetTimestamp();
        var written = new Dictionary<string, int>();
        var origin = new Dictionary<string, string>();
        var errors = new List<string>();
        try
        {
            var chartsTask = Task.WhenAll(CatalogText.Feeds.Select(FetchFeedAsync));
            var trendingTask = Task.WhenAll(new[] { ("movie", "trending"), ("tv", "popular") }.Select(s => FetchTrendingAsync(s.Item1, s.Item2)));
            var charts = await chartsTask.ConfigureAwait(false);
            var trending = await trendingTask.ConfigureAwait(false);
            errors.AddRange(charts.Where(c => c.Error is not null).Select(c => $"{c.Feed.Label}: {c.Error}"));
            errors.AddRange(trending.Where(t => t.Error is not null).Select(t => $"TMDB {t.Kind}: {t.Error}"));
            var answered = charts.Where(c => c.Error is null && c.Releases.Count > 0).ToList();
            var index = answered.Count > 0
                ? new AvailabilityIndex(CatalogText.CollapseToWorks(answered.SelectMany(c => c.Releases.Select(r => (r, c.Feed.MediaType)))))
                : AvailabilityIndex.Empty;

            var prepared = new List<(string Source, List<CatalogDraft> Drafts)>();
            foreach (var t in trending)
            {
                if (t.Titles.Count == 0) continue;
                var drafts = t.Titles.Where(x => !CatalogText.IsSlopTitle(x.Title)).Take(WorksPerSource).Select(x =>
                {
                    var key = CatalogText.CatalogWorkKey(x.Title, x.Year, x.MediaType);
                    return index.Match(key, x.Year) is { } hit ? CatalogText.DraftFromTmdb(x, key, hit.PeakSeeders, hit.BestRelease) : CatalogText.DraftFromTmdb(x, key);
                }).ToList();
                prepared.Add((t.Source, drafts));
                origin[t.Source] = "tmdb";
            }
            var missing = CatalogText.Feeds.Select(f => f.Source).Distinct().Where(s => prepared.All(p => p.Source != s)).ToList();
            var fallbacks = await Task.WhenAll(missing.Select(async source =>
            {
                var items = answered.Where(c => c.Feed.Source == source).SelectMany(c => c.Releases.Select(r => (r, c.Feed.MediaType))).ToList();
                if (items.Count == 0) return ((string, List<CatalogDraft>)?)null;
                var works = CatalogText.CollapseToWorks(items).Take(WorksPerSource).ToList();
                var art = await AttachArtworkAsync(works).ConfigureAwait(false);
                var details = await ResolveDetailBoundedAsync(works).ConfigureAwait(false);
                return (source, works.Select((w, i) => CatalogText.DraftFromWork(w, art[i].PosterUrl, art[i].BackdropUrl, details[i])).ToList());
            })).ConfigureAwait(false);
            foreach (var fallback in fallbacks.OfType<(string Source, List<CatalogDraft> Drafts)>())
            {
                prepared.Add(fallback);
                origin[fallback.Source] = "charts";
            }
            if (prepared.Count == 0) return new(written, errors, true, origin, (long)time.GetElapsedTime(started).TotalMilliseconds);
            foreach (var (source, drafts) in prepared)
                written[source] = await ReplaceSourceAsync(source, null, drafts, CancellationToken.None).ConfigureAwait(false);
            return new(written, errors, false, origin, (long)time.GetElapsedTime(started).TotalMilliseconds);
        }
        catch (Exception e)
        {
            logger.LogError(e, "[catalog] refresh failed");
            errors.Add(e.Message);
            return new(written, errors, true, origin, (long)time.GetElapsedTime(started).TotalMilliseconds);
        }
    }

    public const int ArtworkBudgetMs = 15_000;
    public const int DetailBudgetMs = 20_000;
    private const int DetailConcurrency = 4;

    /// <summary>artwork.ts resolveArtworkBounded: chart works get posters within a 15 s budget; a miss or hang costs artwork only.</summary>
    private async Task<IReadOnlyList<ArtworkResult>> AttachArtworkAsync(List<ChartWork> works)
    {
        var none = works.Select(_ => ArtworkResult.None).ToList();
        if (artwork is null || works.Count == 0) return none;
        var batch = artwork.ResolveBatchAsync(works.Select(w => new ArtworkQuery(w.Title, w.Year, MediaTypes.Normalize(w.MediaType))).ToList());
        if (await Task.WhenAny(batch, Task.Delay(TimeSpan.FromMilliseconds(ArtworkBudgetMs), time)).ConfigureAwait(false) != batch || !batch.IsCompletedSuccessfully)
            return none;
        return works.Select((_, i) => i < batch.Result.Count ? batch.Result[i] : ArtworkResult.None).ToList();
    }

    /// <summary>
    /// detail.ts resolveDetailBounded over work-detail.ts's TMDB tier: overview / rating / release date from the same
    /// TMDB match that chose the poster, within a 20 s budget. Never throws.
    /// </summary>
    private async Task<IReadOnlyList<CatalogDetail?>> ResolveDetailBoundedAsync(List<ChartWork> works)
    {
        var none = new CatalogDetail?[works.Count];
        if (artwork is null || works.Count == 0 || !tmdb.HasKey) return none;
        var output = new CatalogDetail?[works.Count];
        var run = Parallel.ForEachAsync(Enumerable.Range(0, works.Count), new ParallelOptions { MaxDegreeOfParallelism = DetailConcurrency }, async (i, _) =>
        {
            try
            {
                var w = works[i];
                if (await artwork.ResolveTmdbRefAsync(new ArtworkQuery(w.Title, w.Year, MediaTypes.Normalize(w.MediaType))).ConfigureAwait(false) is not { } reference) return;
                if (await tmdb.FetchDetailAsync(reference.MediaType, reference.Id).ConfigureAwait(false) is not { } d) return;
                var title = (TmdbClient.Str(d, "title") ?? TmdbClient.Str(d, "name") ?? "").Trim();
                if (title.Length == 0) return;
                var overview = TmdbClient.Str(d, "overview")?.Trim();
                double? rating = TmdbClient.Num(d, "vote_average") is > 0 and var v ? v : null;
                var date = TmdbClient.Str(d, "release_date").OrEmpty(TmdbClient.Str(d, "first_air_date"))?.Trim();
                output[i] = new CatalogDetail(string.IsNullOrEmpty(overview) ? null : overview, rating, string.IsNullOrEmpty(date) ? null : date);
            }
            catch (Exception e) when (e is not OutOfMemoryException) { }
        });
        if (await Task.WhenAny(run, Task.Delay(TimeSpan.FromMilliseconds(DetailBudgetMs), time)).ConfigureAwait(false) != run) return none;
        return output;
    }

    /// <summary>store.ts replaceCatalogSource: upsert ranked rows then drop the rest of the partition.</summary>
    public async Task<int> ReplaceSourceAsync(string source, string? seedTitle, IReadOnlyList<CatalogDraft> drafts, CancellationToken ct)
    {
        var unique = CatalogText.DedupeByWorkKey(drafts);
        var now = time.GetUtcNow().UtcDateTime;
        await using var db = await dbFactory.CreateDbContextAsync(ct).ConfigureAwait(false);
        var ids = unique.Select(d => CatalogText.CatalogEntryId(source, seedTitle, d.WorkKey)).ToList();
        var existing = await db.CatalogEntries.Where(e => ids.Contains(e.Id)).ToDictionaryAsync(e => e.Id, ct).ConfigureAwait(false);
        for (var i = 0; i < unique.Count; i++)
        {
            var d = unique[i];
            if (!existing.TryGetValue(ids[i], out var row))
            {
                row = new CatalogEntry { Id = ids[i], CreatedAt = now };
                db.CatalogEntries.Add(row);
            }
            row.WorkKey = d.WorkKey; row.Title = d.Title; row.Year = d.Year; row.MediaType = d.MediaType;
            row.PosterUrl = d.PosterUrl; row.BackdropUrl = d.BackdropUrl; row.Overview = d.Overview; row.Rating = d.Rating;
            row.Source = source; row.Rank = i; row.SeedTitle = seedTitle; row.Seeders = d.Seeders; row.BestRelease = d.BestRelease;
            row.ReleaseDate = d.ReleaseDate; row.RefreshedAt = now;
        }
        var stale = await db.CatalogEntries.Where(e => e.Source == source && e.SeedTitle == seedTitle && !ids.Contains(e.Id)).ToListAsync(ct).ConfigureAwait(false);
        db.CatalogEntries.RemoveRange(stale);
        await db.SaveChangesAsync(ct).ConfigureAwait(false);
        return unique.Count;
    }

    private sealed record FeedResult(CatalogFeed Feed, List<FeedRelease> Releases, string? Error);

    private async Task<FeedResult> FetchFeedAsync(CatalogFeed feed)
    {
        try
        {
            using var cts = new CancellationTokenSource(FeedTimeoutMs);
            using var req = new HttpRequestMessage(HttpMethod.Get, $"{options.Value.ApibayBaseUrl.TrimEnd('/')}/precompiled/data_top100_{feed.Category}.json");
            req.Headers.TryAddWithoutValidation("User-Agent", BrowserUserAgent);
            req.Headers.TryAddWithoutValidation("Accept", "application/json, text/plain, */*");
            using var res = await httpFactory.CreateClient(TmdbClient.HttpClientName).SendAsync(req, cts.Token).ConfigureAwait(false);
            if (!res.IsSuccessStatusCode) return new(feed, [], $"apibay HTTP {(int)res.StatusCode}");
            var data = await res.Content.ReadFromJsonAsync<JsonElement>(cts.Token).ConfigureAwait(false);
            return data.ValueKind != JsonValueKind.Array ? new(feed, [], "apibay returned a non-list body") : new(feed, CatalogText.ParseFeedBody(data), null);
        }
        catch (Exception e)
        {
            return new(feed, [], e is OperationCanceledException ? "The operation was aborted due to timeout" : e.Message);
        }
    }

    private sealed record TrendingResult(string Kind, string Source, List<CatalogTitle> Titles, string? Error);

    private async Task<TrendingResult> FetchTrendingAsync(string kind, string source)
    {
        if (tmdb.ApiKey is null) return new(kind, source, [], "TMDB_API_KEY is not set");
        var titles = new List<CatalogTitle>();
        string? error = null;
        var pages = await Task.WhenAll(Enumerable.Range(1, TmdbPages).Select(p =>
            tmdb.TryGetAsync($"/trending/{kind}/week", [("page", p.ToString(CultureInfo.InvariantCulture))], TmdbTimeoutMs))).ConfigureAwait(false);
        var seen = new HashSet<int>();
        foreach (var page in pages)
        {
            if (page is null) { error ??= "TMDB request failed"; continue; }
            titles.AddRange(CatalogText.ParseTmdbList(page.Value, kind, options.Value.TmdbImageBaseUrl).Where(t => seen.Add(t.TmdbId)));
        }
        return new(kind, source, titles, titles.Count > 0 ? null : error);
    }

    /// <summary>
    /// refresh.ts refreshRelatedForSeed: TMDB recommendations for the seed (bounded by RelatedBudgetMs), else the
    /// seed's same-type neighbours in the chart pool. Single-flight per title + media type; drops other seeds' rows.
    /// </summary>
    public Task<int> RefreshRelatedForSeedAsync(string seedTitle, string? mediaType)
    {
        var title = seedTitle.Trim();
        if (title.Length == 0) return Task.FromResult(0);
        var normalized = MediaTypes.Normalize(mediaType);
        var key = $"{title}\0{normalized ?? ""}";
        lock (_gate)
        {
            if (_relatedInFlight.TryGetValue(key, out var existing)) return existing;
            var task = Task.Run(() => RunRelatedAsync(title, normalized));
            _relatedInFlight[key] = task;
            _ = task.ContinueWith(_ => { lock (_gate) _relatedInFlight.Remove(key); }, TaskScheduler.Default);
            return task;
        }
    }

    private async Task<int> RunRelatedAsync(string title, string? mediaType)
    {
        try
        {
            var trending = await ReadRowsAsync("trending", null, WorksPerSource).ConfigureAwait(false);
            var popular = await ReadRowsAsync("popular", null, WorksPerSource).ConfigureAwait(false);
            var pool = trending.Concat(popular).ToList();
            var onScreen = trending.Take(RailHead).Concat(popular.Take(RailHead)).Select(r => r.WorkKey).ToHashSet(StringComparer.Ordinal);

            var tmdbTask = RelatedFromTmdbAsync(mediaType, title, pool, onScreen);
            List<CatalogDraft>? drafts = null;
            if (await Task.WhenAny(tmdbTask, Task.Delay(TimeSpan.FromMilliseconds(RelatedBudgetMs), time)).ConfigureAwait(false) == tmdbTask
                && tmdbTask.IsCompletedSuccessfully)
                drafts = tmdbTask.Result;
            if (drafts is null || drafts.Count == 0)
            {
                if (pool.Count == 0) return 0;
                drafts = CatalogText.PickRelated(pool, title, mediaType, RailHead, onScreen).Select(CatalogText.DraftFromRow).ToList();
            }

            await ReplaceSourceAsync("related", title, drafts, CancellationToken.None).ConfigureAwait(false);
            await using var db = await dbFactory.CreateDbContextAsync().ConfigureAwait(false);
            await db.CatalogEntries.Where(e => e.Source == "related" && e.SeedTitle != null && e.SeedTitle != "" && e.SeedTitle != title)
                .ExecuteDeleteAsync().ConfigureAwait(false);
            return drafts.Count;
        }
        catch (Exception e)
        {
            logger.LogWarning(e, "[catalog] related rebuild failed for {Seed}", title);
            return 0;
        }
    }

    /// <summary>refresh.ts relatedFromTmdb: null when TMDB cannot answer, so the caller falls back to the pool.</summary>
    private async Task<List<CatalogDraft>?> RelatedFromTmdbAsync(string? mediaType, string title, IReadOnlyList<CatalogEntry> pool, IReadOnlySet<string> onScreen)
    {
        if (tmdb.ApiKey is null) return null;
        string[] kinds = mediaType is null ? ["movie", "tv"] : [MediaTypes.IsSeries(mediaType) ? "tv" : "movie"];
        var searches = await Task.WhenAll(kinds.Select(async kind =>
        {
            var body = await tmdb.TryGetAsync($"/search/{kind}", [("query", title), ("include_adult", "false")], TmdbReadTimeoutMs).ConfigureAwait(false);
            return body is { } b ? CatalogText.ParseTmdbList(b, kind, options.Value.TmdbImageBaseUrl).FirstOrDefault() : null;
        })).ConfigureAwait(false);
        if (searches.FirstOrDefault(s => s is not null) is not { } found) return null;

        var recommendations = await tmdb.TryGetAsync($"/{found.Kind}/{found.TmdbId}/recommendations", [], TmdbReadTimeoutMs).ConfigureAwait(false);
        if (recommendations is not { } rec) return null;
        var titles = CatalogText.ParseTmdbList(rec, found.Kind, options.Value.TmdbImageBaseUrl);
        if (titles.Count == 0) return null;

        var known = new Dictionary<string, CatalogEntry>(StringComparer.Ordinal);
        foreach (var row in pool) known[row.WorkKey] = row;
        var seedKeys = CatalogText.SeedWorkKeys(title);
        var seedTitle = title.ToLowerInvariant();
        var drafts = new List<CatalogDraft>();
        foreach (var candidate in titles)
        {
            if (CatalogText.IsSlopTitle(candidate.Title)) continue;
            var workKey = CatalogText.CatalogWorkKey(candidate.Title, candidate.Year, candidate.MediaType);
            if (workKey.Length == 0 || seedKeys.Contains(workKey) || candidate.Title.Trim().ToLowerInvariant() == seedTitle) continue;
            drafts.Add(known.TryGetValue(workKey, out var row) && !string.IsNullOrEmpty(row.BestRelease)
                ? CatalogText.DraftFromTmdb(candidate, workKey, row.Seeders, row.BestRelease)
                : CatalogText.DraftFromTmdb(candidate, workKey));
        }
        return drafts.Where(d => !onScreen.Contains(d.WorkKey)).Concat(drafts.Where(d => onScreen.Contains(d.WorkKey))).Take(RailHead).ToList();
    }
}

/// <summary>refresh.ts armCatalogTimer: hourly refresh independent of traffic; CATALOG_TIMER=0 (or off/false) disables it.</summary>
public sealed class CatalogRefreshWorker(CatalogService catalog, IOptions<MetadataOptions> options, TimeProvider time) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (options.Value.CatalogTimer?.Trim().ToLowerInvariant() is "0" or "off" or "false") return;
        using var timer = new PeriodicTimer(CatalogService.CatalogTtl, time);
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken).ConfigureAwait(false))
                await catalog.RefreshAsync().ConfigureAwait(false);
        }
        catch (OperationCanceledException) { }
    }
}



