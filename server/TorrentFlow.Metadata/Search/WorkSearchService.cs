using System.Text.Json.Serialization;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Metadata.Caching;
using TorrentFlow.Metadata.Providers;
using TorrentFlow.Metadata.Text;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Core.Sources;
using TorrentFlow.Core.Text;
using TorrentFlow.Data;

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
    /// <summary>The hit is a work the library already stores, under that work's key.</summary>
    [JsonIgnore] internal bool Stored { get; init; }

    /// <summary>This hit under another work key, its title link following.</summary>
    internal WorkSearchHit WithWorkKey(string workKey)
    {
        if (workKey.Length == 0 || workKey == WorkKey) return this;
        var query = Href.IndexOf('?', StringComparison.Ordinal);
        return this with { WorkKey = workKey, Href = $"{WorkKeys.TitleHref}/{WorkKeys.EncodeKeySegment(workKey)}{(query >= 0 ? Href[query..] : "")}" };
    }
}

/// <summary>A work the library stores, as search sees it: its key, era, kind and every id it is known by ("tmdb:1396").</summary>
public sealed record StoredWork(string WorkKey, int? Year, bool IsSeries, IReadOnlySet<string> Ids)
{
    /// <summary>The ids of the work's own record and its canonical ids, without what its links add.</summary>
    public IReadOnlySet<string>? Own { get; init; }

    /// <summary>One id as "provider:id"; Cinemeta's ids are IMDb's.</summary>
    public static string Id(string provider, string id) => WorkIdentities.Id(provider, id);
}

public sealed record WorkSearchOutcome(List<WorkSearchHit> Results, string Query, string DisplayQuery, IReadOnlyList<string> Attempted,
    IReadOnlyList<string> Failed, bool Partial, bool Stale = false);

/// <summary>One category provider: (canonical query, limit) → hits.</summary>
public delegate Task<List<WorkSearchHit>> WorkSearchProvider(string query, int limit, CancellationToken ct);

