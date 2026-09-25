using System.Globalization;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Metadata.Catalog;

namespace TorrentFlow.Metadata.Browse;

/// <summary>src/lib/browse/types.ts RailItem: the always-present fields are serialized even when null.</summary>
public record RailItem
{
    public required string Id { get; init; }
    public required string Title { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? Subtitle { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? PosterUrl { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? BackdropUrl { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? Availability { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public double? ProgressFraction { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public double? ResumePositionSec { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? InfoHash { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? FilePath { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? WatchListItemId { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? MediaType { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public int? Season { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public int? Episode { get; init; }
}

/// <summary>discovery.ts toRailItem: a catalog card also carries overview / releaseDate / theatrical gate explicitly.</summary>
public sealed record CatalogRailItem : RailItem
{
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? Overview { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? ReleaseDate { get; init; }
    public bool InTheatricalWindow { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? NextHomeReleaseAt { get; init; }
}

public sealed record Rail(string Id, string Title, IReadOnlyList<object> Items)
{
    [JsonIgnore] public IEnumerable<RailItem> Cards => Items.Cast<RailItem>();
}

public sealed record BrowsePayload(IReadOnlyList<Rail> Rails, string GeneratedAt);

/// <summary>src/lib/browse/{rails,discovery}.ts: personal rails first, discovery rails beneath, empty rails dropped.</summary>
public sealed partial class BrowseService(
    IDbContextFactory<TorrentFlowDbContext> dbFactory,
    CatalogService catalog,
    TimeProvider time,
    ILogger<BrowseService> logger)
{
    public const int DiscoveryRailSize = 24;
    public const string TrendingRailId = "trending-now";
    public const string PopularRailId = "popular-series";
    public const string BecauseRailId = "because-you-are-watching";
    private static readonly HashSet<string> SplittableRailIds = ["ready-to-play"];

    [GeneratedRegex(@"(^|[^a-z])(tv|anime|series|show|episode|season)([^a-z]|$)")] private static partial Regex SeriesGroup();
    [GeneratedRegex(@"(^|[^a-z])(movie|film|feature)([^a-z]|$)")] private static partial Regex MovieGroup();

    public async Task<BrowsePayload> BuildAsync(string userId, CancellationToken ct = default)
    {
        var personalTask = Task.WhenAll(BuildNextUpAsync(userId, ct), BuildMyLibraryAsync(userId, ct));
        var discoveryTask = BuildDiscoveryRailsAsync(userId, ct);
        var personal = (await personalTask.ConfigureAwait(false)).OfType<Rail>().ToList();
        var discovery = await discoveryTask.ConfigureAwait(false);

        var organized = DedupeAcrossRails(personal, ["continue-watching", "ready-to-play"])
            .SelectMany(r => SplittableRailIds.Contains(r.Id) ? SplitRailByMediaType(r) : [r]);
        var rails = organized.Concat(discovery).Where(r => r.Items.Count > 0).ToList();
        return new BrowsePayload(rails, time.GetUtcNow().UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture));
    }

    private async Task<Rail?> BuildNextUpAsync(string userId, CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct).ConfigureAwait(false);
        var rows = await db.WatchListItems.AsNoTracking()
            .Where(w => w.UserId == userId && w.Monitored == true && w.CursorSeason != null && w.CursorEpisode != null)
            .OrderByDescending(w => w.UpdatedAt).Take(20).ToListAsync(ct).ConfigureAwait(false);
        if (rows.Count == 0) return null;
        var items = rows.Select(w => (object)new RailItem
        {
            Id = $"next-{w.Id}", Title = w.Title, Subtitle = FormatEpisodeSubtitle(w.CursorSeason, w.CursorEpisode),
            PosterUrl = w.PosterUrl, WatchListItemId = w.Id, MediaType = w.MediaType, Season = w.CursorSeason, Episode = w.CursorEpisode,
        }).ToList();
        return new Rail("next-up", "Next Up", items);
    }

    private async Task<Rail?> BuildMyLibraryAsync(string userId, CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct).ConfigureAwait(false);
        var rows = await db.WatchListItems.AsNoTracking().Where(w => w.UserId == userId)
            .OrderByDescending(w => w.UpdatedAt).Take(30).ToListAsync(ct).ConfigureAwait(false);
        if (rows.Count == 0) return null;
        var items = rows.Select(w => (object)new RailItem
        {
            Id = w.Id, Title = w.Title, Subtitle = w.LastEpisode ?? w.Status, PosterUrl = w.PosterUrl,
            WatchListItemId = w.Id, MediaType = w.MediaType,
        }).ToList();
        return new Rail("my-library", "My Library", items);
    }

    /// <summary>discovery.ts buildDiscoveryRails. Never throws.</summary>
    public async Task<List<Rail>> BuildDiscoveryRailsAsync(string userId, CancellationToken ct = default)
    {
        try { await catalog.EnsureFreshAsync(ct).ConfigureAwait(false); }
        catch (Exception e) when (e is not OperationCanceledException) { logger.LogError(e, "[discovery] catalog refresh unavailable"); }

        var trending = await SafeRowsAsync("trending", null, ct).ConfigureAwait(false);
        var popular = await SafeRowsAsync("popular", null, ct).ConfigureAwait(false);
        var rails = new List<Rail>();
        var because = await BuildBecauseRailAsync(userId, NewestOf(trending.Concat(popular)), ct).ConfigureAwait(false);
        if (because is not null) rails.Add(because);
        if (trending.Count > 0) rails.Add(new Rail(TrendingRailId, "Trending now", trending.Select(r => (object)ToRailItem(r)).ToList()));
        if (popular.Count > 0) rails.Add(new Rail(PopularRailId, "Popular series", popular.Select(r => (object)ToRailItem(r)).ToList()));
        return rails;
    }

    private async Task<Rail?> BuildBecauseRailAsync(string userId, DateTime? baseRefreshedAt, CancellationToken ct)
    {
        (string Title, string? MediaType)? seed;
        try { seed = await ReadWatchSeedAsync(userId, ct).ConfigureAwait(false); }
        catch (Exception e) when (e is not OperationCanceledException) { logger.LogError(e, "[discovery] seed unavailable"); return null; }
        if (seed is not { } s) return null;

        var rows = await SafeRowsAsync("related", s.Title, ct).ConfigureAwait(false);
        var newest = NewestOf(rows);
        if (rows.Count == 0)
        {
            await catalog.RefreshRelatedForSeedAsync(s.Title, s.MediaType).ConfigureAwait(false);
            rows = await SafeRowsAsync("related", s.Title, ct).ConfigureAwait(false);
        }
        else if (baseRefreshedAt is { } b && newest is { } n && n < b)
        {
            _ = catalog.RefreshRelatedForSeedAsync(s.Title, s.MediaType);
        }
        return rows.Count == 0 ? null : new Rail(BecauseRailId, $"Because you're watching {s.Title}", rows.Select(r => (object)ToRailItem(r)).ToList());
    }

    /// <summary>seed.ts readWatchSeed (simplified): newest unfinished PlaybackProgress title, else newest library row.</summary>
    private async Task<(string Title, string? MediaType)?> ReadWatchSeedAsync(string userId, CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct).ConfigureAwait(false);
        var watching = await db.PlaybackProgresses.AsNoTracking().Where(p => p.UserId == userId && p.CompletedAt == null)
            .OrderByDescending(p => p.UpdatedAt).Select(p => new { p.Title, p.WatchListItemId, p.Season, p.Episode }).FirstOrDefaultAsync(ct).ConfigureAwait(false);
        if (watching is not null)
        {
            if (watching.WatchListItemId is { } wid &&
                await db.WatchListItems.AsNoTracking().Where(w => w.Id == wid).Select(w => new { w.Title, w.MediaType }).FirstOrDefaultAsync(ct).ConfigureAwait(false) is { } linked)
                return (linked.Title, linked.MediaType);
            var cleaned = Enrichment.TitleCleaning.CleanTorrentTitle(watching.Title);
            if (!CatalogText.IsSlopTitle(cleaned))
                return (cleaned, watching.Season is not null || watching.Episode is not null ? "tv" : null);
        }
        var library = await db.WatchListItems.AsNoTracking().Where(w => w.UserId == userId).OrderByDescending(w => w.UpdatedAt)
            .Select(w => new { w.Title, w.MediaType }).FirstOrDefaultAsync(ct).ConfigureAwait(false);
        return library is null ? null : (library.Title, library.MediaType);
    }

    public static CatalogRailItem ToRailItem(CatalogEntry row) => new()
    {
        Id = $"catalog-{row.Id}",
        Title = row.Title,
        Subtitle = row.Year is { } y && y != 0 ? y.ToString(CultureInfo.InvariantCulture) : null,
        PosterUrl = row.PosterUrl,
        BackdropUrl = row.BackdropUrl,
        Overview = row.Overview,
        Availability = null,
        ReleaseDate = row.ReleaseDate?.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
        InTheatricalWindow = false,
        NextHomeReleaseAt = null,
        MediaType = MediaTypes.Normalize(row.MediaType),
    };

    private async Task<List<CatalogEntry>> SafeRowsAsync(string source, string? seed, CancellationToken ct)
    {
        try
        {
            var rows = await catalog.ReadRowsAsync(source, seed, DiscoveryRailSize, ct).ConfigureAwait(false);
            return rows.Where(r => !CatalogText.IsSlopTitle(r.Title)).ToList();
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            logger.LogError(e, "[discovery] {Source} rows unavailable", source);
            return [];
        }
    }

    private static DateTime? NewestOf(IEnumerable<CatalogEntry> rows) =>
        rows.Select(r => (DateTime?)r.RefreshedAt).DefaultIfEmpty(null).Max();

    public static string MediaGroupOf(string? mediaType)
    {
        var mt = (mediaType ?? "").Trim().ToLowerInvariant();
        if (mt.Length == 0) return "unknown";
        if (SeriesGroup().IsMatch(mt)) return "series";
        return MovieGroup().IsMatch(mt) ? "movie" : "unknown";
    }

    /// <summary>rails.ts railItemWorkKey (simplified identity: normalized title).</summary>
    public static string RailItemWorkKey(RailItem item) => CatalogText.NormalizeForKey(Enrichment.TitleCleaning.CleanTorrentTitle(item.Title));

    public static List<Rail> DedupeAcrossRails(IReadOnlyList<Rail> rails, IReadOnlyList<string> order)
    {
        var priority = order.Select((id, i) => (id, i)).ToDictionary(x => x.id, x => x.i);
        var seen = new HashSet<string>();
        var filtered = new Dictionary<string, List<object>>();
        foreach (var rail in rails.Where(r => priority.ContainsKey(r.Id)).OrderBy(r => priority[r.Id]))
            filtered[rail.Id] = rail.Cards.Where(item => seen.Add(RailItemWorkKey(item))).Cast<object>().ToList();
        return rails.Select(r => filtered.TryGetValue(r.Id, out var kept) ? r with { Items = kept } : r).ToList();
    }

    public static List<Rail> SplitRailByMediaType(Rail rail)
    {
        var groups = rail.Cards.GroupBy(i => MediaGroupOf(i.MediaType)).ToDictionary(g => g.Key, g => g.Cast<object>().ToList());
        if (!groups.TryGetValue("movie", out var movies) || !groups.TryGetValue("series", out var series)) return [rail];
        var output = new List<Rail> { new($"{rail.Id}-movies", $"{rail.Title} · Movies", movies), new($"{rail.Id}-series", $"{rail.Title} · Series", series) };
        if (groups.TryGetValue("unknown", out var unknown)) output.Add(new Rail(rail.Id, rail.Title, unknown));
        return output;
    }

    public static string? FormatEpisodeSubtitle(int? season, int? episode) =>
        season is not null && episode is not null ? $"S{season:D2}E{episode:D2}"
        : season is not null ? $"Season {season}"
        : episode is not null ? $"Episode {episode}"
        : null;
}
