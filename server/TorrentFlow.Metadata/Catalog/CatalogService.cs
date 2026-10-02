using TorrentFlow.Core;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Core.Text;
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

/// <summary>
/// A row to be written into CatalogEntry. <paramref name="RatingSource"/> names the provider that supplied the rating;
/// <paramref name="Provider"/> and <paramref name="ProviderId"/> name the title itself, so a card can be requested.
/// </summary>
public sealed record CatalogDraft(string WorkKey, string Title, int? Year, string MediaType, string? PosterUrl, string? BackdropUrl,
    string? Overview, double? Rating, int Seeders, string? BestRelease, DateTime? ReleaseDate, string? RatingSource = null,
    string? Provider = null, string? ProviderId = null);

/// <summary>Pure catalog helpers ported from src/lib/catalog/{tmdb,feeds,availability,store}.ts and src/lib/metadata/slop.ts.</summary>
public static partial class CatalogText
{
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
    public static List<CatalogTitle> ParseTmdbList(JsonElement data, string kind, string imageBase)
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
                Artwork.TmdbImages.Url(imageBase, TmdbClient.Str(row, "poster_path"), Artwork.ArtRole.Poster), Artwork.TmdbImages.Url(imageBase, TmdbClient.Str(row, "backdrop_path"), Artwork.ArtRole.Backdrop),
                FirstString(TmdbClient.Str(row, "overview")), ParseRating(row, "vote_average"), ParseReleaseDate(date)));
        }
        return output;
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
        new(row.WorkKey, row.Title, row.Year, row.MediaType, row.PosterUrl, row.BackdropUrl, row.Overview, row.Rating, row.Seeders, row.BestRelease, row.ReleaseDate,
            row.RatingSource, row.Provider, row.ProviderId);

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
            t.ReleaseDate is { } d ? DateTime.SpecifyKind(DateTime.ParseExact(d, "yyyy-MM-dd", CultureInfo.InvariantCulture), DateTimeKind.Utc) : null,
            t.Rating is null ? null : "tmdb", "tmdb", t.TmdbId.ToString(CultureInfo.InvariantCulture));

    /// <summary>A keyless provider's title (Cinemeta, AniList) as a catalog row; the provider and its id name the title.</summary>
    public static CatalogDraft DraftFromMetadata(MediaMetadata m, string? mediaType = null)
    {
        var type = mediaType ?? m.MediaType;
        return new(CatalogWorkKey(m.Title, m.Year, type), m.Title, m.Year, type, m.PosterUrl, m.BackdropUrl, m.Synopsis, m.Rating, 0, null,
            ReleaseDateToDate(m.ReleaseDate), m.Rating is null ? null : m.Source, m.Source, m.ExternalId);
    }
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

    /// <summary>media-type.ts isSeriesMediaType, for a row with no format: <see cref="WorkKinds.IsSeries"/>.</summary>
    public static bool IsSeries(string? raw) => WorkKinds.IsSeries(null, Normalize(raw));
}