/// <summary>Port of src/lib/search/work-search.ts + work-search-fanout.ts.</summary>
public sealed partial class WorkSearchService
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
    private readonly IDbContextFactory<TorrentFlowDbContext>? _works;
    private readonly BoundedTtlCache<(WorkSearchOutcome Result, DateTimeOffset FreshUntil)> _cache;
    /// <summary>How long the stored works' keys and canonical ids are reused before being read again (sooner when a work changes).</summary>
    private static readonly TimeSpan StoredIndexTtl = TimeSpan.FromSeconds(30);
    private StoredIndex? _storedIndex;

    /// <summary>Every stored work's key, the name it gives (<see cref="WorkKeySlug.NameOf"/>) and its canonical ids, as read at <paramref name="Version"/>.</summary>
    private sealed record StoredIndex(long Version, DateTimeOffset ReadAt, IReadOnlyList<(string Key, string Name, HashSet<string> Ids)> Works);

    public WorkSearchService(TmdbClient tmdb, AniListClient anilist, KeylessClients keyless, TimeProvider time,
        SourceRegistry? registry = null, CinemetaClient? cinemeta = null, IDbContextFactory<TorrentFlowDbContext>? works = null)
        : this(registry is not null && cinemeta is not null ? RegistryProviders(registry, tmdb, anilist, keyless, cinemeta) :
            DefaultProviders(tmdb, anilist, keyless, time), time, cacheEnabled: true) { _tmdb = tmdb; _registry = registry; _cinemeta = cinemeta; _works = works; }

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
                return await WithAlternateTitle(query, (await keyless.SearchTvmazeAsync(query, limit, source.TimeoutMs, token))
                    .Select(c => HitFromTvmaze(c, category)).OfType<WorkSearchHit>().ToList(), hits => hits.FirstOrDefault(),
                    hit => int.TryParse(hit.ProviderId, out var id) ? keyless.GetTvmazeAkasAsync(id, token) : Task.FromResult(new List<string>()),
                    unmatchedOnly: true);
            case "tmdb":
                return await WithAlternateTitle(query, HitsInProviderOrder(await tmdb.SearchByTypeAsync(type, query, limit, token), category),
                    hits => hits.FirstOrDefault(), hit => tmdb.AlternativeTitlesAsync(type, hit.ProviderId!, token));
            case "cinemeta":
                var rows = cinemeta.SearchAsync(query, type, limit, token);
                var top = await cinemeta.ImdbTopAsync(query, type, token);
                // IMDb's names for a top suggestion the query matches only loosely ("Seven" for "Se7en") are fetched while
                // Cinemeta still answers, so the evidence adds no round trip; the hit is the same tt id under the same name.
                var names = top is { ExternalId: { } topId } && Relevance.BestTier(query, new[] { top.Title }.Concat(top.Aliases ?? [])) >= 5
                    ? cinemeta.ImdbNamesAsync(topId, token) : null;
                return await WithAlternateTitle(query, HitsInProviderOrder(await rows, category),
                    hits => hits.FirstOrDefault(h => top?.ExternalId is { } id && h.ProviderId == id),
                    hit => names ?? cinemeta.ImdbNamesAsync(hit.ProviderId!, token));
            case "itunes":
                return HitsInProviderOrder((await keyless.SearchItunesAsync(query, limit, source.TimeoutMs, ct: token)).Select(c => new MediaMetadata
                    { Source = "itunes", MediaType = "movie", ExternalId = c.Id.ToString(), Title = c.Title, Year = c.Year, PosterUrl = c.PosterUrl }), category);
            default:
                return [];
        }
    }

    /// <summary>
    /// Catalogs match a query against names they do not return: TMDB finds Parasite for "Gisaengchung", IMDb finds Crouching
    /// Tiger, Hidden Dragon for "Wo hu cang long", TVmaze finds La Casa de Papel for "Money Heist". When the provider's
    /// top hit has no name matching the query, its own other titles (TMDB alternative titles, IMDb's original title and
    /// AKAs, TVmaze AKAs) are fetched once; a title the query matches joins its aliases, so ranking matches it like any
    /// other name. With no such title the hit stays unmatched: "zzzzzz" never surfaces a popular unrelated film.
    /// AniList returns romaji and synonyms with every hit, so it needs no lookup. TVmaze already scores a show by its AKAs,
    /// so its top hit is looked up only when no name of it matches at all (La Casa de Papel for "Money Heist"), not for a
    /// loose match ("Seven Up!" for "Se7en") whose lookup would only add a round trip.
    /// </summary>
    private static async Task<List<WorkSearchHit>> WithAlternateTitle(string query, List<WorkSearchHit> hits,
        Func<List<WorkSearchHit>, WorkSearchHit?> pickTop, Func<WorkSearchHit, Task<List<string>>> titlesOf, bool unmatchedOnly = false)
    {
        // A fuzzy-only name ("Seven" for "se7en") still earns the lookup: the catalog's own title may match literally.
        if (pickTop(hits) is not { ProviderId: { Length: > 0 } } top) return hits;
        var tier = Relevance.BestTier(query, new[] { top.Title }.Concat(top.Aliases));
        if (tier < (unmatchedOnly ? 6 : 5)) return hits;
        List<string> titles;
        try { titles = await titlesOf(top).ConfigureAwait(false); }
        catch (Exception e) when (e is HttpRequestException or System.Text.Json.JsonException or TaskCanceledException) { return hits; }
        var name = titles.Where(t => Relevance.BestTier(query, [t]) < tier).MinBy(t => Relevance.BestTier(query, [t]));
        if (name is null) return hits;
        var index = hits.IndexOf(top);
        hits[index] = top with { Aliases = [.. top.Aliases, name] };
        return hits;
    }

    /// <summary>
    /// The stored works the hits might be: the same provider id, a stored id or verified link, the hit's own key, or any
    /// key of the same name with a year (any year, either kind). Search links a hit to its stored work's key and keeps
    /// other keys clear of stored ones (see <see cref="SearchRanking"/>), so a download, request or watchlist row never
    /// ends up on a second key or on another work.
    /// </summary>
    private async Task<IReadOnlyList<StoredWork>> StoredWorksAsync(IReadOnlyList<WorkSearchHit> hits, CancellationToken ct)
    {
        if (_works is null || hits.Count == 0) return [];
        var keys = hits.Select(h => h.WorkKey).ToHashSet(StringComparer.Ordinal);
        var names = hits.Select(h => WorkKeys.WorkKeyFor(h.Title, null)).Where(k => k.Length > 0).ToHashSet(StringComparer.Ordinal);
        var ids = hits.SelectMany(h => (h.ExternalIds?.Values ?? []).Append(h.ProviderId)).OfType<string>()
            .Select(v => v.Trim()).Where(v => v.Length > 0).Distinct().ToList();
        var identities = hits.SelectMany(h => (h.ExternalIds ?? new Dictionary<string, string>()).Select(p => (Provider: p.Key, Id: p.Value))
                .Append((Provider: h.Provider, Id: h.ProviderId ?? "")))
            .Where(x => !string.IsNullOrWhiteSpace(x.Id)).Select(x => StoredWork.Id(x.Provider, x.Id)).ToHashSet(StringComparer.OrdinalIgnoreCase);
        try
        {
            await using var db = await _works.CreateDbContextAsync(ct).ConfigureAwait(false);
            // A library holds hundreds of works, so its keys and canonical ids are matched in memory, from one reading shared
            // by searches for a short while: "doctor-who-1963-tv" and "doctor-who-2005-tv-tmdb57243" are keys of
            // "doctor-who", and a work stored under another name ("money-heist-2017") is still the record whose IMDb id it keeps.
            foreach (var (key, name, known) in (await StoredIndexAsync(db, ct).ConfigureAwait(false)).Works)
                if (names.Contains(name) || known.Overlaps(identities))
                    keys.Add(key);
            var linked = db.WorkLinks.Where(l => l.Verified && !l.Rejected && ids.Contains(l.ExternalId)).Select(l => l.WorkId);
            var works = await db.Works.AsNoTracking().Include(w => w.Links.Where(l => l.Verified && !l.Rejected))
                .Where(w => keys.Contains(w.WorkKey) || (w.ProviderId != null && ids.Contains(w.ProviderId)) || linked.Contains(w.Id))
                .ToListAsync(ct).ConfigureAwait(false);
            return works.Select(w => new StoredWork(w.WorkKey, w.Year, w.MediaType != "movie", WorkIdentities.Of(w))
                { Own = WorkIdentities.Of(w.ReadIds(), w.Provider, w.ProviderId) }).ToList();
        }
        catch (Exception e) when (!ct.IsCancellationRequested && e is DbUpdateException or InvalidOperationException or Microsoft.Data.Sqlite.SqliteException)
        {
            return [];
        }
    }

    /// <summary>
    /// The stored works' keys, names and canonical ids, read again only when a work was added, removed, re-keyed or got
    /// other ids since (<see cref="WorkIdentities.Version"/>) or after <see cref="StoredIndexTtl"/>, so one reading serves every
    /// search and enrichment lookup in between. Each search still loads the works it matches afresh, ids and links included.
    /// </summary>
    private async Task<StoredIndex> StoredIndexAsync(TorrentFlowDbContext db, CancellationToken ct)
    {
        var version = WorkIdentities.Version;
        var now = _time.GetUtcNow();
        if (_storedIndex is { } index && index.Version == version && now - index.ReadAt < StoredIndexTtl) return index;
        var rows = await db.Works.AsNoTracking().Select(w => new { w.WorkKey, w.IdsJson }).ToListAsync(ct).ConfigureAwait(false);
        var read = new StoredIndex(version, now, rows.Select(r => (r.WorkKey, WorkKeySlug.NameOf(r.WorkKey), WorkIdentities.Of(WorkIds.FromJson(r.IdsJson)))).ToList());
        _storedIndex = read;
        return read;
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
        var stored = await StoredWorksAsync(merged, ct).ConfigureAwait(false);
        var ranked = SearchRanking.Rank(merged, query, await AwaitImdbRanks(imdbRanks, ct).ConfigureAwait(false), _time.GetUtcNow(), stored);
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
