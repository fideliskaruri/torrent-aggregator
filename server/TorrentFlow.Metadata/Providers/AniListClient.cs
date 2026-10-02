using System.Globalization;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Metadata.Caching;
using TorrentFlow.Metadata.Text;
using static TorrentFlow.Metadata.Providers.TmdbClient;

namespace TorrentFlow.Metadata.Providers;

/// <param name="Popularity">AniList list count (users who added the entry); ranks search results.</param>
/// <param name="Status">AniList status such as FINISHED, RELEASING or NOT_YET_RELEASED.</param>
public sealed record AniListWork(MediaMetadata Metadata, string? Format, bool IsSeries, int? EpisodeCount, int? AiredEpisodeCount = null,
    int? Popularity = null, string? Status = null);

public sealed class AniListHttpException(int status) : HttpRequestException($"AniList HTTP {status}")
{
    public int Status { get; } = status;
}

/// <summary>How an AniList by-id lookup went.</summary>
public enum AniListLookup { Found, NotFound, RateLimited, Failed }

/// <summary>One scheduled airing of an AniList entry's episode, in UTC.</summary>
public sealed record AniListAiring(int Episode, DateTime AiringAt);

/// <summary>Port of src/lib/metadata/anilist.ts (search-latency version: single-flight + 60s memo).</summary>
public sealed partial class AniListClient(IHttpClientFactory httpFactory, TimeProvider time, ILogger<AniListClient>? logger = null) : IProviderPacing
{
    public const string Url = "https://graphql.anilist.co";
    private static readonly int[] RetryDelaysMs = [50, 100];
    /// <summary>The longest a request waits for its turn at <see cref="Gate"/> before it is reported rate-limited.</summary>
    private static readonly TimeSpan MaxTurnWait = TimeSpan.FromSeconds(8);

    /// <summary>The one pace every AniList request of this process keeps.</summary>
    public AniListRateGate Gate { get; } = new(time);

    public DateTimeOffset? BlockedUntil(string provider) => provider == "anilist" ? Gate.BlockedUntil : null;

    private const string MediaFields = """
      id
      idMal
      title { romaji english native }
      synonyms
      coverImage { large extraLarge }
      bannerImage
      description(asHtml: false)
      averageScore
      seasonYear
      startDate { year month day }
      genres
      format
      countryOfOrigin
      status
      episodes
      popularity
      nextAiringEpisode { episode }
""";

    private const string SearchQuery = "query ($search: String, $perPage: Int) {\n  Page(page: 1, perPage: $perPage) {\n    media(search: $search, type: ANIME, sort: SEARCH_MATCH) {\n" + MediaFields + "    }\n  }\n}\n";
    private const string ByIdQuery = "query ($id: Int) {\n  Media(id: $id, type: ANIME) {\n" + MediaFields + "  }\n}\n";
    private const string FirstAiringAfterQuery = "query ($id: Int, $after: Int) {\n  Page(page: 1, perPage: 1) {\n    airingSchedules(mediaId: $id, airingAt_greater: $after, sort: TIME) { episode airingAt }\n  }\n}\n";
    private const string EpisodeAiringQuery = "query ($id: Int, $episode: Int) {\n  Page(page: 1, perPage: 1) {\n    airingSchedules(mediaId: $id, episode: $episode) { episode airingAt }\n  }\n}\n";
    private const string RecommendationsQuery = "query ($search: String, $perPage: Int) {\n  Page(page: 1, perPage: 8) {\n    media(search: $search, type: ANIME, sort: SEARCH_MATCH) {\n      id\n      coverImage { large extraLarge }\n      recommendations(sort: RATING_DESC, perPage: $perPage) {\n        nodes {\n          mediaRecommendation {\n" + MediaFields + "          }\n        }\n      }\n    }\n  }\n}\n";

    private const string BrowseQuery = "query ($sort: [MediaSort], $season: MediaSeason, $seasonYear: Int, $genre: String, $page: Int, $perPage: Int) {\n  Page(page: $page, perPage: $perPage) {\n    media(type: ANIME, isAdult: false, sort: $sort, season: $season, seasonYear: $seasonYear, genre: $genre) {\n" + MediaFields + "    }\n  }\n}\n";

    private readonly SingleFlight<List<JsonElement>> _inFlight = new();
    private readonly BoundedTtlCache<List<JsonElement>> _recent = new(300, time);
    private readonly BoundedTtlCache<AniListWork> _works = new(300, time);
    private readonly BoundedTtlCache<AniListAiring?> _airings = new(1000, time);
    private static readonly TimeSpan QueryTtl = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan WorkTtl = TimeSpan.FromMinutes(5);

