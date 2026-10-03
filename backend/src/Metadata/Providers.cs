using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using TorrentFlow.Domain;

namespace TorrentFlow.Metadata;

internal sealed class TmdbClient(ProviderHttp http, CatalogStore store, MetadataPaths paths)
{
    internal async Task<bool> EnabledAsync(CancellationToken ct) => await CredentialAsync(ct) is not null;

    private async Task<string?> CredentialAsync(CancellationToken ct)
    {
        var setting = await store.SettingsAsync(ct);
        if (setting.TmdbCredential is not { } reference)
            return Environment.GetEnvironmentVariable("TMDB_API_KEY")?.Trim();
        if (Path.GetFileName(reference.FileId) != reference.FileId || reference.FileId.Contains("..", StringComparison.Ordinal))
            return null;
        var folder = Path.Combine(paths.DataDirectory, "secrets");
        var file = Path.Combine(folder, reference.FileId + ".secret");
        if (!File.Exists(file) || (File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0 ||
            (File.GetAttributes(folder) & FileAttributes.ReparsePoint) != 0) return null;
        return (await File.ReadAllTextAsync(file, ct)).Trim();
    }

    internal async Task<ProviderAnswer> GetAsync(string path, string query, CancellationToken ct, bool force = false,
        TimeSpan? ttl = null)
    {
        var credential = await CredentialAsync(ct);
        if (credential is null) return new(null, false, false,
            new("unconfigured", "Add a TMDB key in Settings to use this catalog.", null, true));
        var url = "https://api.themoviedb.org/3" + path + "?language=en-US&" + query;
        var bearer = credential.Length > 80;
        return await http.FetchAsync("tmdb", ProviderHttp.Id(credential) + ":" + path + "?" + query, () =>
        {
            var request = new HttpRequestMessage(HttpMethod.Get, bearer ? url : url + "&api_key=" + Uri.EscapeDataString(credential));
            if (bearer) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", credential);
            return request;
        }, ttl ?? TimeSpan.FromDays(7), ct, force: force,
            kind: path.StartsWith("/search/", StringComparison.Ordinal) ? CacheKind.TitleSearch : CacheKind.ProviderDetail);
    }

    internal Task<ProviderAnswer> SearchAsync(string title, WorkKind kind, int? year, CancellationToken ct) =>
        GetAsync("/search/" + JsonFacts.Kind(kind),
            "include_adult=false&query=" + Uri.EscapeDataString(title) +
            (year is { } y ? "&" + (kind == WorkKind.Series ? "first_air_date_year" : "year") + "=" + y : ""),
            ct, ttl: TimeSpan.FromMinutes(5));

    internal Task<ProviderAnswer> DetailAsync(string id, WorkKind kind, CancellationToken ct, bool force) =>
        GetAsync("/" + JsonFacts.Kind(kind) + "/" + Uri.EscapeDataString(id),
            "append_to_response=alternative_titles,external_ids," +
            (kind == WorkKind.Series ? "content_ratings" : "release_dates"), ct, force);

    internal Task<ProviderAnswer> SeasonAsync(string id, int number, CancellationToken ct, bool force) =>
        GetAsync("/tv/" + Uri.EscapeDataString(id) + "/season/" + number, "", ct, force,
            TimeSpan.FromHours(1));
}

internal sealed class AniListClient(ProviderHttp http)
{
    private const string Fields = """
        id idMal title { english romaji native } synonyms format status episodes duration
        countryOfOrigin startDate { year month day } seasonYear genres averageScore popularity
        description(asHtml:false) coverImage { extraLarge large } bannerImage
        nextAiringEpisode { episode airingAt }
        relations { edges { relationType node { id type format title { english romaji native } startDate { year month day } } } }
        """;

    internal Task<ProviderAnswer> QueryAsync(string query, object variables, CancellationToken ct,
        TimeSpan? ttl = null, bool force = false)
    {
        var body = new { query, variables };
        var key = JsonSerializer.Serialize(body, CatalogStore.Json);
        return http.FetchAsync("anilist", key, () => new(HttpMethod.Post, "https://graphql.anilist.co")
        {
            Content = JsonContent.Create(body),
        }, ttl ?? TimeSpan.FromSeconds(60), ct, force: force,
            kind: query.Contains("media(search:", StringComparison.Ordinal) ? CacheKind.TitleSearch : CacheKind.ProviderDetail);
    }

