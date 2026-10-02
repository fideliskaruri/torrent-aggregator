using System.Globalization;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Options;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Metadata.Caching;
using TorrentFlow.Metadata.Text;

namespace TorrentFlow.Metadata.Providers;

public sealed record TmdbCandidate(int Id, string MediaType, string Title, int? Year, string? PosterUrl, string? BackdropUrl, double Popularity, int VoteCount);

/// <summary>Port of src/lib/metadata/tmdb.ts.</summary>
public sealed partial class TmdbClient(IHttpClientFactory httpFactory, IOptions<MetadataOptions> options, TimeProvider time,
    ITmdbCredentialProvider? credentials = null)
{
    public const string HttpClientName = "TorrentFlow.Metadata";
    public const string Base = "https://api.themoviedb.org/3";

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

    /// <summary>The configured TMDB image root (MetadataOptions.TmdbImageBaseUrl).</summary>
    public string ImageBase => options.Value.TmdbImageBaseUrl;

    /// <summary>A TMDB file path as an image URL sized for its role.</summary>
    public string? ImageUrl(string? path, Artwork.ArtRole role) => Artwork.TmdbImages.Url(ImageBase, path, role);

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
            if (throwOnHttpError) throw new HttpRequestException($"TMDB HTTP {(int)response.StatusCode}", null, response.StatusCode);
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

    private readonly BoundedTtlCache<List<string>> alternativeTitles = new(500, time);
    private readonly SingleFlight<List<string>> alternativeTitlesFlight = new();

    /// <summary>Every title TMDB lists for a film or show in other countries and scripts ("Gisaengchung" for Parasite).
    /// Cached a day per key revision and title; an empty answer or failure only for a minute.</summary>
    public async Task<List<string>> AlternativeTitlesAsync(string mediaType, string id, CancellationToken ct = default)
    {
        if (ApiKey is not { } credential) return [];
        var type = mediaType == "tv" ? "tv" : "movie";
        // The revision tracks saved keys; the hash covers a key a source run supplies itself.
        var key = $"{CredentialRevision}:{credential.GetHashCode()}:{type}:{id}";
        if (alternativeTitles.TryGet(key, out var cached)) return cached;
        return await alternativeTitlesFlight.RunAsync(key, async () =>
        {
            List<string> found = [];
            try
            {
                // The shared lookup is not tied to one caller's request; its own timeout bounds it.
                using var doc = await GetJsonAsync($"/{type}/{Uri.EscapeDataString(id)}/alternative_titles", [],
                    TimeSpan.FromSeconds(4), false, CancellationToken.None).ConfigureAwait(false);
                // Films list them under "titles", shows under "results".
                var root = doc?.RootElement ?? default;
                var rows = root.ValueKind != JsonValueKind.Object ? default
                    : root.TryGetProperty("titles", out var titles) ? titles : root.TryGetProperty("results", out var results) ? results : default;
                if (rows.ValueKind == JsonValueKind.Array)
                    found = rows.EnumerateArray().Select(r => Str(r, "title")).OfType<string>().Where(t => t.Trim().Length > 0).Distinct().ToList();
            }
            catch (Exception e) when (e is HttpRequestException or JsonException or OperationCanceledException) { }
            alternativeTitles.Set(key, found, found.Count > 0 ? TimeSpan.FromDays(1) : TimeSpan.FromMinutes(1));
            return found;
        }, ct).ConfigureAwait(false);
    }

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

    public async Task<MediaMetadata?> GetByIdAsync(string mediaType, string id, CancellationToken ct = default) =>
        (await LookupByIdAsync(mediaType, id, ct).ConfigureAwait(false)).Metadata;

    /// <summary>The TMDB record with this id and how the lookup went: only a record or a 404 is TMDB's answer.</summary>
    public async Task<(ProviderLookup Outcome, MediaMetadata? Metadata)> LookupByIdAsync(string mediaType, string id, CancellationToken ct = default)
    {
        try
        {
            using var doc = await GetJsonAsync($"/{mediaType}/{Uri.EscapeDataString(id)}",
                [("language", "en-US"), ("append_to_response", "alternative_titles,external_ids")], TimeSpan.FromSeconds(10), true, ct).ConfigureAwait(false);
            return doc == null ? (ProviderLookup.Failed, null) : (ProviderLookup.Found, MapDetail(doc.RootElement, mediaType));
        }
        catch (HttpRequestException e) when (e.StatusCode is System.Net.HttpStatusCode.NotFound) { return (ProviderLookup.NotFound, null); }
        catch (HttpRequestException e) when (e.StatusCode is System.Net.HttpStatusCode.TooManyRequests) { return (ProviderLookup.RateLimited, null); }
        catch (Exception e) when (e is HttpRequestException or OperationCanceledException or JsonException && !ct.IsCancellationRequested)
        {
            return (ProviderLookup.Failed, null);
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
                        ImageUrl(Str(r, "poster_path"), Artwork.ArtRole.Poster), ImageUrl(Str(r, "backdrop_path"), Artwork.ArtRole.Backdrop), Num(r, "popularity") ?? 0, Int(r, "vote_count") ?? 0);
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

    public MediaMetadata MapResult(JsonElement r, string? forcedType)
    {
        var mediaType = forcedType ?? (Str(r, "media_type") == "tv" ? "tv" : "movie");
        var id = Int(r, "id") ?? 0;
        var title = Str(r, "title").OrEmpty(Str(r, "name")) ?? $"TMDB #{id}";
        var genres = new List<string>();
        if (r.TryGetProperty("genre_ids", out var g) && g.ValueKind == JsonValueKind.Array)
            foreach (var x in g.EnumerateArray())
                if (x.TryGetInt32(out var gid) && Genres.TryGetValue(gid, out var name)) genres.Add(name);
        return WithNames(r, new MediaMetadata
        {
            Source = "tmdb",
            MediaType = mediaType,
            ExternalId = id.ToString(CultureInfo.InvariantCulture),
            Title = title,
            Aliases = Distinct(title, Str(r, "original_title"), Str(r, "original_name")),
            PosterUrl = ImageUrl(Str(r, "poster_path"), Artwork.ArtRole.Poster),
            BackdropUrl = ImageUrl(Str(r, "backdrop_path"), Artwork.ArtRole.Backdrop),
            Synopsis = Str(r, "overview").OrEmpty(null),
            Rating = Num(r, "vote_average"),
            Year = YearOf(Str(r, "release_date").OrEmpty(Str(r, "first_air_date"))),
            ReleaseDate = NormalizeDate(Str(r, "release_date"), Str(r, "first_air_date")),
            Genres = genres,
            OriginalLanguage = Str(r, "original_language"),
            OriginCountry = StrArray(r, "origin_country"),
        });
    }

    public MediaMetadata MapDetail(JsonElement r, string mediaType)
    {
        var id = Int(r, "id") ?? 0;
        var title = Str(r, "title").OrEmpty(Str(r, "name")) ?? $"TMDB #{id}";
        var genres = new List<string>();
        if (r.TryGetProperty("genres", out var g) && g.ValueKind == JsonValueKind.Array)
            foreach (var x in g.EnumerateArray())
                if (Str(x, "name") is { } n) genres.Add(n);
        return WithNames(r, new MediaMetadata
        {
            Source = "tmdb",
            MediaType = mediaType,
            ExternalId = id.ToString(CultureInfo.InvariantCulture),
            Title = title,
            Aliases = Distinct(title, Str(r, "original_title"), Str(r, "original_name")),
            PosterUrl = ImageUrl(Str(r, "poster_path"), Artwork.ArtRole.Poster),
            BackdropUrl = ImageUrl(Str(r, "backdrop_path"), Artwork.ArtRole.Backdrop),
            Synopsis = Str(r, "overview").OrEmpty(null),
            Rating = Num(r, "vote_average"),
            Year = YearOf(Str(r, "release_date").OrEmpty(Str(r, "first_air_date"))),
            ReleaseDate = NormalizeDate(Str(r, "release_date"), Str(r, "first_air_date")),
            Genres = genres,
            OriginalLanguage = Str(r, "original_language"),
            OriginCountry = StrArray(r, "origin_country"),
        });
    }

    /// <summary>
    /// TMDB's labelled names and ids: the title is English and the original title Original. An anime's Latin-script
    /// Japanese alternative titles (with <c>alternative_titles</c> appended) are its Romaji; <c>external_ids</c> gives the IMDb id.
    /// </summary>
    private static MediaMetadata WithNames(JsonElement r, MediaMetadata m)
    {
        var names = new List<WorkName> { new(m.Title, WorkNameKind.English) };
        if ((Str(r, "original_title") ?? Str(r, "original_name")) is { } original) names.Add(new(original, WorkNameKind.Original));
        if (AnimeIdentity.IsAnime(m) && r.TryGetProperty("alternative_titles", out var alt) && alt.ValueKind == JsonValueKind.Object)
            foreach (var list in new[] { "titles", "results" })
                if (alt.TryGetProperty(list, out var rows) && rows.ValueKind == JsonValueKind.Array)
                    foreach (var row in rows.EnumerateArray())
                        if (Str(row, "iso_3166_1") == "JP" && Str(row, "title") is { } romaji && WorkNames.IsLatin(romaji))
                            names.Add(new(romaji, WorkNameKind.Romaji));
        var imdb = (r.TryGetProperty("external_ids", out var ext) ? Str(ext, "imdb_id") : null) ?? Str(r, "imdb_id");
        var tvdb = ext.ValueKind == JsonValueKind.Object && Int(ext, "tvdb_id") is > 0 and var tvdbId ? tvdbId : (int?)null;
        var tmdb = int.TryParse(m.ExternalId, NumberStyles.Integer, CultureInfo.InvariantCulture, out var id) && id > 0 ? id : (int?)null;
        return m with { Names = [.. WorkNames.Of(names).All], Ids = new(Tmdb: tmdb, Imdb: string.IsNullOrWhiteSpace(imdb) ? null : imdb, Tvdb: tvdb) };
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