    public void ResetQueryCache() { _recent.Clear(); _works.Clear(); _airings.Clear(); }

    public async Task<List<MediaMetadata>> SearchAsync(string search, int perPage = 5, CancellationToken ct = default) =>
        (await FetchMediaAsync(search, perPage, ct).ConfigureAwait(false)).Select(m => RememberWork(m).Metadata).ToList();

    public async Task<List<AniListWork>> SearchWorksAsync(string search, int perPage = 12, CancellationToken ct = default) =>
        (await FetchMediaAsync(search, perPage, ct).ConfigureAwait(false)).Select(RememberWork).ToList();

    private AniListWork RememberWork(JsonElement media)
    {
        var work = ToWork(media);
        if (int.TryParse(work.Metadata.ExternalId, out var id) && id > 0)
            _works.Set(id.ToString(CultureInfo.InvariantCulture), work, WorkTtl);
        return work;
    }

    public static AniListWork ToWork(JsonElement m)
    {
        var format = Str(m, "format");
        var count = EpisodeCount(m);
        int? aired = Str(m, "status") == "FINISHED" ? count : null;
        if (m.TryGetProperty("nextAiringEpisode", out var next) && next.ValueKind == JsonValueKind.Object &&
            Int(next, "episode") is > 0 and <= 5001 and var upcoming)
            aired = Math.Min(upcoming - 1, count ?? 5000);
        var status = Str(m, "status");
        if (status == "NOT_YET_RELEASED") aired = 0;
        return new AniListWork(Map(m), format, format != "MOVIE", count, aired, Int(m, "popularity"), status);
    }

    public static int? EpisodeCount(JsonElement m)
    {
        var total = Int(m, "episodes");
        if (total is >= 1 and <= 5000) return total;
        if (m.TryGetProperty("nextAiringEpisode", out var n) && n.ValueKind == JsonValueKind.Object && Int(n, "episode") is { } next && next > 1)
        {
            var aired = next - 1;
            if (aired is >= 1 and <= 5000) return aired;
        }
        return null;
    }

    private async Task<List<JsonElement>> FetchMediaAsync(string search, int perPage, CancellationToken ct)
    {
        var term = QueryVariants.Canonicalize(search);
        if (term.Length == 0) return [];
        var key = $"{perPage}:{term.ToLowerInvariant()}";
        if (_recent.TryGet(key, out var remembered)) return remembered;
        return await _inFlight.RunAsync(key, async () =>
        {
            var media = await FetchUncoalescedAsync(term, perPage, CancellationToken.None).ConfigureAwait(false);
            _recent.Set(key, media, QueryTtl);
            return media;
        }, ct).ConfigureAwait(false);
    }

    private async Task<List<JsonElement>> FetchUncoalescedAsync(string term, int perPage, CancellationToken ct)
    {
        var deadline = time.GetUtcNow().AddSeconds(10);

        async Task<List<JsonElement>> Run(string q)
        {
            for (var attempt = 0; ; attempt++)
            {
                var remaining = deadline - time.GetUtcNow();
                using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
                cts.CancelAfter(remaining < TimeSpan.FromMilliseconds(1) ? TimeSpan.FromMilliseconds(1) : remaining);
                using var response = await PostAsync(SearchQuery, new JsonObject { ["search"] = q, ["perPage"] = perPage }, cts.Token).ConfigureAwait(false);
                if (!response.IsSuccessStatusCode)
                {
                    var status = (int)response.StatusCode;
                    // A 429 is not retried here: the gate already holds every caller until AniList's Retry-After.
                    if (status >= 500 && attempt < RetryDelaysMs.Length && time.GetUtcNow().AddMilliseconds(RetryDelaysMs[attempt]) < deadline)
                    {
                        await Task.Delay(TimeSpan.FromMilliseconds(RetryDelaysMs[attempt]), time, ct).ConfigureAwait(false);
                        continue;
                    }
                    throw new AniListHttpException(status);
                }
                using var doc = await TorrentFlow.Core.Http.BoundedHttpContent.ReadJsonAsync(response.Content, cts.Token).ConfigureAwait(false);
                var root = doc.RootElement;
                if (root.TryGetProperty("errors", out var errors) && errors.ValueKind == JsonValueKind.Array && errors.GetArrayLength() > 0)
                    throw new InvalidOperationException(Str(errors[0], "message") ?? "AniList error");
                if (root.TryGetProperty("data", out var data) && data.TryGetProperty("Page", out var page) && page.ValueKind == JsonValueKind.Object &&
                    page.TryGetProperty("media", out var media) && media.ValueKind == JsonValueKind.Array)
                    return media.EnumerateArray().Select(e => e.Clone()).ToList();
                return [];
            }
        }

        var primary = await Run(term).ConfigureAwait(false);
        if (HasRelevant(term, primary)) return primary;
        var collected = new List<JsonElement>(primary);
        foreach (var variant in QueryVariants.SearchDiscoveryVariants(term))
        {
            if (string.Equals(variant, term, StringComparison.OrdinalIgnoreCase)) continue;
            if (time.GetUtcNow() >= deadline) break;
            try
            {
                var media = await Run(variant).ConfigureAwait(false);
                collected.AddRange(media);
                if (HasRelevant(term, media)) break;
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested) { break; }
        }
        return collected
            .Select((item, index) => (item, index, tier: Relevance.BestTier(term, Titles(item))))
            .OrderBy(x => x.tier).ThenBy(x => x.index).Select(x => x.item).Take(perPage).ToList();
    }