/// <summary>
/// Catalog store + refresh. Home rails are partitions named by rail id (see <see cref="HomeRails"/>), refreshed at most
/// once a local day from their provider feeds; reads are one indexed query and a refresh never empties a rail on outage.
/// </summary>
public sealed class CatalogService(
    IDbContextFactory<TorrentFlowDbContext> dbFactory,
    TmdbClient tmdb,
    IOptions<MetadataOptions> options,
    TimeProvider time,
    ILogger<CatalogService> logger,
    IHostApplicationLifetime? hostLifetime = null, CinemetaClient? cinemeta = null, AniListClient? anilist = null) : ICatalogLookup
{
    /// <summary>The worker's tick. Each tick refreshes only rails whose rows are from an earlier local day.</summary>
    public static readonly TimeSpan HomeRefreshTick = TimeSpan.FromHours(1);
    public const int ColdStartBudgetMs = 12_000;
    public const int RelatedBudgetMs = 4_000;
    public const int WorksPerSource = 48;
    public const int RailHead = 24;
    public const int TmdbTimeoutMs = 8_000;
    public const int TmdbReadTimeoutMs = 3_500;
    /// <summary>
    /// Titles stored per home rail. A rail shows 24 and a genre page 48; the rest is depth, so a genre rail that shares
    /// most of its titles with the rails above it still fills after de-duplication.
    /// </summary>
    public const int HomeRailRows = 96;
    /// <summary>A feed that answers with fewer titles than this has not answered.</summary>
    public const int HomeMinRows = 6;
    private const int HomeFetchConcurrency = 4;
    private const int TmdbHomePages = 5;
    private const int FeedPages = 2;
    private const int FeedPageSize = 50;
    private static readonly TimeSpan HomeRetryAfter = TimeSpan.FromMinutes(30);
    private static readonly string[] LegacySources = ["trending", "popular"];

    public const string BrowserUserAgent =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

    private readonly TorrentFlow.Metadata.Caching.SingleFlight<int> _relatedInFlight = new();
    private readonly TorrentFlow.Metadata.Caching.SingleFlight<bool> _homeInFlight = new(256);
    private readonly SemaphoreSlim _homeFetchSlots = new(HomeFetchConcurrency);
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, DateTimeOffset> _homeAttempts = new(StringComparer.Ordinal);
    private int _legacyCleared;
    private CancellationToken StoppingToken => hostLifetime?.ApplicationStopping ?? CancellationToken.None;

    /// <summary>
    /// The catalog row for a work: an exact identity key ("film:dune:2021"), else the newest row whose title and year
    /// a title route key ("dune-2021") names (TS findCatalogByComputedKey).
    /// </summary>
    public async Task<CatalogWork?> FindByWorkKeyAsync(string workKey, CancellationToken ct = default)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct).ConfigureAwait(false);
        var rows = await WorkPosters.FindCatalogAsync(db, [workKey], ct).ConfigureAwait(false);
        return rows.TryGetValue(workKey, out var row) ? ToWork(row) : null;
    }

    public static CatalogWork ToWork(CatalogEntry e) =>
        new(e.Id, e.WorkKey, e.Title, e.Year, e.MediaType, e.PosterUrl, e.BackdropUrl, e.Overview, e.Rating, e.Source, e.Rank,
            e.ReleaseDate?.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), e.WorkId, e.RatingSource, e.Provider, e.ProviderId);

    public async Task<List<CatalogEntry>> ReadRowsAsync(string source, string? seedTitle, int limit, CancellationToken ct = default)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct).ConfigureAwait(false);
        return await db.CatalogEntries.AsNoTracking()
            .Where(e => e.Source == source && e.SeedTitle == seedTitle)
            .OrderBy(e => e.Rank).ThenBy(e => e.Title)
            .Take(limit).ToListAsync(ct).ConfigureAwait(false);
    }

    // ------------------------------------------------------------------ home rails

    /// <summary>The first <paramref name="perRail"/> rows of each home rail, in rank order, in one query.</summary>
    public async Task<Dictionary<string, List<CatalogEntry>>> ReadHomeRowsAsync(IReadOnlyCollection<string> railIds, int perRail, CancellationToken ct = default)
    {
        var ids = railIds.ToList();
        await using var db = await dbFactory.CreateDbContextAsync(ct).ConfigureAwait(false);
        var rows = await db.CatalogEntries.AsNoTracking()
            .Where(e => ids.Contains(e.Source) && e.SeedTitle == null && e.Rank < perRail)
            .ToListAsync(ct).ConfigureAwait(false);
        return rows.GroupBy(r => r.Source, StringComparer.Ordinal)
            .ToDictionary(g => g.Key, g => g.OrderBy(r => r.Rank).ThenBy(r => r.Title).ToList(), StringComparer.Ordinal);
    }

    /// <summary>When each rail was last written and by which provider, read from its first row.</summary>
    public sealed record HomeRailState(DateTime RefreshedAt, string? Provider);

    public async Task<Dictionary<string, HomeRailState>> ReadHomeRailStatesAsync(IEnumerable<string> railIds, CancellationToken ct = default)
    {
        var ids = railIds.ToList();
        await using var db = await dbFactory.CreateDbContextAsync(ct).ConfigureAwait(false);
        var heads = await db.CatalogEntries.AsNoTracking()
            .Where(e => ids.Contains(e.Source) && e.SeedTitle == null && e.Rank == 0)
            .Select(e => new { e.Source, e.RefreshedAt, e.Provider }).ToListAsync(ct).ConfigureAwait(false);
        return heads.GroupBy(h => h.Source, StringComparer.Ordinal)
            .ToDictionary(g => g.Key, g => new HomeRailState(g.First().RefreshedAt, g.First().Provider), StringComparer.Ordinal);
    }

    /// <summary>
    /// The rails a view shows. A rail with no rows yet (first run, or a view never opened) is fetched while the request
    /// waits, up to <see cref="ColdStartBudgetMs"/>; a rail that has rows refreshes behind the request when stale, so a
    /// view never waits for a daily refresh. A rail in its retry back-off is not waited for. Never throws.
    /// </summary>
    public async Task EnsureHomeRailsAsync(IReadOnlyList<HomeRail> rails, CancellationToken ct = default)
    {
        Dictionary<string, HomeRailState> states;
        try { states = await ReadHomeRailStatesAsync(rails.Select(r => r.Id), ct).ConfigureAwait(false); }
        catch (Exception e) when (e is not OperationCanceledException) { logger.LogWarning(e, "[home] rail state unreadable"); return; }
        _ = RefreshHomeRailsAsync([.. rails.Where(r => states.ContainsKey(r.Id))], states);
        var firstFill = RefreshHomeRailsAsync([.. rails.Where(r => !states.ContainsKey(r.Id))], states);
        if (firstFill.IsCompleted) return;
        try { await firstFill.WaitAsync(TimeSpan.FromMilliseconds(ColdStartBudgetMs), time, ct).ConfigureAwait(false); }
        catch (TimeoutException) { logger.LogDebug("[home] rail refresh continues beyond the cold-start budget"); }
    }

    /// <summary>The worker's pass: every rail of every view whose rows are from an earlier day.</summary>
    public async Task RefreshStaleHomeRailsAsync(CancellationToken ct = default)
    {
        try
        {
            var states = await ReadHomeRailStatesAsync(HomeRails.Every.Select(r => r.Id), ct).ConfigureAwait(false);
            await RefreshHomeRailsAsync(HomeRails.Every, states).WaitAsync(ct).ConfigureAwait(false);
        }
        catch (Exception e) when (e is not OperationCanceledException) { logger.LogWarning(e, "[home] scheduled rail refresh failed"); }
    }

    private Task RefreshHomeRailsAsync(IReadOnlyList<HomeRail> rails, IReadOnlyDictionary<string, HomeRailState> states)
    {
        ClearLegacyPartitions();
        var now = time.GetUtcNow();
        var due = rails.Where(r => IsHomeRailStale(r, states.GetValueOrDefault(r.Id), now)
            && !(_homeAttempts.TryGetValue(r.Id, out var at) && now - at < HomeRetryAfter)).ToList();
        if (due.Count == 0) return Task.CompletedTask;
        return Task.WhenAll(due.Select(r => _homeInFlight.RunAsync(r.Id, () => RefreshHomeRailAsync(r, states.GetValueOrDefault(r.Id)))));
    }

    /// <summary>
    /// Stale when the rail has no rows, its rows are from an earlier local day, or they came from a provider other than the
    /// one it prefers now (a TMDB key was added or removed). Within a day the rail does not change.
    /// </summary>
    private bool IsHomeRailStale(HomeRail rail, HomeRailState? state, DateTimeOffset now)
    {
        if (state is null) return true;
        if (LocalDay(new DateTimeOffset(DateTime.SpecifyKind(state.RefreshedAt, DateTimeKind.Utc))) < LocalDay(now)) return true;
        return rail.Feeds.FirstOrDefault(IsUsable)?.Provider is { } preferred && state.Provider != preferred;
    }

    private DateOnly LocalDay(DateTimeOffset at) => DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(at, time.LocalTimeZone).DateTime);

    private bool IsUsable(HomeFeed feed) => feed switch
    {
        TmdbHomeFeed => tmdb.ApiKey is not null,
        CinemetaHomeFeed => cinemeta is not null,
        AniListHomeFeed => anilist is not null,
        _ => false,
    };

    /// <summary>
    /// Fills one rail from its first usable feed. A rail is written only when a feed answered; when the first feed fails and
    /// the rail already holds rows from a provider still usable, those rows stay (no silent provider flip). The next feed is
    /// tried only when the rail has no rows or its provider is no longer usable.
    /// </summary>
    private async Task<bool> RefreshHomeRailAsync(HomeRail rail, HomeRailState? state)
    {
        var ct = StoppingToken;
        _homeAttempts[rail.Id] = time.GetUtcNow();
        try
        {
            var usable = rail.Feeds.Where(IsUsable).ToList();
            var keepExisting = state?.Provider is { } existing && usable.Any(f => f.Provider == existing);
            foreach (var feed in usable)
            {
                var drafts = await FetchHomeFeedAsync(feed, ct).ConfigureAwait(false);
                if (drafts.Count >= HomeMinRows)
                {
                    await ReplaceSourceAsync(rail.Id, null, drafts, ct).ConfigureAwait(false);
                    return true;
                }
                logger.LogInformation("[home] {Rail}: {Provider} answered {Count} titles", rail.Id, feed.Provider, drafts.Count);
                if (keepExisting) return false;
            }
            return false;
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            logger.LogWarning(e, "[home] refresh failed for {Rail}", rail.Id);
            return false;
        }
    }

    private async Task<List<CatalogDraft>> FetchHomeFeedAsync(HomeFeed feed, CancellationToken ct)
    {
        await _homeFetchSlots.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var today = LocalDay(time.GetUtcNow());
            IEnumerable<CatalogDraft> drafts = feed switch
            {
                TmdbHomeFeed t => await FetchTmdbHomeAsync(t, today, ct).ConfigureAwait(false),
                CinemetaHomeFeed c when cinemeta is not null => await FetchPagesAsync(p =>
                    cinemeta.CatalogAsync(c.Kind, c.Catalog, c.Genre?.Replace("{year}", today.Year.ToString(CultureInfo.InvariantCulture), StringComparison.Ordinal),
                        FeedPageSize, ct, skip: p * FeedPageSize), m => CatalogText.DraftFromMetadata(m)).ConfigureAwait(false),
                AniListHomeFeed a when anilist is not null => await FetchPagesAsync(p =>
                    anilist.BrowseAsync(a.Sort, a.ThisSeason ? HomeRails.AniListSeason(today) : null, a.ThisSeason ? today.Year : null, a.Genre,
                        FeedPageSize, ct, page: p + 1), w => CatalogText.DraftFromMetadata(w.Metadata, w.IsSeries ? "anime" : "movie")).ConfigureAwait(false),
                _ => [],
            };
            return [.. drafts.Where(d => d.WorkKey.Length > 0 && !CatalogText.IsSlopTitle(d.Title)).Take(HomeRailRows)];
        }
        finally { _homeFetchSlots.Release(); }
    }

    /// <summary>Cinemeta and AniList pages of 50, fetched together. A second page counts only behind a first one.</summary>
    private static async Task<IEnumerable<CatalogDraft>> FetchPagesAsync<T>(Func<int, Task<List<T>>> page, Func<T, CatalogDraft> draft)
    {
        var pages = await Task.WhenAll(Enumerable.Range(0, FeedPages).Select(page)).ConfigureAwait(false);
        return pages[0].Count == 0 ? [] : pages.SelectMany(p => p).Select(draft);
    }

    private async Task<IEnumerable<CatalogDraft>> FetchTmdbHomeAsync(TmdbHomeFeed feed, DateOnly today, CancellationToken ct)
    {
        var kind = feed.Path.Contains("/tv", StringComparison.Ordinal) ? "tv" : "movie";
        var query = HomeRails.TmdbQuery(feed.Query, today);
        var pages = await Task.WhenAll(Enumerable.Range(1, TmdbHomePages).Select(p =>
            tmdb.TryGetAsync(feed.Path, [.. query, ("page", p.ToString(CultureInfo.InvariantCulture))], TmdbTimeoutMs, ct))).ConfigureAwait(false);
        var seen = new HashSet<int>();
        return pages.Where(p => p is not null)
            .SelectMany(p => CatalogText.ParseTmdbList(p!.Value, kind, options.Value.TmdbImageBaseUrl))
            .Where(t => seen.Add(t.TmdbId))
            .Select(t => CatalogText.DraftFromTmdb(t, CatalogText.CatalogWorkKey(t.Title, t.Year, t.MediaType)))
            .ToList();
    }

    /// <summary>The hourly trending / popular partitions the rails replace. Dropped once so nothing reads them again.</summary>
    private void ClearLegacyPartitions()
    {
        if (Interlocked.Exchange(ref _legacyCleared, 1) == 1) return;
        _ = Task.Run(async () =>
        {
            try
            {
                await using var db = await dbFactory.CreateDbContextAsync(StoppingToken).ConfigureAwait(false);
                await db.CatalogEntries.Where(e => LegacySources.Contains(e.Source) && e.SeedTitle == null).ExecuteDeleteAsync(StoppingToken).ConfigureAwait(false);
            }
            catch (Exception e) { logger.LogDebug(e, "[home] legacy catalog rows not cleared"); }
        });
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
            row.PosterUrl = d.PosterUrl; row.BackdropUrl = d.BackdropUrl; row.Overview = d.Overview; row.Rating = d.Rating; row.RatingSource = d.RatingSource;
            row.Provider = d.Provider; row.ProviderId = d.ProviderId;
            row.Source = source; row.Rank = i; row.SeedTitle = seedTitle; row.Seeders = d.Seeders; row.BestRelease = d.BestRelease;
            row.ReleaseDate = d.ReleaseDate; row.RefreshedAt = now;
        }
        var stale = await db.CatalogEntries.Where(e => e.Source == source && e.SeedTitle == seedTitle && !ids.Contains(e.Id)).ToListAsync(ct).ConfigureAwait(false);
        db.CatalogEntries.RemoveRange(stale);
        await db.SaveChangesAsync(ct).ConfigureAwait(false);
        return unique.Count;
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
        return _relatedInFlight.RunAsync($"{title}\0{normalized ?? ""}", () => RunRelatedAsync(title, normalized));
    }

    private async Task<int> RunRelatedAsync(string title, string? mediaType)
    {
        try
        {
            var ct = StoppingToken;
            var rails = await ReadHomeRowsAsync(HomeRails.RelatedPool, WorksPerSource, ct).ConfigureAwait(false);
            var lists = HomeRails.RelatedPool.Select(id => rails.GetValueOrDefault(id) ?? []).ToList();
            var pool = lists.SelectMany(rows => rows).ToList();
            var onScreen = lists.SelectMany(rows => rows.Take(RailHead)).Select(r => r.WorkKey).ToHashSet(StringComparer.Ordinal);

            List<CatalogDraft>? drafts = null;
            using (var timeout = new CancellationTokenSource(TimeSpan.FromMilliseconds(RelatedBudgetMs), time))
            using (var linked = CancellationTokenSource.CreateLinkedTokenSource(timeout.Token, ct))
            {
                try { drafts = await RelatedFromTmdbAsync(mediaType, title, pool, onScreen, linked.Token).ConfigureAwait(false); }
                catch (OperationCanceledException) when (!ct.IsCancellationRequested) { logger.LogDebug("[catalog] TMDB related exceeded its budget for {Seed}", title); }
            }
            if (drafts is null || drafts.Count == 0)
            {
                if (pool.Count == 0) return 0;
                drafts = CatalogText.PickRelated(pool, title, mediaType, RailHead, onScreen).Select(CatalogText.DraftFromRow).ToList();
            }

            await ReplaceSourceAsync("related", title, drafts, ct).ConfigureAwait(false);
            await using var db = await dbFactory.CreateDbContextAsync(ct).ConfigureAwait(false);
            await db.CatalogEntries.Where(e => e.Source == "related" && e.SeedTitle != null && e.SeedTitle != "" && e.SeedTitle != title)
                .ExecuteDeleteAsync(ct).ConfigureAwait(false);
            return drafts.Count;
        }
        catch (Exception e)
        {
            logger.LogWarning(e, "[catalog] related rebuild failed for {Seed}", title);
            return 0;
        }
    }

    /// <summary>refresh.ts relatedFromTmdb: null when TMDB cannot answer, so the caller falls back to the pool.</summary>
    private async Task<List<CatalogDraft>?> RelatedFromTmdbAsync(string? mediaType, string title, IReadOnlyList<CatalogEntry> pool, IReadOnlySet<string> onScreen,
        CancellationToken ct)
    {
        if (tmdb.ApiKey is null) return null;
        string[] kinds = mediaType is null ? ["movie", "tv"] : [MediaTypes.IsSeries(mediaType) ? "tv" : "movie"];
        var searches = await Task.WhenAll(kinds.Select(async kind =>
        {
            var body = await tmdb.TryGetAsync($"/search/{kind}", [("query", title), ("include_adult", "false")], TmdbReadTimeoutMs, ct).ConfigureAwait(false);
            return body is { } b ? CatalogText.ParseTmdbList(b, kind, options.Value.TmdbImageBaseUrl).FirstOrDefault() : null;
        })).ConfigureAwait(false);
        if (searches.FirstOrDefault(s => s is not null) is not { } found) return null;

        var recommendations = await tmdb.TryGetAsync($"/{found.Kind}/{found.TmdbId}/recommendations", [], TmdbReadTimeoutMs, ct).ConfigureAwait(false);
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

/// <summary>
/// Hourly tick that refreshes home rails whose rows are from an earlier local day, so each rail changes at most once a
/// day and before anyone opens home. CATALOG_TIMER=0 (or off/false) disables it.
/// </summary>
public sealed class CatalogRefreshWorker(CatalogService catalog, IOptions<MetadataOptions> options, TimeProvider time) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (options.Value.CatalogTimer?.Trim().ToLowerInvariant() is "0" or "off" or "false") return;
        using var priority = ProviderPriority.Background();
        using var timer = new PeriodicTimer(CatalogService.HomeRefreshTick, time);
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken).ConfigureAwait(false))
                await catalog.RefreshStaleHomeRailsAsync(stoppingToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) { }
    }
}
