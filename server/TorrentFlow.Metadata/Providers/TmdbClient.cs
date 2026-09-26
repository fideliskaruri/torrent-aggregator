using System.Globalization;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Options;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Metadata.Text;

namespace TorrentFlow.Metadata.Providers;

public sealed record TmdbCandidate(int Id, string MediaType, string Title, int? Year, string? PosterUrl, string? BackdropUrl, double Popularity, int VoteCount);

/// <summary>Port of src/lib/metadata/tmdb.ts.</summary>
public sealed partial class TmdbClient(IHttpClientFactory httpFactory, IOptions<MetadataOptions> options, TimeProvider time,
    ITmdbCredentialProvider? credentials = null)
{
    public const string HttpClientName = "TorrentFlow.Metadata";
    public const string Base = "https://api.themoviedb.org/3";
    public const string Img = "https://image.tmdb.org/t/p";

    [GeneratedRegex(@"^(\d{4})-(\d{2})-(\d{2})\b")] private static partial Regex IsoDate();

    public static readonly IReadOnlyDictionary<int, string> Genres = new Dictionary<int, string>
    {
        [12] = "Adventure", [14] = "Fantasy", [16] = "Animation", [18] = "Drama", [27] = "Horror", [28] = "Action", [35] = "Comedy",
        [36] = "History", [37] = "Western", [53] = "Thriller", [80] = "Crime", [99] = "Documentary", [878] = "Science Fiction",
        [9648] = "Mystery", [10402] = "Music", [10749] = "Romance", [10751] = "Family", [10752] = "War", [10759] = "Action & Adventure",
        [10762] = "Kids", [10763] = "News", [10764] = "Reality", [10765] = "Sci-Fi & Fantasy", [10766] = "Soap", [10767] = "Talk",
        [10768] = "War & Politics", [10770] = "TV Movie",
    };

    public static string NormalizeCredential(string? value) => TorrentFlow.Core.Sources.TmdbCredentials.Normalize(value);
    public static bool IsUsableKey(string? value) => TorrentFlow.Core.Sources.TmdbCredentials.IsUsable(value);

    public string? ApiKey => TorrentFlow.Core.Sources.SourceExecution.Current is { Kind: "metadata", Type: "tmdb", Credential: { } current } && IsUsableKey(current)
        ? NormalizeCredential(current) : credentials is not null ? credentials.ApiKey :
        IsUsableKey(options.Value.TmdbApiKey) ? NormalizeCredential(options.Value.TmdbApiKey) : null;
    public long CredentialRevision => credentials?.Revision ?? 0;
    public bool HasKey => ApiKey != null;

    private static bool IsV4Token(string value) => value.Length > 80 && value.Split('.').Length == 3;

    /// <summary>Builds a request with the TMDB credential applied (Bearer for v4 tokens, api_key otherwise).</summary>
    public static HttpRequestMessage BuildRequest(string credential, string url, IEnumerable<(string, string)> query)
    {
        var pairs = query.ToList();
        var headers = IsV4Token(credential);
        if (!headers) pairs.Insert(0, ("api_key", credential));
        var request = new HttpRequestMessage(HttpMethod.Get, pairs.Count > 0 ? $"{url}?{TextUtil.BuildQuery(pairs)}" : url);
        if (headers)
        {
            request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", credential);
        }
        return request;
    }

    public static string? PosterUrl(string? path) => string.IsNullOrEmpty(path) ? null : $"{Img}/w500{path}";
    public static string? BackdropUrl(string? path) => string.IsNullOrEmpty(path) ? null : $"{Img}/w1280{path}";
    public static string? ProfileUrl(string? path) => string.IsNullOrEmpty(path) ? null : $"{Img}/w185{path}";
    public static string? StillUrl(string? path) => string.IsNullOrEmpty(path) ? null : $"{Img}/w300{path}";

    public static string? NormalizeDate(string? releaseDate, string? firstAirDate)
    {
        var raw = (!string.IsNullOrEmpty(releaseDate) ? releaseDate : firstAirDate ?? "").Trim();
        var m = IsoDate().Match(raw);
        if (!m.Success) return null;
        var year = int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture);
        return year is > 1800 and < 2200 ? $"{m.Groups[1].Value}-{m.Groups[2].Value}-{m.Groups[3].Value}" : null;
    }

    private async Task<JsonDocument?> GetJsonAsync(string path, IEnumerable<(string, string)> query, TimeSpan timeout, bool throwOnHttpError, CancellationToken ct)
    {
        var key = ApiKey;
        if (key == null) return null;
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(timeout < TimeSpan.FromMilliseconds(1) ? TimeSpan.FromMilliseconds(1) : timeout);
        using var request = BuildRequest(key, $"{Base}{path}", query);
        using var client = httpFactory.CreateClient(HttpClientName);
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cts.Token).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            if (throwOnHttpError) throw new HttpRequestException($"TMDB HTTP {(int)response.StatusCode}");
            return null;
        }
        return await TorrentFlow.Core.Http.BoundedHttpContent.ReadJsonAsync(response.Content, cts.Token).ConfigureAwait(false);
    }

    private static IEnumerable<(string, string)> SearchParams(string q) =>
        [("query", q), ("include_adult", "false"), ("language", "en-US"), ("page", "1")];

    /// <summary>search/multi with discovery-variant rescue (10s deadline).</summary>
    public Task<List<MediaMetadata>> SearchAsync(string query, int limit = 5, CancellationToken ct = default) =>
        SearchWithVariantsAsync("multi", query, limit, ct);

    /// <summary>search/{movie|tv} with discovery-variant rescue (10s deadline).</summary>
    public Task<List<MediaMetadata>> SearchByTypeAsync(string mediaType, string query, int limit = 12, CancellationToken ct = default) =>
        SearchWithVariantsAsync(mediaType, query, limit, ct);

    private async Task<List<MediaMetadata>> SearchWithVariantsAsync(string scope, string query, int limit, CancellationToken ct)
    {
        var term = QueryVariants.Canonicalize(query);
        if (ApiKey == null || term.Length == 0) return [];
        var deadline = time.GetUtcNow().AddSeconds(10);

        async Task<List<MediaMetadata>> Run(string q)
        {
            using var doc = await GetJsonAsync($"/search/{scope}", SearchParams(q), deadline - time.GetUtcNow(), true, ct).ConfigureAwait(false);
            var results = Results(doc);
            if (scope == "multi")
                return results.Where(r => Str(r, "media_type") is "movie" or "tv").Take(limit).Select(r => MapResult(r, null)).ToList();
            return results.Take(limit).Select(r => MapResult(r, scope)).ToList();
        }

        var primary = await Run(term).ConfigureAwait(false);
        if (HasRelevant(term, primary)) return primary;
        var collected = new List<MediaMetadata>(primary);
        foreach (var variant in QueryVariants.SearchDiscoveryVariants(term))
        {
            if (string.Equals(variant, term, StringComparison.OrdinalIgnoreCase)) continue;
            if (time.GetUtcNow() >= deadline) break;
            try
            {
                var hits = await Run(variant).ConfigureAwait(false);
                collected.AddRange(hits);
                if (HasRelevant(term, hits)) break;
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested) { break; }
        }
        return RankMetadata(term, collected).Take(limit).ToList();
    }

    public static bool HasRelevant(string query, IEnumerable<MediaMetadata> items) =>
        items.Any(i => Relevance.HasRelevantTitle(query, new[] { i.Title }.Concat(i.Aliases ?? [])));

    public static IEnumerable<MediaMetadata> RankMetadata(string query, IReadOnlyList<MediaMetadata> items) =>
        items.Select((item, index) => (item, index, tier: Relevance.BestTier(query, new[] { item.Title }.Concat(item.Aliases ?? []))))
            .OrderBy(x => x.tier).ThenBy(x => x.index).Select(x => x.item);

    public async Task<MediaMetadata?> GetByIdAsync(string mediaType, string id, CancellationToken ct = default)
    {
        try
        {
            using var doc = await GetJsonAsync($"/{mediaType}/{Uri.EscapeDataString(id)}", [("language", "en-US")], TimeSpan.FromSeconds(10), false, ct).ConfigureAwait(false);
            return doc == null ? null : MapDetail(doc.RootElement, mediaType);
        }
        catch (Exception e) when (e is HttpRequestException or OperationCanceledException or JsonException && !ct.IsCancellationRequested)
        {
            return null;
        }
    }

    public async Task<List<TmdbCandidate>> SearchCandidatesAsync(string scope, string query, int? year = null, int limit = 8, int timeoutMs = 5000, CancellationToken ct = default)
    {
        var term = query.Trim();
        if (ApiKey == null || term.Length == 0) return [];
        var q = SearchParams(term).ToList();
        if (year is { } y && y != 0 && scope == "movie") q.Add(("year", y.ToString(CultureInfo.InvariantCulture)));
        if (year is { } y2 && y2 != 0 && scope == "tv") q.Add(("first_air_date_year", y2.ToString(CultureInfo.InvariantCulture)));
        try
        {
            using var doc = await GetJsonAsync($"/search/{scope}", q, TimeSpan.FromMilliseconds(timeoutMs), false, ct).ConfigureAwait(false);
            return Results(doc)
                .Where(r => scope switch
                {
                    "movie" => Str(r, "media_type") != "tv",
                    "tv" => Str(r, "media_type") != "movie",
                    _ => Str(r, "media_type") is "movie" or "tv",
                })
                .Take(limit)
                .Select(r =>
                {
                    var mt = Str(r, "media_type") is "tv" or "movie" ? Str(r, "media_type")! : scope == "tv" ? "tv" : "movie";
                    return new TmdbCandidate(Int(r, "id") ?? 0, mt, Str(r, "title").OrEmpty(Str(r, "name")) ?? "",
                        YearOf(Str(r, "release_date").OrEmpty(Str(r, "first_air_date"))),
                        PosterUrl(Str(r, "poster_path")), BackdropUrl(Str(r, "backdrop_path")), Num(r, "popularity") ?? 0, Int(r, "vote_count") ?? 0);
                })
                .ToList();
        }
        catch (Exception e) when (e is HttpRequestException or OperationCanceledException or JsonException && !ct.IsCancellationRequested)
        {
            return [];
        }
    }

    /// <summary>fetchTmdbDetail: detail with credits and release_dates/content_ratings appended. Returns the raw JSON root.</summary>
    public async Task<JsonElement?> FetchDetailAsync(string mediaType, int id, int timeoutMs = 5000, CancellationToken ct = default)
    {
        try
        {
            using var doc = await GetJsonAsync($"/{mediaType}/{id}",
                [("language", "en-US"), ("append_to_response", mediaType == "movie" ? "credits,release_dates" : "credits,content_ratings")],
                TimeSpan.FromMilliseconds(timeoutMs), false, ct).ConfigureAwait(false);
            return doc?.RootElement.Clone();
        }
        catch (Exception e) when (e is HttpRequestException or OperationCanceledException or JsonException && !ct.IsCancellationRequested)
        {
            return null;
        }
    }

    public async Task<JsonElement?> FetchSeasonAsync(int id, int seasonNumber, int timeoutMs = 5000, CancellationToken ct = default)
    {
        try
        {
            using var doc = await GetJsonAsync($"/tv/{id}/season/{seasonNumber}", [("language", "en-US")], TimeSpan.FromMilliseconds(timeoutMs), false, ct).ConfigureAwait(false);
            return doc?.RootElement.Clone();
        }
        catch (Exception e) when (e is HttpRequestException or OperationCanceledException or JsonException && !ct.IsCancellationRequested)
        {
            return null;
        }
    }

    /// <summary>GET arbitrary TMDB path (used by recommendations); null on any failure.</summary>
    public async Task<JsonElement?> TryGetAsync(string path, IEnumerable<(string, string)> query, int timeoutMs, CancellationToken ct = default)
    {
        try
        {
            using var doc = await GetJsonAsync(path, query, TimeSpan.FromMilliseconds(timeoutMs), false, ct).ConfigureAwait(false);
            return doc?.RootElement.Clone();
        }
        catch (Exception e) when (e is HttpRequestException or OperationCanceledException or JsonException && !ct.IsCancellationRequested)
        {
            return null;
        }
    }

    private static IEnumerable<JsonElement> Results(JsonDocument? doc) =>
        doc != null && doc.RootElement.ValueKind == JsonValueKind.Object && doc.RootElement.TryGetProperty("results", out var r) && r.ValueKind == JsonValueKind.Array
            ? r.EnumerateArray().Select(e => e.Clone()).ToList()
            : [];

    public static MediaMetadata MapResult(JsonElement r, string? forcedType)
    {
        var mediaType = forcedType ?? (Str(r, "media_type") == "tv" ? "tv" : "movie");
        var id = Int(r, "id") ?? 0;
        var title = Str(r, "title").OrEmpty(Str(r, "name")) ?? $"TMDB #{id}";
        var genres = new List<string>();
        if (r.TryGetProperty("genre_ids", out var g) && g.ValueKind == JsonValueKind.Array)
            foreach (var x in g.EnumerateArray())
                if (x.TryGetInt32(out var gid) && Genres.TryGetValue(gid, out var name)) genres.Add(name);
        return new MediaMetadata
        {
            Source = "tmdb",
            MediaType = mediaType,
            ExternalId = id.ToString(CultureInfo.InvariantCulture),
            Title = title,
            Aliases = Distinct(title, Str(r, "original_title"), Str(r, "original_name")),
            PosterUrl = PosterUrl(Str(r, "poster_path")),
            BackdropUrl = BackdropUrl(Str(r, "backdrop_path")),
            Synopsis = Str(r, "overview").OrEmpty(null),
            Rating = Num(r, "vote_average"),
            Year = YearOf(Str(r, "release_date").OrEmpty(Str(r, "first_air_date"))),
            ReleaseDate = NormalizeDate(Str(r, "release_date"), Str(r, "first_air_date")),
            Genres = genres,
            OriginalLanguage = Str(r, "original_language"),
            OriginCountry = StrArray(r, "origin_country"),
        };
    }

    public static MediaMetadata MapDetail(JsonElement r, string mediaType)
    {
        var id = Int(r, "id") ?? 0;
        var title = Str(r, "title").OrEmpty(Str(r, "name")) ?? $"TMDB #{id}";
        var genres = new List<string>();
        if (r.TryGetProperty("genres", out var g) && g.ValueKind == JsonValueKind.Array)
            foreach (var x in g.EnumerateArray())
                if (Str(x, "name") is { } n) genres.Add(n);
        return new MediaMetadata
        {
            Source = "tmdb",
            MediaType = mediaType,
            ExternalId = id.ToString(CultureInfo.InvariantCulture),
            Title = title,
            Aliases = Distinct(title, Str(r, "original_title"), Str(r, "original_name")),
            PosterUrl = PosterUrl(Str(r, "poster_path")),
            BackdropUrl = BackdropUrl(Str(r, "backdrop_path")),
            Synopsis = Str(r, "overview").OrEmpty(null),
            Rating = Num(r, "vote_average"),
            Year = YearOf(Str(r, "release_date").OrEmpty(Str(r, "first_air_date"))),
            ReleaseDate = NormalizeDate(Str(r, "release_date"), Str(r, "first_air_date")),
            Genres = genres,
            OriginalLanguage = Str(r, "original_language"),
            OriginCountry = StrArray(r, "origin_country"),
        };
    }

    private static List<string> Distinct(params string?[] values) =>
        values.Select(v => v?.Trim()).Where(v => !string.IsNullOrEmpty(v)).Distinct(StringComparer.Ordinal).ToList()!;

    public static int? YearOf(string? date)
    {
        if (string.IsNullOrEmpty(date) || date.Length < 4) return null;
        return int.TryParse(date.AsSpan(0, 4), NumberStyles.None, CultureInfo.InvariantCulture, out var y) ? y : null;
    }

    public static string? Str(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    public static int? Int(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var i) ? i : null;

    public static double? Num(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDouble() : null;

    public static List<string> StrArray(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Array
            ? v.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.String).Select(x => x.GetString()!).ToList()
            : [];
}

public static class StringExtensions
{
    /// <summary>JS <c>a || b</c> for strings.</summary>
    public static string? OrEmpty(this string? value, string? fallback) => string.IsNullOrEmpty(value) ? (string.IsNullOrEmpty(fallback) ? null : fallback) : value;
}