    /// <summary>Every AniList request goes out here, in its turn at <see cref="Gate"/>; one refused a turn is a synthetic 429.</summary>
    internal async Task<HttpResponseMessage> PostAsync(string query, JsonObject variables, CancellationToken ct, string? url = null)
    {
        // Background flows (ProviderPriority.Background) spend only the gate's background share; foreground never waits behind them.
        var background = ProviderPriority.IsBackground;
        var priority = background ? "Background" : "Foreground";
        var started = time.GetUtcNow();
        var (granted, waited, used, sent) = await Gate.WaitTurnAsync(MaxTurnWait, ct, background).ConfigureAwait(false);
        if (!granted)
        {
            logger?.LogInformation("{Priority} AniList request not sent: {Reason}; it is reported as rate-limited", priority, waited);
            return Gate.Refused();
        }
        if (waited != null)
            logger?.LogInformation("{Priority} AniList request waited {Ms:0} ms: {Reason}", priority, (time.GetUtcNow() - started).TotalMilliseconds, waited);
        if (background)
            logger?.LogInformation("Background AniList request sent ({Used} of its {Share} a minute; {Sent} AniList requests in the last minute)",
                used, Gate.BackgroundShare, sent);
        else
            logger?.LogDebug("Foreground AniList request sent after {Ms:0} ms ({Sent} AniList requests in the last minute, {Used} of them background)",
                (time.GetUtcNow() - started).TotalMilliseconds, sent, used);
        using var request = new HttpRequestMessage(HttpMethod.Post, url ?? Url)
        {
            Content = JsonContent.Create(new JsonObject { ["query"] = query, ["variables"] = variables }),
        };
        request.Headers.Accept.ParseAdd("application/json");
        using var client = httpFactory.CreateClient(HttpClientName);
        var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
        if (Gate.Observe(response) is { } until)
            logger?.LogWarning("AniList answered {Status} (limit {Limit}, remaining {Remaining}); every AniList request waits until {Until:HH:mm:ss}",
                (int)response.StatusCode, Header("X-RateLimit-Limit"), Header("X-RateLimit-Remaining"), until);
        return response;

        string? Header(string name) => response.Headers.TryGetValues(name, out var values) ? values.FirstOrDefault() : null;
    }

    private static IEnumerable<string> Titles(JsonElement m)
    {
        if (!m.TryGetProperty("title", out var t) || t.ValueKind != JsonValueKind.Object) yield break;
        foreach (var k in new[] { "english", "romaji", "native" })
            if (Str(t, k) is { } s && !string.IsNullOrWhiteSpace(s)) yield return s;
        foreach (var synonym in StrArray(m, "synonyms") ?? [])
            if (!string.IsNullOrWhiteSpace(synonym)) yield return synonym;
    }

    private static bool HasRelevant(string q, IEnumerable<JsonElement> media) => media.Any(m => Relevance.HasRelevantTitle(q, Titles(m)));

