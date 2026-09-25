using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Data;

namespace TorrentFlow.Media.Features.Prewarm;

/// <summary>
/// A. Pre-ranking (src/lib/prewarm/prerank.ts): decide which release to grab before the user asks, so "Download"
/// is one fast action instead of a live search. Nothing here downloads anything.
/// </summary>
public sealed class PreRanker
{
    public static readonly TimeSpan Ttl = TimeSpan.FromMinutes(10);
    /// <summary>How stale a SearchCache row may be and still be re-ranked (a result pool, not a verdict).</summary>
    public static readonly TimeSpan MaxStale = TimeSpan.FromMinutes(30);
    public const int SearchLimit = 15;
    public const int UpcomingLimit = 6;
    private const int MemoMaxEntries = 200;

    public static readonly IReadOnlyList<string> DefaultSources = ["monitored", "watching"];

    internal static readonly JsonSerializerOptions CacheJson = new(JsonSerializerDefaults.Web) { DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull };

    private readonly ITorrentSearchService _search;
    private readonly IDbContextFactory<TorrentFlowDbContext> _factory;
    private readonly SwarmMeasurements _swarm;
    private readonly TimeProvider _time;
    private readonly ILogger _logger;
    private readonly object _memoGate = new();
    private readonly OrderedDictionary<string, PreRankedChoice> _memo = new(StringComparer.Ordinal);

    public PreRanker(ITorrentSearchService search, IDbContextFactory<TorrentFlowDbContext> factory, SwarmMeasurements swarm,
        TimeProvider? time = null, ILogger<PreRanker>? logger = null)
    {
        _search = search;
        _factory = factory;
        _swarm = swarm;
        _time = time ?? TimeProvider.System;
        _logger = (ILogger?)logger ?? NullLogger.Instance;
    }

    private long NowMs => _time.GetUtcNow().ToUnixTimeMilliseconds();

    private static int? Unit(int? n) => n is >= 1 ? n : null;

    public static string Query(PreRankTarget target)
    {
        var season = Unit(target.Season); var episode = Unit(target.Episode);
        var title = target.Title.Trim();
        return season != null && episode != null ? ReleaseText.EpisodeSearchQuery(title, season.Value, episode.Value) : title;
    }

    /// <summary>Memo key — opaque, do not parse.</summary>
    public static string Key(PreRankTarget target) =>
        $"{ReleaseText.NormalizeTitle(target.Title)}|S{Unit(target.Season)?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "X"}E{Unit(target.Episode)?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "X"}";

    private static string PlanKey(PreRankTarget target) =>
        $"{Key(target)}|R{Unit(target.PreferredResolution)?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "X"}";

    /// <summary>
    /// The exact search the grab will run. Pre-rank and grab share it so the grab is a SearchCache hit rather than a
    /// second indexer fan-out.
    /// </summary>
    public static SearchOptions SearchOptionsFor(PreRankTarget target)
    {
        var season = Unit(target.Season); var episode = Unit(target.Episode);
        return new SearchOptions
        {
            Query = Query(target),
            Category = ReleaseText.SearchCategoryForMediaType(target.MediaType) ?? "tv",
            Limit = SearchLimit,
            Enrich = false,
            SkipCache = false,
            Background = true,
            Filters = new SearchFilters { HasMagnet = true, MinSeeders = 1, Season = season, Episode = episode },
        };
    }

    /// <summary>
    /// The release a grab should use, or null. Honours the resolution floor, requires a magnet, a seeder and an info
    /// hash, orders by stored swarm verdict (stable within a tier), and for an episode rejects season packs.
    /// </summary>
    public static TorrentResult? SelectBestRelease(IReadOnlyList<TorrentResult> results, PreRankTarget target, Func<TorrentResult, string>? verdictOf = null)
    {
        var season = Unit(target.Season); var episode = Unit(target.Episode);
        var floor = Unit(target.PreferredResolution);
        var usable = results
            .Where(r => floor == null || ReleaseText.MeetsResolutionFloor(r.Title, floor))
            .Where(r => !string.IsNullOrEmpty(r.Magnet) && r.Seeders > 0 && ReleaseText.ReleaseInfoHash(r) != null)
            .ToList();
        if (usable.Count == 0) return null;
        IEnumerable<TorrentResult> ordered = verdictOf is null
            ? usable
            : usable.Select((r, i) => (r, i, tier: ReleaseText.VerdictTier(verdictOf(r)))).OrderBy(x => x.tier).ThenBy(x => x.i).Select(x => x.r);

        if (season == null || episode == null)
        {
            // A film's identity includes its year; a bare series title takes the top result.
            return ReleaseText.NormalizeMediaType(target.MediaType) == "movie"
                ? ordered.FirstOrDefault(r => ReleaseText.FilmMatches(r.Title, target.Title, target.Year))
                : ordered.FirstOrDefault();
        }
        return ordered.FirstOrDefault(r =>
        {
            var ep = r.Episode ?? ReleaseText.ParseEpisode(r.Title);
            return !ep.IsSeasonPack && ep.Season == season && ep.Episode == episode;
        });
    }

