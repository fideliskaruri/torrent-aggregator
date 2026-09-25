using System.Globalization;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Metadata.Caching;
using TorrentFlow.Metadata.Text;
using static TorrentFlow.Metadata.Providers.TmdbClient;

namespace TorrentFlow.Metadata.Providers;

public sealed record AniListWork(MediaMetadata Metadata, string? Format, bool IsSeries, int? EpisodeCount);

public sealed class AniListHttpException(int status) : HttpRequestException($"AniList HTTP {status}")
{
    public int Status { get; } = status;
}

/// <summary>Port of src/lib/metadata/anilist.ts (search-latency version: single-flight + 60s memo).</summary>
public sealed partial class AniListClient(IHttpClientFactory httpFactory, TimeProvider time)
{
    public const string Url = "https://graphql.anilist.co";
    private static readonly int[] RetryDelaysMs = [50, 100];

    private const string MediaFields = """
      id
      title { romaji english native }
      coverImage { large extraLarge }
      bannerImage
      description(asHtml: false)
      averageScore
      seasonYear
      startDate { year month day }
      genres
      format
      episodes
      nextAiringEpisode { episode }
""";

    private const string SearchQuery = "query ($search: String, $perPage: Int) {\n  Page(page: 1, perPage: $perPage) {\n    media(search: $search, type: ANIME, sort: SEARCH_MATCH) {\n" + MediaFields + "    }\n  }\n}\n";
    private const string ByIdQuery = "query ($id: Int) {\n  Media(id: $id, type: ANIME) {\n" + MediaFields + "  }\n}\n";
    private const string RecommendationsQuery = "query ($search: String, $perPage: Int) {\n  Page(page: 1, perPage: 8) {\n    media(search: $search, type: ANIME, sort: SEARCH_MATCH) {\n      id\n      coverImage { large extraLarge }\n      recommendations(sort: RATING_DESC, perPage: $perPage) {\n        nodes {\n          mediaRecommendation {\n" + MediaFields + "          }\n        }\n      }\n    }\n  }\n}\n";

    private readonly SingleFlight<List<JsonElement>> _inFlight = new();
    private readonly BoundedTtlCache<List<JsonElement>> _recent = new(300, time);
    private static readonly TimeSpan QueryTtl = TimeSpan.FromSeconds(60);

    public void ResetQueryCache() => _recent.Clear();

    public async Task<List<MediaMetadata>> SearchAsync(string search, int perPage = 5, CancellationToken ct = default) =>
        (await FetchMediaAsync(search, perPage, ct).ConfigureAwait(false)).Select(Map).ToList();

    public async Task<List<AniListWork>> SearchWorksAsync(string search, int perPage = 12, CancellationToken ct = default) =>
        (await FetchMediaAsync(search, perPage, ct).ConfigureAwait(false)).Select(ToWork).ToList();

    public static AniListWork ToWork(JsonElement m)
    {
        var format = Str(m, "format");
        return new AniListWork(Map(m), format, format != "MOVIE", EpisodeCount(m));
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
                    if ((status == 429 || status >= 500) && attempt < RetryDelaysMs.Length && time.GetUtcNow().AddMilliseconds(RetryDelaysMs[attempt]) < deadline)
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

    private async Task<HttpResponseMessage> PostAsync(string query, JsonObject variables, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, Url)
        {
            Content = JsonContent.Create(new JsonObject { ["query"] = query, ["variables"] = variables }),
        };
        request.Headers.Accept.ParseAdd("application/json");
        using var client = httpFactory.CreateClient(HttpClientName);
        return await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
    }

    private static IEnumerable<string> Titles(JsonElement m)
    {
        if (!m.TryGetProperty("title", out var t) || t.ValueKind != JsonValueKind.Object) yield break;
        foreach (var k in new[] { "english", "romaji", "native" })
            if (Str(t, k) is { } s && !string.IsNullOrWhiteSpace(s)) yield return s;
    }

    private static bool HasRelevant(string q, IEnumerable<JsonElement> media) => media.Any(m => Relevance.HasRelevantTitle(q, Titles(m)));

    public async Task<AniListWork?> GetWorkByIdAsync(string id, CancellationToken ct = default)
    {
        if (!int.TryParse(id, NumberStyles.Integer, CultureInfo.InvariantCulture, out var numeric)) return null;
        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(TimeSpan.FromSeconds(10));
            using var response = await PostAsync(ByIdQuery, new JsonObject { ["id"] = numeric }, cts.Token).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode) return null;
            using var doc = await TorrentFlow.Core.Http.BoundedHttpContent.ReadJsonAsync(response.Content, cts.Token).ConfigureAwait(false);
            if (doc.RootElement.TryGetProperty("data", out var data) && data.TryGetProperty("Media", out var media) && media.ValueKind == JsonValueKind.Object)
                return ToWork(media.Clone());
            return null;
        }
        catch (Exception e) when (e is HttpRequestException or OperationCanceledException or JsonException && !ct.IsCancellationRequested)
        {
            return null;
        }
    }

    public async Task<MediaMetadata?> GetByIdAsync(string id, CancellationToken ct = default) => (await GetWorkByIdAsync(id, ct).ConfigureAwait(false))?.Metadata;

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
            PosterUrl = Cover(m),
            BackdropUrl = Str(m, "bannerImage").OrEmpty(null),
            Synopsis = StripHtml(Str(m, "description")),
            Rating = ScoreTo10(Num(m, "averageScore")),
            Year = year,
            ReleaseDate = StartDate(m),
            Genres = StrArray(m, "genres"),
        };
    }
}