    /// <summary>The same names as <see cref="Titles"/>, in the same order, labelled.</summary>
    private static List<WorkName> Names(JsonElement m)
    {
        var names = new List<WorkName>();
        if (m.TryGetProperty("title", out var t) && t.ValueKind == JsonValueKind.Object)
            foreach (var (key, kind) in new[] { ("english", WorkNameKind.English), ("romaji", WorkNameKind.Romaji), ("native", WorkNameKind.Native) })
                if (Str(t, key) is { } s && !string.IsNullOrWhiteSpace(s)) names.Add(new(s, kind));
        foreach (var synonym in StrArray(m, "synonyms") ?? [])
            if (!string.IsNullOrWhiteSpace(synonym)) names.Add(new(synonym, WorkNames.IsNative(synonym) ? WorkNameKind.Native : WorkNameKind.Synonym));
        return [.. WorkNames.Of(names).All];
    }

    /// <summary>The AniList entry with this id, or null when it is unknown or AniList could not answer (see <see cref="LookupWorkAsync"/>).</summary>
    public async Task<AniListWork?> GetWorkByIdAsync(string id, CancellationToken ct = default) => (await LookupWorkAsync(id, ct).ConfigureAwait(false)).Work;

    /// <summary>The AniList entry with this id and how the lookup went: a 429 is <see cref="AniListLookup.RateLimited"/>, never "not found".</summary>
    public async Task<(AniListLookup Outcome, AniListWork? Work)> LookupWorkAsync(string id, CancellationToken ct = default)
    {
        ct.ThrowIfCancellationRequested();
        if (!int.TryParse(id, NumberStyles.Integer, CultureInfo.InvariantCulture, out var numeric) || numeric < 1) return (AniListLookup.NotFound, null);
        if (_works.TryGet(numeric.ToString(CultureInfo.InvariantCulture), out var cached)) return (AniListLookup.Found, cached);
        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(TimeSpan.FromSeconds(10));
            using var response = await PostAsync(ByIdQuery, new JsonObject { ["id"] = numeric }, cts.Token).ConfigureAwait(false);
            if (response.StatusCode == System.Net.HttpStatusCode.TooManyRequests) return (AniListLookup.RateLimited, null);
            if (response.StatusCode == System.Net.HttpStatusCode.NotFound) return (AniListLookup.NotFound, null);
            if (!response.IsSuccessStatusCode) return (AniListLookup.Failed, null);
            using var doc = await TorrentFlow.Core.Http.BoundedHttpContent.ReadJsonAsync(response.Content, cts.Token).ConfigureAwait(false);
            if (doc.RootElement.TryGetProperty("data", out var data) && data.TryGetProperty("Media", out var media) &&
                media.ValueKind == JsonValueKind.Object && Int(media, "id") == numeric)
                return (AniListLookup.Found, RememberWork(media.Clone()));
            return (AniListLookup.NotFound, null);
        }
        catch (Exception e) when (e is HttpRequestException or OperationCanceledException or JsonException && !ct.IsCancellationRequested)
        {
            return (AniListLookup.Failed, null);
        }
    }

    public async Task<MediaMetadata?> GetByIdAsync(string id, CancellationToken ct = default) => (await GetWorkByIdAsync(id, ct).ConfigureAwait(false))?.Metadata;

    /// <summary>One page of anime by AniList sort (POPULARITY_DESC, TRENDING_DESC, SCORE_DESC), optionally one season or genre. Empty on failure.</summary>
    public async Task<List<AniListWork>> BrowseAsync(string sort, string? season, int? seasonYear, string? genre, int perPage, CancellationToken ct = default, int page = 1)
    {
        var variables = new JsonObject { ["sort"] = new JsonArray(sort), ["perPage"] = Math.Clamp(perPage, 1, 50), ["page"] = Math.Max(page, 1) };
        if (season is not null && seasonYear is not null) { variables["season"] = season; variables["seasonYear"] = seasonYear; }
        if (genre is not null) variables["genre"] = genre;
        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(TimeSpan.FromSeconds(10));
            using var response = await PostAsync(BrowseQuery, variables, cts.Token).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode) return [];
            using var doc = await TorrentFlow.Core.Http.BoundedHttpContent.ReadJsonAsync(response.Content, cts.Token).ConfigureAwait(false);
            if (!doc.RootElement.TryGetProperty("data", out var data) || !data.TryGetProperty("Page", out var result) ||
                !result.TryGetProperty("media", out var media) || media.ValueKind != JsonValueKind.Array) return [];
            return media.EnumerateArray().Where(m => m.ValueKind == JsonValueKind.Object).Select(m => ToWork(m.Clone())).ToList();
        }
        catch (Exception e) when (e is HttpRequestException or OperationCanceledException or JsonException && !ct.IsCancellationRequested)
        {
            return [];
        }
    }

    /// <summary>
    /// The first episode of this AniList entry that airs after <paramref name="after"/>. <c>Answered</c> is false when
    /// AniList could not be asked; an answered null means AniList lists nothing after that moment.
    /// </summary>
    public Task<(bool Answered, AniListAiring? Airing)> GetFirstAiringAfterAsync(int id, DateTime after, CancellationToken ct = default)
    {
        var at = new DateTimeOffset(DateTime.SpecifyKind(after, DateTimeKind.Utc)).ToUnixTimeSeconds();
        return AiringAsync($"{id}:after:{at}", FirstAiringAfterQuery,
            new JsonObject { ["id"] = id, ["after"] = at }, TimeSpan.FromMinutes(30), TimeSpan.FromMinutes(30), ct);
    }

    /// <summary>When an episode of this AniList entry airs, or null when AniList has no schedule for it or cannot be asked.</summary>
    public async Task<DateTime?> GetEpisodeAiringAsync(int id, int episode, CancellationToken ct = default)
    {
        var (_, airing) = await AiringAsync($"{id}:episode:{episode}", EpisodeAiringQuery,
            new JsonObject { ["id"] = id, ["episode"] = episode }, TimeSpan.FromHours(1), TimeSpan.FromMinutes(10), ct).ConfigureAwait(false);
        return airing?.AiringAt;
    }

    private async Task<(bool Answered, AniListAiring? Airing)> AiringAsync(string key, string query, JsonObject variables,
        TimeSpan foundTtl, TimeSpan missingTtl, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        if (_airings.TryGet(key, out var cached)) return (true, cached);
        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(TimeSpan.FromSeconds(10));
            using var response = await PostAsync(query, variables, cts.Token).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode) return (false, null);
            using var doc = await TorrentFlow.Core.Http.BoundedHttpContent.ReadJsonAsync(response.Content, cts.Token).ConfigureAwait(false);
            var root = doc.RootElement;
            if (root.TryGetProperty("errors", out var errors) && errors.ValueKind == JsonValueKind.Array && errors.GetArrayLength() > 0) return (false, null);
            if (!root.TryGetProperty("data", out var data) || !data.TryGetProperty("Page", out var page) || page.ValueKind != JsonValueKind.Object ||
                !page.TryGetProperty("airingSchedules", out var rows) || rows.ValueKind != JsonValueKind.Array) return (false, null);
            AniListAiring? airing = null;
            foreach (var row in rows.EnumerateArray())
                if (row.ValueKind == JsonValueKind.Object && Int(row, "episode") is > 0 and var episode &&
                    Num(row, "airingAt") is { } seconds && seconds > 0)
                {
                    airing = new(episode, DateTimeOffset.FromUnixTimeSeconds((long)seconds).UtcDateTime);
                    break;
                }
            _airings.Set(key, airing, airing is null ? missingTtl : foundTtl);
            return (true, airing);
        }
        catch (Exception e) when (e is HttpRequestException or OperationCanceledException or JsonException && !ct.IsCancellationRequested)
        {
            return (false, null);
        }
    }

    public async Task<List<AniListWork>> RecommendationsForPosterAsync(string title, string? posterUrl, int limit = 12, CancellationToken ct = default)
    {
        var poster = posterUrl?.Trim();
        if (string.IsNullOrWhiteSpace(title) || string.IsNullOrEmpty(poster) || limit < 1) return [];
        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(TimeSpan.FromSeconds(8));
            using var response = await PostAsync(RecommendationsQuery,
                new JsonObject { ["search"] = QueryVariants.Canonicalize(title), ["perPage"] = Math.Min(limit, 24) }, cts.Token).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode) return [];
            using var doc = await TorrentFlow.Core.Http.BoundedHttpContent.ReadJsonAsync(response.Content, cts.Token).ConfigureAwait(false);
            var root = doc.RootElement;
            if (root.TryGetProperty("errors", out var errors) && errors.ValueKind == JsonValueKind.Array && errors.GetArrayLength() > 0) return [];
            if (!root.TryGetProperty("data", out var data) || !data.TryGetProperty("Page", out var page) || !page.TryGetProperty("media", out var mediaList) ||
                mediaList.ValueKind != JsonValueKind.Array) return [];
            var matches = mediaList.EnumerateArray().Where(m => Cover(m)?.Trim() == poster).ToList();
            if (matches.Count != 1) return [];
            var seen = new HashSet<int>();
            var output = new List<AniListWork>();
            if (matches[0].TryGetProperty("recommendations", out var recs) && recs.ValueKind == JsonValueKind.Object &&
                recs.TryGetProperty("nodes", out var nodes) && nodes.ValueKind == JsonValueKind.Array)
            {
                foreach (var node in nodes.EnumerateArray())
                {
                    if (node.ValueKind != JsonValueKind.Object || !node.TryGetProperty("mediaRecommendation", out var media) || media.ValueKind != JsonValueKind.Object) continue;
                    var mid = Int(media, "id") ?? 0;
                    if (!seen.Add(mid)) continue;
                    if (string.IsNullOrEmpty(Cover(media))) continue;
                    output.Add(ToWork(media.Clone()));
                }
            }
            return output;
        }
        catch (Exception e) when (e is HttpRequestException or OperationCanceledException or JsonException or InvalidOperationException && !ct.IsCancellationRequested)
        {
            return [];
        }
    }

    private static string? Cover(JsonElement m) =>
        m.TryGetProperty("coverImage", out var c) && c.ValueKind == JsonValueKind.Object ? Str(c, "extraLarge").OrEmpty(Str(c, "large")) : null;

    public static double? ScoreTo10(double? averageScore)
    {
        if (averageScore is not { } s || !double.IsFinite(s) || s <= 0 || s > 100) return null;
        return Math.Round(s, MidpointRounding.AwayFromZero) / 10;
    }

    public static string? StartDate(JsonElement m)
    {
        if (!m.TryGetProperty("startDate", out var sd) || sd.ValueKind != JsonValueKind.Object) return null;
        if (Int(sd, "year") is not { } year || year is <= 1800 or >= 2200) return null;
        var month = Int(sd, "month");
        var day = Int(sd, "day");
        if (month is >= 1 and <= 12 && day is >= 1 and <= 31) return $"{year:D4}-{month:D2}-{day:D2}";
        return $"{year:D4}-01-01";
    }

    [GeneratedRegex(@"<br\s*/?>", RegexOptions.IgnoreCase)] private static partial Regex Br();
    [GeneratedRegex(@"<[^>]+>")] private static partial Regex Tag();

    public static string? StripHtml(string? html)
    {
        if (string.IsNullOrEmpty(html)) return null;
        return Tag().Replace(Br().Replace(html, "\n"), "")
            .Replace("&amp;", "&").Replace("&lt;", "<").Replace("&gt;", ">").Replace("&quot;", "\"").Replace("&#39;", "'").Trim();
    }

    public static MediaMetadata Map(JsonElement m)
    {
        var id = Int(m, "id") ?? 0;
        var titles = Titles(m).ToList();
        var t = m.TryGetProperty("title", out var tt) && tt.ValueKind == JsonValueKind.Object ? tt : default;
        var title = (t.ValueKind == JsonValueKind.Object ? Str(t, "english").OrEmpty(Str(t, "romaji")).OrEmpty(Str(t, "native")) : null) ?? $"AniList #{id}";
        int? year = Int(m, "seasonYear");
        if (year == null && m.TryGetProperty("startDate", out var sd) && sd.ValueKind == JsonValueKind.Object) year = Int(sd, "year");
        return new MediaMetadata
        {
            Source = "anilist",
            MediaType = "anime",
            ExternalId = id.ToString(CultureInfo.InvariantCulture),
            Title = title,
            Aliases = titles.Select(x => x.Trim()).Where(x => x.Length > 0).Distinct(StringComparer.Ordinal).ToList(),
            Names = Names(m),
            Ids = new(AniList: id > 0 ? id : null, Mal: Int(m, "idMal") is > 0 and var mal ? mal : null),
            PosterUrl = Cover(m),
            BackdropUrl = Str(m, "bannerImage").OrEmpty(null),
            Synopsis = StripHtml(Str(m, "description")),
            Rating = ScoreTo10(Num(m, "averageScore")),
            Year = year,
            ReleaseDate = StartDate(m),
            Genres = StrArray(m, "genres"),
            Format = Str(m, "format").OrEmpty(null),
            OriginalLanguage = WorkFormats.LanguageOfCountry(Str(m, "countryOfOrigin")),
        };
    }
}