    private async Task<Func<TorrentResult, string>> VerdictLookupAsync(IReadOnlyList<TorrentResult> results, CancellationToken ct)
    {
        var verdicts = await _swarm.LoadVerdictsAsync(results.Select(ReleaseText.ReleaseInfoHash), ct);
        return r => ReleaseText.ReleaseInfoHash(r) is { } h && verdicts.TryGetValue(h, out var v) ? v : "unknown";
    }

    private PreRankedChoice Remember(PreRankTarget target, PreRankedChoice choice)
    {
        lock (_memoGate)
        {
            var key = PlanKey(target);
            if (!_memo.ContainsKey(key) && _memo.Count >= MemoMaxEntries) _memo.RemoveAt(0);
            _memo.Remove(key);
            _memo.Add(key, choice);
        }
        return choice;
    }

    public void ClearMemo() { lock (_memoGate) _memo.Clear(); }

    public int MemoSize { get { lock (_memoGate) return _memo.Count; } }

    private static PreRankedChoice BuildChoice(PreRankTarget target, IReadOnlyList<TorrentResult> results, string source, long rankedAt, Func<TorrentResult, string>? verdictOf)
    {
        var options = SearchOptionsFor(target);
        return new PreRankedChoice
        {
            Key = Key(target),
            Query = options.Query,
            NormalizedQuery = ReleaseText.NormalizeTitle(target.Title),
            Category = options.Category,
            Season = Unit(target.Season),
            Episode = Unit(target.Episode),
            Candidate = SelectBestRelease(results, target, verdictOf),
            ResultCount = results.Count,
            Source = source,
            RankedAt = rankedAt,
            ExpiresAt = rankedAt + (long)Ttl.TotalMilliseconds,
        };
    }

    /// <summary>A choice already known — memo, then a fresh-enough SearchCache pool — without searching. Null = not determined.</summary>
    public async Task<PreRankedChoice?> GetPreRankedAsync(PreRankTarget target, CancellationToken ct = default)
    {
        var key = PlanKey(target);
        lock (_memoGate)
        {
            if (_memo.TryGetValue(key, out var hit))
            {
                if (hit.ExpiresAt > NowMs) return hit with { Source = "memo" };
                _memo.Remove(key);
            }
        }

        var normalized = ReleaseText.NormalizeTitle(target.Title);
        if (normalized.Length == 0) return null;
        try
        {
            var results = await CachedPoolAsync(normalized, ct);
            if (results is null) return null;
            var verdictOf = await VerdictLookupAsync(results.Value.Results, ct);
            return Remember(target, BuildChoice(target, results.Value.Results, "search-cache", results.Value.ExpiresAtMs, verdictOf));
        }
        catch (Exception e) when (!ct.IsCancellationRequested)
        {
            _logger.LogDebug(e, "[prewarm] could not read the search cache");
            return null;
        }
    }

    /// <summary>The newest SearchCache pool for a normalised title, unless it expired more than <see cref="MaxStale"/> ago.</summary>
    internal async Task<(IReadOnlyList<TorrentResult> Results, long ExpiresAtMs)?> CachedPoolAsync(string normalizedQuery, CancellationToken ct)
    {
        await using var db = await _factory.CreateDbContextAsync(ct);
        var row = await db.SearchCaches.AsNoTracking().Where(r => r.NormalizedQuery == normalizedQuery)
            .OrderByDescending(r => r.ExpiresAt).FirstOrDefaultAsync(ct);
        if (row is null) return null;
        var expiresMs = new DateTimeOffset(DateTime.SpecifyKind(row.ExpiresAt, DateTimeKind.Utc)).ToUnixTimeMilliseconds();
        if (NowMs - expiresMs > (long)MaxStale.TotalMilliseconds) return null;
        var payload = JsonSerializer.Deserialize<SearchResponse>(row.Payload, CacheJson);
        return payload?.Results is { } results ? (results, expiresMs) : null;
    }

