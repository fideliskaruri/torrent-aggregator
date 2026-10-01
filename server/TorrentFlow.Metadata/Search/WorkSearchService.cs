using System.Text.Json.Serialization;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Metadata.Caching;
using TorrentFlow.Metadata.Providers;
using TorrentFlow.Metadata.Text;
using TorrentFlow.Core.Sources;

namespace TorrentFlow.Metadata.Search;

/// <summary>Port of WorkSearchHit (src/lib/search/work-search.ts).</summary>
public sealed record WorkSearchHit
{
    public required string WorkKey { get; init; }
    public required string Title { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public int? Year { get; init; }
    public required string Category { get; init; }
    public required string Provider { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? ProviderId { get; init; }
    public required IReadOnlyList<string> Aliases { get; init; }
    public required string MediaType { get; init; }
    public required string TitleMediaType { get; init; }
    public bool IsSeries { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? Format { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? PosterUrl { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? Overview { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? ReleaseDate { get; init; }
    public required string Href { get; init; }
    public IReadOnlyDictionary<string, string>? ExternalIds { get; init; }

    /// <summary>Provider popularity on a 0–1 scale. Ranking signal only.</summary>
    [JsonIgnore] internal double? Popularity { get; init; }
    /// <summary>TVmaze lists the show as animation, so an AniList entry of the same name and era is the same anime.</summary>
    [JsonIgnore] internal bool Animated { get; init; }
    /// <summary>The provider says the work is not released yet.</summary>
    [JsonIgnore] internal bool Upcoming { get; init; }
    /// <summary>The provider's best hit for the query, found by a name it did not return (an original or romanized title).</summary>
    [JsonIgnore] internal bool AlternateTitleMatch { get; init; }

    /// <summary>This hit under another work key, its title link following.</summary>
    internal WorkSearchHit WithWorkKey(string workKey)
    {
        if (workKey.Length == 0 || workKey == WorkKey) return this;
        var query = Href.IndexOf('?', StringComparison.Ordinal);
        return this with { WorkKey = workKey, Href = $"{WorkKeys.TitleHref}/{WorkKeys.EncodeKeySegment(workKey)}{(query >= 0 ? Href[query..] : "")}" };
    }
}

public sealed record WorkSearchOutcome(List<WorkSearchHit> Results, string Query, string DisplayQuery, IReadOnlyList<string> Attempted,
    IReadOnlyList<string> Failed, bool Partial, bool Stale = false);

/// <summary>One category provider: (canonical query, limit) → hits.</summary>
public delegate Task<List<WorkSearchHit>> WorkSearchProvider(string query, int limit, CancellationToken ct);

/// <summary>Port of src/lib/search/work-search.ts + work-search-fanout.ts.</summary>
public sealed class WorkSearchService
{
    public static readonly string[] Categories = ["movies", "series", "anime"];
    private static readonly TimeSpan Fresh = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan StaleTtl = TimeSpan.FromHours(24);
    /// <summary>How long ranking waits for IMDb popularity after the providers answered; it normally lands first.</summary>
    private static readonly TimeSpan ImdbRankGrace = TimeSpan.FromSeconds(1);
    private static readonly IReadOnlyDictionary<string, int> NoImdbRanks = new Dictionary<string, int>();

    private readonly TimeProvider _time;
    private readonly IReadOnlyDictionary<string, WorkSearchProvider> _providers;
    private readonly bool _cacheEnabled;
    private readonly TmdbClient? _tmdb;
    private readonly SourceRegistry? _registry;
    private readonly CinemetaClient? _cinemeta;
    private readonly BoundedTtlCache<(WorkSearchOutcome Result, DateTimeOffset FreshUntil)> _cache;

    public WorkSearchService(TmdbClient tmdb, AniListClient anilist, KeylessClients keyless, TimeProvider time,
        SourceRegistry? registry = null, CinemetaClient? cinemeta = null)
        : this(registry is not null && cinemeta is not null ? RegistryProviders(registry, tmdb, anilist, keyless, cinemeta) :
            DefaultProviders(tmdb, anilist, keyless, time), time, cacheEnabled: true) { _tmdb = tmdb; _registry = registry; _cinemeta = cinemeta; }

    internal WorkSearchService(IReadOnlyDictionary<string, WorkSearchProvider> providers, TimeProvider time, bool cacheEnabled = false)
    {
        _providers = providers;
        _time = time;
        _cacheEnabled = cacheEnabled;
        _cache = new(100, time);
    }

    public static string ParseScope(string? value, string fallback = "all")
    {
        if (value == null) return fallback;
        var n = value.Trim().ToLowerInvariant();
        return n == "all" || Categories.Contains(n) ? n : fallback;
    }

    public static WorkSearchHit? HitFromMetadata(MediaMetadata metadata, string category, string? format = null)
    {
        var title = metadata.Title?.Trim();
        if (string.IsNullOrEmpty(title)) return null;
        var provider = metadata.Source;
        var mediaType = category == "movies" ? "movie" : category == "series" ? "tv" : "anime";
        var normalizedFormat = string.IsNullOrWhiteSpace(format) ? null : format.Trim().ToUpperInvariant();
        var isSeries = category == "series" || (category == "anime" && normalizedFormat != "MOVIE");
        var titleMediaType = category == "anime" && !isSeries ? "movie" : mediaType;
        var year = metadata.Year;
        var workKey = WorkKeys.WorkKeyFor(title, isSeries ? null : year);
        if (workKey.Length == 0) return null;
        var providerId = string.IsNullOrWhiteSpace(metadata.ExternalId) ? null : metadata.ExternalId.Trim();
        var aliases = (metadata.Aliases ?? []).Select(a => a.Trim()).Where(a => a.Length > 0).Distinct(StringComparer.Ordinal).ToList();
        var basePath = WorkKeys.TitlePath(workKey, new(title, year, titleMediaType));
        var extra = new List<(string, string)> { ("provider", provider) };
        if (providerId != null) extra.Add(("providerId", providerId));
        extra.Add(("sourceType", mediaType));
        if (normalizedFormat != null) extra.Add(("format", normalizedFormat));
        extra.Add(("series", isSeries ? "1" : "0"));
        return new WorkSearchHit
        {
            WorkKey = workKey, Title = title, Year = year, Category = category, Provider = provider, ProviderId = providerId, Aliases = aliases,
            MediaType = mediaType, TitleMediaType = titleMediaType, IsSeries = isSeries, Format = normalizedFormat,
            PosterUrl = metadata.PosterUrl, Overview = metadata.Synopsis, ReleaseDate = metadata.ReleaseDate,
            Href = $"{basePath}&{TextUtil.BuildQuery(extra)}",
            ExternalIds = metadata.AdditionalProperties?.TryGetValue("externalIds", out var ids) == true && ids.ValueKind == System.Text.Json.JsonValueKind.Object
                ? ids.EnumerateObject().Where(p => p.Value.ValueKind is System.Text.Json.JsonValueKind.String or System.Text.Json.JsonValueKind.Number)
                    .ToDictionary(p => p.Name, p => p.Value.ToString()) : new Dictionary<string, string> { [provider] = metadata.ExternalId },
        };
    }

    private static WorkSearchHit? HitFromAniList(AniListWork work, string category) =>
        HitFromMetadata(work.Metadata, category, work.Format) is { } hit
            ? hit with { Popularity = SearchRanking.AniListPopularity(work.Popularity), Upcoming = work.Status == "NOT_YET_RELEASED" }
            : null;

    private static WorkSearchHit? HitFromTvmaze(TvmazeCandidate show, string category) =>
        HitFromMetadata(KeylessClients.Metadata(show), category) is { } hit
            ? hit with { Popularity = SearchRanking.TvmazeWeight(show.Weight), Animated = show.Type == "Animation" }
            : null;

    private static List<WorkSearchHit> HitsInProviderOrder(IEnumerable<MediaMetadata> rows, string category) =>
        rows.Select((m, index) => HitFromMetadata(m, category) is { } hit ? hit with { Popularity = SearchRanking.PositionPrior(index) } : null)
            .OfType<WorkSearchHit>().ToList();

    public static WorkSearchHit? HitFromKeyless(int id, string rawTitle, int? year, string? posterUrl, string category, string provider)
    {
        var title = rawTitle.Trim();
        if (title.Length == 0) return null;
        var isSeries = category == "series";
        var workKey = WorkKeys.WorkKeyFor(title, isSeries ? null : year);
        if (workKey.Length == 0) return null;
        var mediaType = isSeries ? "tv" : "movie";
        return new WorkSearchHit
        {
            WorkKey = workKey, Title = title, Year = year, Category = category, Provider = provider, ProviderId = id > 0 ? id.ToString() : null,
            Aliases = [], MediaType = mediaType, TitleMediaType = mediaType, IsSeries = isSeries, PosterUrl = posterUrl,
            Href = WorkKeys.TitlePath(workKey, new(title, year, mediaType)),
        };
    }

    public static int KeylessSearchTimeoutMs(DateTimeOffset deadline, DateTimeOffset now) =>
        (int)Math.Max(0, Math.Min(4000, (deadline - now).TotalMilliseconds));

    private static bool HasRelevantHit(string query, IEnumerable<WorkSearchHit> hits) =>
        hits.Any(h => Relevance.HasRelevantTitle(query, new[] { h.Title }.Concat(h.Aliases)));

    private static List<WorkSearchHit> DedupeProviderHits(IEnumerable<WorkSearchHit> hits)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        return hits.Where(h => seen.Add($"{h.Provider}:{h.ProviderId ?? h.WorkKey}")).ToList();
    }

    public static async Task<List<WorkSearchHit>> WithKeylessFallback(string query, Func<Task<List<WorkSearchHit>>> primary, Func<Task<List<WorkSearchHit>>> fallback)
    {
        List<WorkSearchHit> primaryHits = [];
        Exception? primaryError = null;
        try { primaryHits = await primary().ConfigureAwait(false); }
        catch (Exception e) when (e is not OperationCanceledException { CancellationToken.IsCancellationRequested: true }) { primaryError = e; }
        if (HasRelevantHit(query, primaryHits)) return primaryHits;
        var fallbackHits = await fallback().ConfigureAwait(false);
        var merged = primaryHits.Concat(fallbackHits).ToList();
        if (primaryError != null && !HasRelevantHit(query, merged)) throw primaryError;
        return merged;
    }

    private static Dictionary<string, WorkSearchProvider> DefaultProviders(TmdbClient tmdb, AniListClient anilist, KeylessClients keyless, TimeProvider time)
    {
        async Task<List<WorkSearchHit>> KeylessLoop(string query, int limit, Func<string, int, Task<IEnumerable<WorkSearchHit?>>> search)
        {
            var deadline = time.GetUtcNow().AddSeconds(10);
            var output = new List<WorkSearchHit>();
            foreach (var variant in QueryVariants.SearchDiscoveryVariants(query))
            {
                var timeout = KeylessSearchTimeoutMs(deadline, time.GetUtcNow());
                if (timeout == 0) break;
                output.AddRange((await search(variant, timeout).ConfigureAwait(false)).OfType<WorkSearchHit>());
                if (HasRelevantHit(query, output)) break;
            }

            return DedupeProviderHits(output);
        }

        return new()
        {
            ["movies"] = (q, limit, ct) => WithKeylessFallback(q,
                async () => HitsInProviderOrder(await tmdb.SearchByTypeAsync("movie", q, limit, ct).ConfigureAwait(false), "movies"),
                () => KeylessLoop(q, limit, async (v, t) => (await keyless.SearchItunesAsync(v, limit, t, ct: ct).ConfigureAwait(false))
                    .Select((c, index) => HitFromKeyless(c.Id, c.Title, c.Year, c.PosterUrl, "movies", "itunes") is { } hit
                        ? hit with { Popularity = SearchRanking.PositionPrior(index) } : null))),
            ["series"] = (q, limit, ct) => WithKeylessFallback(q,
                async () => HitsInProviderOrder(await tmdb.SearchByTypeAsync("tv", q, limit, ct).ConfigureAwait(false), "series"),
                () => KeylessLoop(q, limit, async (v, t) => (await keyless.SearchTvmazeAsync(v, limit, t, ct).ConfigureAwait(false))
                    .Select(c => HitFromKeyless(c.Id, c.Title, c.Year, c.PosterUrl, "series", "tvmaze") is { } hit
                        ? hit with { Popularity = SearchRanking.TvmazeWeight(c.Weight), Animated = c.Type == "Animation" } : null))),
            ["anime"] = async (q, limit, ct) => (await anilist.SearchWorksAsync(q, limit, ct).ConfigureAwait(false))
                .Select(w => HitFromAniList(w, "anime")).OfType<WorkSearchHit>().ToList(),
        };
    }

    /// <summary>
    /// Every enabled catalog of the category answers at once and ranking merges them. Stopping at the first catalog with a
    /// matching name hid the work people meant: TVmaze's "Money Heist: Korea" hid La Casa de Papel, Cinemeta's "Se7en"
    /// (2022) hid TMDB's 1995 film, and only one of several same-name shows came back. The category fails only when every
    /// catalog failed, so a rate-limited AniList reports as failed instead of as "no results".
    /// </summary>
    private static Dictionary<string, WorkSearchProvider> RegistryProviders(SourceRegistry registry, TmdbClient tmdb,
        AniListClient anilist, KeylessClients keyless, CinemetaClient cinemeta) => Categories.ToDictionary(category => category,
        category => (WorkSearchProvider)(async (query, limit, ct) =>
        {
            var sources = registry.Active("metadata", category).ToList();
            var settled = await Task.WhenAll(sources.Select(source => Settle(SourceExecution.RunAsync(source,
                token => SearchSourceAsync(source, category, query, limit, tmdb, anilist, keyless, cinemeta, token), ct)))).ConfigureAwait(false);
            ct.ThrowIfCancellationRequested();
            if (settled.Length > 0 && settled.All(s => s.Error != null)) throw settled[0].Error!;
            return settled.SelectMany(s => s.Value ?? []).ToList();
        }));

    private static async Task<List<WorkSearchHit>> SearchSourceAsync(SourceEntry source, string category, string query, int limit,
        TmdbClient tmdb, AniListClient anilist, KeylessClients keyless, CinemetaClient cinemeta, CancellationToken token)
    {
        var type = category == "series" ? "tv" : "movie";
        switch (source.Type)
        {
            case "anilist":
                return (await anilist.SearchWorksAsync(query, limit, token)).Select(w => HitFromAniList(w, category)).OfType<WorkSearchHit>().ToList();
            case "tvmaze":
                return (await keyless.SearchTvmazeAsync(query, limit, source.TimeoutMs, token)).Select(c => HitFromTvmaze(c, category)).OfType<WorkSearchHit>().ToList();
            case "tmdb":
                // TMDB searches original and alternative titles too, so its first hit is the work even when none of the
                // names it returns is the one typed ("Wo hu cang long").
                return HitsInProviderOrder(await tmdb.SearchByTypeAsync(type, query, limit, token), category)
                    .Select((hit, index) => index == 0 ? hit with { AlternateTitleMatch = true } : hit).ToList();
            case "cinemeta":
                var rows = cinemeta.SearchAsync(query, type, limit, token);
                var top = await cinemeta.ImdbTopIdAsync(query, type, token);
                return HitsInProviderOrder(await rows, category)
                    .Select(hit => top is not null && hit.ProviderId == top ? hit with { AlternateTitleMatch = true } : hit).ToList();
            case "itunes":
                return HitsInProviderOrder((await keyless.SearchItunesAsync(query, limit, source.TimeoutMs, ct: token)).Select(c => new MediaMetadata
                    { Source = "itunes", MediaType = "movie", ExternalId = c.Id.ToString(), Title = c.Title, Year = c.Year, PosterUrl = c.PosterUrl }), category);
            default:
                return [];
        }
    }

    public async Task<WorkSearchOutcome> SearchAsync(string scope, string rawQuery, int limit, CancellationToken ct = default)
    {
        var query = QueryVariants.Canonicalize(rawQuery);
        var display = QueryVariants.Display(rawQuery);
        IReadOnlyList<string> attempted = scope == "all" ? Categories : [scope];
        var cacheKey = _cacheEnabled ? $"{_registry?.Revision}:{_tmdb?.CredentialRevision ?? 0}:{scope}:{limit}:{query.ToLowerInvariant()}" : null;
        if (cacheKey != null && _cache.TryGet(cacheKey, out var cached) && cached.FreshUntil > _time.GetUtcNow())
            return cached.Result with { Stale = false };

        var tasks = attempted.Select(c => Settle(_providers[c](query, limit, ct))).ToList();
        // IMDb has no anime ids to rank; everywhere else its popularity rank puts the work people mean first.
        var imdbRanks = _cinemeta is not null && scope != "anime" ? _cinemeta.ImdbRanksAsync(query, ct) : null;
        var settled = await Task.WhenAll(tasks).ConfigureAwait(false);
        ct.ThrowIfCancellationRequested();
        var failed = attempted.Where((_, i) => settled[i].Error != null).ToList();
        if (failed.Count == attempted.Count)
        {
            if (cacheKey != null && _cache.TryGet(cacheKey, out var stale))
                return stale.Result with { Failed = failed, Partial = true, Stale = true };
            throw new AllProvidersFailedException(failed, settled[0].Error);
        }
        var byCategory = settled.Select(s => (IReadOnlyList<WorkSearchHit>)(s.Value ?? [])).ToList();
        var merged = attempted.Count > 1 ? Relevance.InterleaveByProviderRank(byCategory, query) : [.. byCategory[0]];
        var ranked = SearchRanking.Rank(merged, query, await AwaitImdbRanks(imdbRanks, ct).ConfigureAwait(false), _time.GetUtcNow());
        var results = ranked.Take(limit).ToList();
        var outcome = new WorkSearchOutcome(results, query, display, attempted, failed, failed.Count > 0);
        // A result missing a failed catalog (AniList rate-limited) is kept only as the stale fallback, so the next search asks again.
        if (cacheKey != null) _cache.Set(cacheKey, (outcome, failed.Count > 0 ? _time.GetUtcNow() : _time.GetUtcNow() + Fresh), StaleTtl);
        return outcome;
    }

    private async Task<IReadOnlyDictionary<string, int>> AwaitImdbRanks(Task<IReadOnlyDictionary<string, int>>? ranks, CancellationToken ct)
    {
        if (ranks is null) return NoImdbRanks;
        try { return await ranks.WaitAsync(ImdbRankGrace, _time, ct).ConfigureAwait(false); }
        catch (TimeoutException) { return NoImdbRanks; }
    }

    public static async Task<(T? Value, Exception? Error)> Settle<T>(Task<T> task)
    {
        try { return (await task.ConfigureAwait(false), null); }
        catch (Exception e) { return (default, e); }
    }
}

/// <summary>Port of Suggestion (src/lib/search/suggest.ts).</summary>
public sealed record Suggestion
{
    public required string Title { get; init; }
    public IReadOnlyList<string>? Aliases { get; init; }
    public required string MediaType { get; init; }
    public string? PosterUrl { get; init; }
    public int? Year { get; init; }
    public required string Source { get; init; }
    public required string ExternalId { get; init; }
}

public sealed record SuggestOutcome(List<Suggestion> Suggestions, string Query, string DisplayQuery, IReadOnlyList<string> Failed, bool Partial);

public delegate Task<List<Suggestion>> SuggestProvider(string query, int limit, CancellationToken ct);

/// <summary>Port of collectSuggestions (src/lib/search/suggest.ts).</summary>
public sealed class SuggestService
{
    private static readonly string[] Order = ["anilist", "tmdb"];
    private readonly IReadOnlyDictionary<string, SuggestProvider> _providers;
    private readonly WorkSearchService? _search;

    public SuggestService(AniListClient anilist, TmdbClient tmdb, WorkSearchService? search = null) : this(new Dictionary<string, SuggestProvider>
    {
        ["anilist"] = async (q, l, ct) => (await anilist.SearchAsync(q, l, ct).ConfigureAwait(false)).Select(ToSuggestion).ToList(),
        ["tmdb"] = async (q, l, ct) => (await tmdb.SearchAsync(q, l, ct).ConfigureAwait(false)).Select(ToSuggestion).ToList(),
    }) { _search = search; }

    internal SuggestService(IReadOnlyDictionary<string, SuggestProvider> providers) => _providers = providers;

    private static Suggestion ToSuggestion(MediaMetadata m) => new()
    {
        Title = m.Title, Aliases = m.Aliases, MediaType = m.MediaType, PosterUrl = m.PosterUrl, Year = m.Year, Source = m.Source, ExternalId = m.ExternalId,
    };

    public async Task<SuggestOutcome> CollectAsync(string rawQuery, int perProvider = 4, int total = 8, CancellationToken ct = default)
    {
        var query = QueryVariants.Canonicalize(rawQuery);
        var display = QueryVariants.Display(rawQuery);
        if (_search is not null)
        {
            var outcome = await _search.SearchAsync("all", rawQuery, total, ct);
            return new(outcome.Results.Select(r => new Suggestion { Title = r.Title, Aliases = r.Aliases, MediaType = r.MediaType,
                PosterUrl = r.PosterUrl, Year = r.Year, Source = r.Provider, ExternalId = r.ProviderId ?? r.WorkKey }).ToList(),
                query, display, outcome.Failed, outcome.Partial);
        }
        var settled = await Task.WhenAll(Order.Select(n => WorkSearchService.Settle(_providers[n](query, perProvider, ct)))).ConfigureAwait(false);
        ct.ThrowIfCancellationRequested();
        var failed = Order.Where((_, i) => settled[i].Error != null).ToList();
        if (failed.Count == Order.Length) throw new AllProvidersFailedException(failed, settled[0].Error);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var unique = settled.SelectMany(s => s.Value ?? []).Where(s =>
        {
            var key = QueryVariants.Canonicalize(s.Title);
            return key.Length > 0 && seen.Add(key);
        }).ToList();
        var suggestions = Relevance.RankTitleHits(unique, query, s => s.Title, s => s.Aliases)
            .Where(s => Relevance.BestTier(query, new[] { s.Title }.Concat(s.Aliases ?? [])) < 6)
            .Take(total).ToList();
        return new SuggestOutcome(suggestions, query, display, failed, failed.Count > 0);
    }
}
