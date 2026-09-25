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
using TorrentFlow.Metadata.Enrichment;
using TorrentFlow.Metadata.Providers;

namespace TorrentFlow.Metadata.Catalog;

/// <summary>One title from a TMDB chart (src/lib/catalog/tmdb.ts TmdbTitle).</summary>
public sealed record CatalogTitle(int TmdbId, string Kind, string Title, int? Year, string MediaType, string? PosterUrl,
    string? BackdropUrl, string? Overview, double? Rating, string? ReleaseDate);

/// <summary>One release from an apibay precompiled top-100 feed.</summary>
public sealed record FeedRelease(string Name, int Seeders, int Leechers, string? InfoHash, long? SizeBytes);

public sealed record CatalogFeed(string Id, int Category, string Label, string MediaType, string Source);

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
    [GeneratedRegex(@"\bS\d{1,3}(?:E\d{1,4})?\b|\b\d{1,2}x\d{2,3}\b|\bSeason\s*\d+|\bComplete\s+Series\b", RegexOptions.IgnoreCase)] private static partial Regex SeriesMarker();
    [GeneratedRegex(@"(?<![\d.])((?:19|20)\d{2})(?![\d.])")] private static partial Regex YearToken();

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

    /// <summary>availability.ts catalogWorkKey: series keys carry no year; films key on name + year.</summary>
    public static string CatalogWorkKey(string title, int? year, string? mediaType)
    {
        var trimmed = title.Trim();
        if (trimmed.Length == 0) return "";
        var mt = MediaTypes.Normalize(mediaType);
        return mt is "tv" or "anime" ? $"series:{NormalizeForKey(trimmed)}" : $"film:{NormalizeForKey(trimmed)}:{year?.ToString(CultureInfo.InvariantCulture) ?? ""}";
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

    /// <summary>Simplified works.ts collapseToWorks: group chart releases by work, keep peak/total seeders and the healthiest release.</summary>
    public static List<CatalogDraft> CollapseToWorks(IEnumerable<(FeedRelease Release, string MediaType)> items)
    {
        var works = new Dictionary<string, (CatalogDraft Draft, int Total)>();
        var order = new List<string>();
        foreach (var (release, declared) in items)
        {
            var isSeries = SeriesMarker().IsMatch(release.Name);
            var cleaned = TitleCleaning.CleanTorrentTitle(release.Name);
            var year = isSeries ? null : ReleaseYear(release.Name);
            if (year is { } y && cleaned.IndexOf(y.ToString(CultureInfo.InvariantCulture), StringComparison.Ordinal) is var at and > 0)
                cleaned = cleaned[..at].Trim().TrimEnd('(', '[', '-', '.').Trim();
            if (IsSlopTitle(cleaned)) continue;
            var mediaType = isSeries ? (declared == "anime" ? "anime" : "tv") : declared == "tv" ? null : declared;
            if (mediaType is null) continue;
            var key = isSeries ? $"series:{NormalizeForKey(cleaned)}" : $"film:{NormalizeForKey(cleaned)}:{year?.ToString(CultureInfo.InvariantCulture) ?? ""}";
            var seeders = Math.Max(0, release.Seeders);
            if (!works.TryGetValue(key, out var existing))
            {
                works[key] = (new CatalogDraft(key, cleaned, year, mediaType, null, null, null, null, seeders, release.Name, null), seeders);
                order.Add(key);
                continue;
            }
            var draft = existing.Draft;
            if (seeders > draft.Seeders) draft = draft with { Seeders = seeders, BestRelease = release.Name };
            works[key] = (draft, existing.Total + seeders);
        }
        return order.Select(k => works[k]).OrderByDescending(w => w.Total).Select(w => w.Draft).ToList();
    }

    public static int? ReleaseYear(string title)
    {
        int? found = null;
        var ceiling = DateTime.UtcNow.Year + 1;
        foreach (Match m in YearToken().Matches(title.Replace('.', ' ').Replace('_', ' ')))
        {
            var y = int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture);
            if (y >= 1900 && y <= ceiling) found = y;
        }
        return found;
    }

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
        var count = await db.CatalogEntries.CountAsync(e => e.Source != "related", ct).ConfigureAwait(false);
        var newest = await db.CatalogEntries.Where(e => e.Source != "related").OrderByDescending(e => e.RefreshedAt)
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
            var chartWorks = CatalogText.CollapseToWorks(answered.SelectMany(c => c.Releases.Select(r => (r, c.Feed.MediaType))));
            var index = chartWorks.GroupBy(w => w.WorkKey).ToDictionary(g => g.Key, g => g.MaxBy(w => w.Seeders)!);

            var prepared = new List<(string Source, List<CatalogDraft> Drafts)>();
            foreach (var t in trending)
            {
                if (t.Titles.Count == 0) continue;
                var drafts = t.Titles.Where(x => !CatalogText.IsSlopTitle(x.Title)).Take(WorksPerSource).Select(x =>
                {
                    var key = CatalogText.CatalogWorkKey(x.Title, x.Year, x.MediaType);
                    return index.TryGetValue(key, out var hit) ? CatalogText.DraftFromTmdb(x, key, hit.Seeders, hit.BestRelease) : CatalogText.DraftFromTmdb(x, key);
                }).ToList();
                prepared.Add((t.Source, drafts));
                origin[t.Source] = "tmdb";
            }
            foreach (var source in CatalogText.Feeds.Select(f => f.Source).Distinct().Where(s => prepared.All(p => p.Source != s)))
            {
                var items = answered.Where(c => c.Feed.Source == source).SelectMany(c => c.Releases.Select(r => (r, c.Feed.MediaType))).ToList();
                if (items.Count == 0) continue;
                prepared.Add((source, await AttachArtworkAsync(CatalogText.CollapseToWorks(items).Take(WorksPerSource).ToList()).ConfigureAwait(false)));
                origin[source] = "charts";
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

    /// <summary>artwork.ts resolveArtworkBounded: chart works get posters within a 15 s budget; a miss or hang costs artwork only.</summary>
    private async Task<List<CatalogDraft>> AttachArtworkAsync(List<CatalogDraft> works)
    {
        if (artwork is null || works.Count == 0) return works;
        var batch = artwork.ResolveBatchAsync(works.Select(w => new ArtworkQuery(w.Title, w.Year, w.MediaType)).ToList());
        if (await Task.WhenAny(batch, Task.Delay(TimeSpan.FromMilliseconds(ArtworkBudgetMs), time)).ConfigureAwait(false) != batch || !batch.IsCompletedSuccessfully)
            return works;
        var art = batch.Result;
        return works.Select((w, i) => i < art.Count ? w with { PosterUrl = art[i].PosterUrl, BackdropUrl = art[i].BackdropUrl } : w).ToList();
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
    /// refresh.ts refreshRelatedForSeed (simplified): TMDB recommendations for the seed's best match, bounded by
    /// RelatedBudgetMs. Single-flight per seed.
    /// </summary>
    public Task<int> RefreshRelatedForSeedAsync(string seedTitle, string? mediaType)
    {
        lock (_gate)
        {
            if (_relatedInFlight.TryGetValue(seedTitle, out var existing)) return existing;
            var task = Task.Run(() => RunRelatedAsync(seedTitle, mediaType));
            _relatedInFlight[seedTitle] = task;
            _ = task.ContinueWith(_ => { lock (_gate) _relatedInFlight.Remove(seedTitle); }, TaskScheduler.Default);
            return task;
        }
    }

    private async Task<int> RunRelatedAsync(string seedTitle, string? mediaType)
    {
        try
        {
            if (tmdb.ApiKey is null) return 0;
            var scope = MediaTypes.Normalize(mediaType) switch { "movie" => "movie", "tv" or "anime" => "tv", _ => "multi" };
            var candidates = await tmdb.SearchCandidatesAsync(scope, seedTitle, null, 1, RelatedBudgetMs).ConfigureAwait(false);
            if (candidates.FirstOrDefault() is not { } top) return 0;
            var kind = top.MediaType == "movie" ? "movie" : "tv";
            var body = await tmdb.TryGetAsync($"/{kind}/{top.Id}/recommendations", [("language", "en-US"), ("page", "1")], RelatedBudgetMs).ConfigureAwait(false);
            if (body is null) return 0;
            var drafts = CatalogText.ParseTmdbList(body.Value, kind, options.Value.TmdbImageBaseUrl)
                .Where(t => !CatalogText.IsSlopTitle(t.Title)).Take(WorksPerSource)
                .Select(t => CatalogText.DraftFromTmdb(t, CatalogText.CatalogWorkKey(t.Title, t.Year, t.MediaType))).ToList();
            return drafts.Count == 0 ? 0 : await ReplaceSourceAsync("related", seedTitle, drafts, CancellationToken.None).ConfigureAwait(false);
        }
        catch (Exception e)
        {
            logger.LogWarning(e, "[catalog] related rebuild failed for {Seed}", seedTitle);
            return 0;
        }
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