    /// <summary>Pre-rank one target: a known answer first, otherwise one bounded background search. Never throws.</summary>
    public async Task<PreRankedChoice?> PreRankAsync(PreRankTarget target, bool force = false, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(target.Title)) return null;
        if (!force && await GetPreRankedAsync(target, ct) is { } known) return known;
        var options = SearchOptionsFor(target);
        try
        {
            var response = await _search.SearchAsync(options, ct);
            var verdictOf = await VerdictLookupAsync(response.Results, ct);
            return Remember(target, BuildChoice(target, response.Results, "search", NowMs, verdictOf));
        }
        catch (Exception e) when (!ct.IsCancellationRequested)
        {
            _logger.LogWarning("[prewarm] pre-rank failed for {Query}: {Message}", JsonSerializer.Serialize(options.Query), e.Message);
            return null;
        }
    }

    /// <summary>
    /// What the user is likely to want next, most confident first: monitored shows' hunt cursors, then (when asked)
    /// the watchlist, then one past each in-progress episode. Reads only; never moves a cursor.
    /// </summary>
    public async Task<List<PreRankTarget>> UpcomingTargetsAsync(string userId, int? limit = null, IReadOnlyCollection<string>? sources = null, CancellationToken ct = default)
    {
        var max = Math.Max(1, limit ?? UpcomingLimit);
        var wanted = new HashSet<string>(sources ?? DefaultSources, StringComparer.Ordinal);
        List<PreRankTarget> output = [];
        HashSet<string> seen = new(StringComparer.Ordinal);
        void Push(PreRankTarget t)
        {
            if (output.Count >= max || !seen.Add(Key(t))) return;
            output.Add(t);
        }

        await using var db = await _factory.CreateDbContextAsync(ct);
        if (wanted.Contains("monitored"))
        {
            try
            {
                var monitored = await db.WatchListItems.AsNoTracking().Where(i => i.UserId == userId && i.Monitored == true)
                    .OrderByDescending(i => i.UpdatedAt).Take(max * 2).ToListAsync(ct);
                foreach (var item in monitored)
                {
                    if (!ReleaseText.IsSeriesMediaType(item.MediaType)) continue;
                    if (Cursor(item) is not { } c) continue;
                    Push(new PreRankTarget { Title = item.Title, MediaType = item.MediaType, Season = c.Season, Episode = c.Episode });
                }
            }
            catch (Exception e) when (!ct.IsCancellationRequested) { _logger.LogDebug(e, "[prewarm] monitored targets unavailable"); }
        }

        if (wanted.Contains("watchlist"))
        {
            try
            {
                var saved = await db.WatchListItems.AsNoTracking().Where(i => i.UserId == userId && i.Status != "completed" && i.Status != "dropped")
                    .OrderByDescending(i => i.UpdatedAt).Take(max * 2).ToListAsync(ct);
                foreach (var item in saved)
                {
                    if (ReleaseText.IsSeriesMediaType(item.MediaType))
                    {
                        if (Cursor(item) is not { } c) continue;
                        Push(new PreRankTarget { Title = item.Title, MediaType = item.MediaType, Season = c.Season, Episode = c.Episode });
                    }
                    else
                    {
                        Push(new PreRankTarget { Title = item.Title, MediaType = item.MediaType });
                    }
                }
            }
            catch (Exception e) when (!ct.IsCancellationRequested) { _logger.LogDebug(e, "[prewarm] watchlist targets unavailable"); }
        }

        if (wanted.Contains("watching"))
        {
            try
            {
                var watching = await db.PlaybackProgresses.AsNoTracking()
                    .Where(p => p.UserId == userId && p.CompletedAt == null && p.Season != null && p.Episode != null)
                    .OrderByDescending(p => p.UpdatedAt).Take(max * 2).ToListAsync(ct);
                var ids = watching.Select(p => p.WatchListItemId).OfType<string>().Distinct().ToList();
                var items = ids.Count == 0 ? [] : await db.WatchListItems.AsNoTracking().Where(i => ids.Contains(i.Id) && i.UserId == userId).ToListAsync(ct);
                var byId = items.ToDictionary(i => i.Id);
                foreach (var row in watching)
                {
                    if (row.WatchListItemId is null || !byId.TryGetValue(row.WatchListItemId, out var item)) continue;
                    if (!ReleaseText.IsSeriesMediaType(item.MediaType) || row.Season is not { } s || row.Episode is not { } e) continue;
                    var next = ReleaseText.AdvanceCursor(s, e);
                    Push(new PreRankTarget { Title = item.Title, MediaType = item.MediaType, Season = next.Season, Episode = next.Episode });
                }
            }
            catch (Exception e) when (!ct.IsCancellationRequested) { _logger.LogDebug(e, "[prewarm] continue-watching targets unavailable"); }
        }
        return output;
    }

    private static (int Season, int Episode)? Cursor(Data.Entities.WatchListItem item) =>
        ReleaseText.ResolveHuntCursor(item.MediaType, item.CursorSeason, item.CursorEpisode, item.FromSeason, item.FromEpisode, item.LastEpisode, item.NextEpisodeHint);

    /// <summary>Pre-rank the upcoming targets in order; stops at the first undetermined one (throttled or failing indexers).</summary>
    public async Task<List<PreRankedChoice>> PreRankUpcomingAsync(string userId, int? limit = null, CancellationToken ct = default)
    {
        var targets = await UpcomingTargetsAsync(userId, limit, ct: ct);
        List<PreRankedChoice> output = [];
        foreach (var target in targets)
        {
            if (await PreRankAsync(target, ct: ct) is not { } choice) break;
            output.Add(choice);
        }
        return output;
    }
}