    internal Task<ProviderAnswer> SearchAsync(string title, int limit, CancellationToken ct) =>
        QueryAsync("query($search:String,$limit:Int){Page(page:1,perPage:$limit){media(search:$search,type:ANIME,isAdult:false,sort:SEARCH_MATCH){" +
            Fields + "}}}", new { search = title, limit = Math.Clamp(limit, 1, 50) }, ct);
    internal Task<ProviderAnswer> DetailAsync(string id, CancellationToken ct, bool force = false) =>
        QueryAsync("query($id:Int){Media(id:$id,type:ANIME){" + Fields + "}}",
            new { id = int.Parse(id, System.Globalization.CultureInfo.InvariantCulture) }, ct,
            TimeSpan.FromMinutes(30), force);
    internal Task<ProviderAnswer> AiringsAsync(string id, int page, CancellationToken ct, bool force) =>
        QueryAsync("query($id:Int,$page:Int){Page(page:$page,perPage:50){pageInfo{hasNextPage}airingSchedules(mediaId:$id,sort:EPISODE){episode airingAt}}}",
            new { id = int.Parse(id, System.Globalization.CultureInfo.InvariantCulture), page }, ct, TimeSpan.FromHours(1), force);
    internal Task<ProviderAnswer> BrowseAsync(string sort, string? genre, bool seasonal, CancellationToken ct, int page = 1)
    {
        var month = DateTimeOffset.Now.Month;
        var season = month <= 3 ? "WINTER" : month <= 6 ? "SPRING" : month <= 9 ? "SUMMER" : "FALL";
        var variables = new Dictionary<string, object> { ["sort"] = new[] { sort }, ["page"] = page, ["perPage"] = 50 };
        if (genre is not null) variables["genre"] = genre;
        if (seasonal) { variables["season"] = season; variables["seasonYear"] = DateTimeOffset.Now.Year; }
        return QueryAsync("query($sort:[MediaSort],$genre:String,$season:MediaSeason,$seasonYear:Int,$page:Int,$perPage:Int){Page(page:$page,perPage:$perPage){media(type:ANIME,isAdult:false,sort:$sort,genre:$genre,season:$season,seasonYear:$seasonYear){" +
            Fields + "}}}", variables, ct, TimeSpan.FromDays(1));
    }
    internal Task<ProviderAnswer> RecommendationsAsync(string id, CancellationToken ct) =>
        QueryAsync("query($id:Int){Media(id:$id){recommendations(sort:RATING_DESC,perPage:30){nodes{mediaRecommendation{" +
            Fields + "}}}}}", new { id = int.Parse(id, System.Globalization.CultureInfo.InvariantCulture) }, ct,
            TimeSpan.FromDays(1));
}

internal sealed class CinemetaClient(ProviderHttp http)
{
    internal Task<ProviderAnswer> GetAsync(string path, CancellationToken ct, bool force = false,
        TimeSpan? ttl = null) => http.FetchAsync("cinemeta", path,
            () => new(HttpMethod.Get, "https://v3-cinemeta.strem.io" + path),
            ttl ?? TimeSpan.FromMinutes(15), ct, 8, force: force,
            kind: path.Contains("/search=", StringComparison.Ordinal) ? CacheKind.TitleSearch : CacheKind.ProviderDetail);
    internal Task<ProviderAnswer> SearchAsync(string title, WorkKind kind, CancellationToken ct) =>
        GetAsync("/catalog/" + Kind(kind) + "/top/search=" + Uri.EscapeDataString(title) + ".json", ct,
            ttl: TimeSpan.FromMinutes(5));
    internal Task<ProviderAnswer> DetailAsync(string id, WorkKind kind, CancellationToken ct, bool force = false) =>
        GetAsync("/meta/" + Kind(kind) + "/" + Uri.EscapeDataString(id) + ".json", ct, force, TimeSpan.FromHours(1));
    internal Task<ProviderAnswer> SuggestAsync(string title, CancellationToken ct) =>
        http.FetchAsync("imdb", "suggest:" + title.ToLowerInvariant(),
            () => new(HttpMethod.Get, "https://v3.sg.media-imdb.com/suggestion/x/" +
                Uri.EscapeDataString(title.ToLowerInvariant()) + ".json"),
            TimeSpan.FromMinutes(5), ct, 5, kind: CacheKind.TitleSearch);
    internal Task<ProviderAnswer> NamesAsync(string id, CancellationToken ct) =>
        http.FetchAsync("imdb", "names:" + id, () =>
        {
            var request = new HttpRequestMessage(HttpMethod.Post, "https://graphql.imdb.com/")
            {
                Content = JsonContent.Create(new { query = "query($id:ID!){title(id:$id){titleText{text}originalTitleText{text}akas(first:100){edges{node{text}}}}}",
                    variables = new { id } }),
            };
            request.Headers.TryAddWithoutValidation("x-imdb-client-name", "imdb-web-next");
            return request;
        }, TimeSpan.FromHours(6), ct, 4);
    internal Task<ProviderAnswer> TvmazeAsync(string path, CancellationToken ct) =>
        http.FetchAsync("tvmaze", path, () => new(HttpMethod.Get, "https://api.tvmaze.com" + path),
            TimeSpan.FromHours(1), ct, 8);
    internal Task<ProviderAnswer> ItunesAsync(string title, CancellationToken ct) =>
        http.FetchAsync("itunes", "search:" + title, () => new(HttpMethod.Get,
            "https://itunes.apple.com/search?media=movie&entity=movie&limit=20&term=" + Uri.EscapeDataString(title)),
            TimeSpan.FromMinutes(5), ct, 8, kind: CacheKind.TitleSearch);
    internal Task<ProviderAnswer> ItunesByIdAsync(string id, CancellationToken ct) =>
        http.FetchAsync("itunes", "lookup:" + id, () => new(HttpMethod.Get,
            "https://itunes.apple.com/lookup?id=" + Uri.EscapeDataString(id) + "&entity=movie"),
            TimeSpan.FromDays(7), ct, 8);
    internal static string Kind(WorkKind kind) => kind == WorkKind.Series ? "series" : "movie";
}
