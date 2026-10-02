using System.Globalization;
using System.Net.Http.Json;
using System.Text.Json;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Core.Sources;
using TorrentFlow.Metadata.Caching;
using static TorrentFlow.Metadata.Providers.TmdbClient;

namespace TorrentFlow.Metadata.Providers;

public sealed class CinemetaClient(IHttpClientFactory http, SourceRegistry? registry = null)
{
    public const string Base = "https://v3-cinemeta.strem.io";
    private readonly BoundedTtlCache<JsonElement> cache = new(400, TimeProvider.System);
    private readonly SingleFlight<JsonElement?> suggestFlight = new();

    private async Task<JsonElement?> Get(string path, CancellationToken ct)
    {
        if (registry is not null && !registry.Active("metadata").Any(e => e.Type == "cinemeta")) return null;
        var key = $"{registry?.Revision}:{SourceExecution.Current?.Id}:{path}";
        if (cache.TryGet(key, out var value)) return value;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(8));
        try
        {
            using var client = http.CreateClient(HttpClientName);
            using var response = await client.GetAsync(Base + path, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            if (!response.IsSuccessStatusCode) return null;
            using var doc = await TorrentFlow.Core.Http.BoundedHttpContent.ReadJsonAsync(response.Content, timeout.Token);
            value = doc.RootElement.Clone();
            cache.Set(key, value, TimeSpan.FromMinutes(15));
            return value;
        }
        catch (Exception e) when (!ct.IsCancellationRequested && e is HttpRequestException or OperationCanceledException or JsonException) { return null; }
    }

    public const string ImdbSuggest = "https://v3.sg.media-imdb.com/suggestion/x/";

    public async Task<List<MediaMetadata>> SearchAsync(string query, string type, int limit = 12, CancellationToken ct = default)
    {
        // Cinemeta's search index leaves out IMDb shorts and TV movies (e.g. "Sintel") and fuzzy-matches
        // unrelated titles instead. IMDb's suggestion index covers the same tt ids that /meta/ resolves;
        // it runs in parallel so it adds no latency, and only exact title matches are used.
        var suggest = SuggestAsync(query, type, ct);
        var rows = await List($"/catalog/{Kind(type)}/top/search={Uri.EscapeDataString(query.Trim())}.json", type, limit, ct);
        var suggested = await suggest;
        // IMDb's exact title wins for the same id: Cinemeta lists tt1160419 as "Dune: Part One", IMDb as "Dune". IMDb's year
        // is the first release; Cinemeta's is sometimes the US one (Spirited Away 2003, Amélie 2002).
        var imdb = suggested.Where(s => s.ExternalId is not null).GroupBy(s => s.ExternalId!).ToDictionary(g => g.Key, g => g.First());
        rows = rows.Select(r => r.ExternalId is { } id && imdb.TryGetValue(id, out var s)
            ? WithImdbYear(SameTitle(r.Title, query) ? r : WithImdbTitle(r, s.Title), s.Year) : r).ToList();
        // IMDb's first suggestion is the work even when the typed name is one of its other titles ("Gisaengchung" is
        // Parasite), so it is offered next to the exact title matches.
        var top = suggested.FirstOrDefault();
        var extra = suggested.Where((s, i) => rows.All(r => r.ExternalId != s.ExternalId) &&
            (SameTitle(s.Title, query) || (i == 0 && !rows.Any(r => SameTitle(r.Title, query))))).ToList();
        if (rows.Any(r => SameTitle(r.Title, query)) && extra.Count == 0) return rows;
        return extra.Concat(rows).Take(limit).ToList();
    }

    /// <summary>IMDb's first suggestion for the query among films (or series), whatever name matched.</summary>
    public async Task<MediaMetadata?> ImdbTopAsync(string query, string type, CancellationToken ct = default) =>
        (await SuggestAsync(query, type, ct)).FirstOrDefault();

    public const string ImdbGraphql = "https://graphql.imdb.com/";
    private readonly BoundedTtlCache<List<string>> namesCache = new(400, TimeProvider.System);

    /// <summary>IMDb's names for a title: its original title and its AKAs ("Wo hu cang long", "Gisaengchung"). Empty when
    /// IMDb does not answer.</summary>
    public async Task<List<string>> ImdbNamesAsync(string id, CancellationToken ct = default)
    {
        if (!System.Text.RegularExpressions.Regex.IsMatch(id, "^tt[0-9]+$")) return [];
        if (registry is not null && !registry.Active("metadata").Any(e => e.Type == "cinemeta")) return [];
        if (namesCache.TryGet(id, out var cached)) return cached;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(4));
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, ImdbGraphql)
            {
                Content = JsonContent.Create(new { query = $"{{ title(id: \"{id}\") {{ titleText {{ text }} originalTitleText {{ text }} akas(first: 100) {{ edges {{ node {{ text }} }} }} }} }}" }),
            };
            // IMDb's API answers only clients that name themselves.
            request.Headers.TryAddWithoutValidation("x-imdb-client-name", "imdb-web-next");
            request.Headers.TryAddWithoutValidation("User-Agent", "Mozilla/5.0");
            using var client = http.CreateClient(HttpClientName);
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            if (!response.IsSuccessStatusCode) return [];
            using var doc = await TorrentFlow.Core.Http.BoundedHttpContent.ReadJsonAsync(response.Content, timeout.Token);
            if (!doc.RootElement.TryGetProperty("data", out var data) || !data.TryGetProperty("title", out var title) || title.ValueKind != JsonValueKind.Object)
                return [];
            var names = new List<string>();
            foreach (var field in (string[])["titleText", "originalTitleText"])
                if (title.TryGetProperty(field, out var text) && text.ValueKind == JsonValueKind.Object && Str(text, "text") is { } name) names.Add(name);
            if (title.TryGetProperty("akas", out var akas) && akas.ValueKind == JsonValueKind.Object && akas.TryGetProperty("edges", out var edges) &&
                edges.ValueKind == JsonValueKind.Array)
                foreach (var edge in edges.EnumerateArray())
                    if (edge.TryGetProperty("node", out var node) && node.ValueKind == JsonValueKind.Object && Str(node, "text") is { } aka) names.Add(aka);
            names = names.Where(n => n.Trim().Length > 0).Distinct().ToList();
            namesCache.Set(id, names, TimeSpan.FromHours(6));
            return names;
        }
        catch (Exception e) when (!ct.IsCancellationRequested && e is HttpRequestException or OperationCanceledException or JsonException) { return []; }
    }

    private static readonly HashSet<string> MovieKinds = ["movie", "short", "tvMovie", "video"];
    private static readonly HashSet<string> SeriesKinds = ["tvSeries", "tvMiniSeries"];

    /// <summary>IMDb's suggestions of the type, in IMDb's order.</summary>
    private async Task<List<MediaMetadata>> SuggestAsync(string query, string type, CancellationToken ct)
    {
        if (await SuggestRootAsync(query, ct) is not { ValueKind: JsonValueKind.Object } root ||
            !root.TryGetProperty("d", out var hits) || hits.ValueKind != JsonValueKind.Array) return [];
        var kinds = Kind(type) == "series" ? SeriesKinds : MovieKinds;
        var list = new List<MediaMetadata>();
        foreach (var hit in hits.EnumerateArray())
        {
            if (hit.ValueKind != JsonValueKind.Object) continue;
            var id = Str(hit, "id"); var title = Str(hit, "l"); var qid = Str(hit, "qid");
            if (id is null || !id.StartsWith("tt", StringComparison.Ordinal) || title is null || qid is null || !kinds.Contains(qid)) continue;
            int? year = hit.TryGetProperty("y", out var y) && y.TryGetInt32(out var n) ? n : null;
            var poster = hit.TryGetProperty("i", out var image) && image.ValueKind == JsonValueKind.Object ? Str(image, "imageUrl") : null;
            list.Add(new()
            {
                Source = "cinemeta", ExternalId = id, Title = title, MediaType = Kind(type) == "series" ? "tv" : "movie",
                PosterUrl = poster, Year = year, Names = [new(title, WorkNameKind.English)], Ids = new(Imdb: id),
                AdditionalProperties = new() { ["externalIds"] = JsonSerializer.SerializeToElement(new { imdb = id }) }
            });
        }
        return list;
    }

    /// <summary>
    /// IMDb popularity rank per title id (1 = most popular) for the works IMDb suggests for this query.
    /// Search ranking uses it to put the work people mean ahead of obscure namesakes; empty when unavailable.
    /// </summary>
    public async Task<IReadOnlyDictionary<string, int>> ImdbRanksAsync(string query, CancellationToken ct = default)
    {
        var ranks = new Dictionary<string, int>(StringComparer.Ordinal);
        JsonElement? payload;
        try { payload = await SuggestRootAsync(query, ct); }
        catch (Exception) when (!ct.IsCancellationRequested) { return ranks; }
        if (payload is not { ValueKind: JsonValueKind.Object } root || !root.TryGetProperty("d", out var hits) || hits.ValueKind != JsonValueKind.Array)
            return ranks;
        foreach (var hit in hits.EnumerateArray())
        {
            if (hit.ValueKind != JsonValueKind.Object || Str(hit, "id") is not { } id || !id.StartsWith("tt", StringComparison.Ordinal)) continue;
            if (hit.TryGetProperty("rank", out var rank) && rank.ValueKind == JsonValueKind.Number && rank.TryGetInt32(out var value) && value > 0)
                ranks.TryAdd(id, value);
        }
        return ranks;
    }

    /// <summary>
    /// IMDb's suggestion payload for a query. Movie search, series search and search ranking all ask for the same term
    /// at once, so one detached fetch serves every caller and is cached.
    /// </summary>
    private async Task<JsonElement?> SuggestRootAsync(string query, CancellationToken ct)
    {
        var term = query.Trim().ToLowerInvariant();
        if (term.Length < 2 || term.Length > 120) return null;
        if (registry is not null && !registry.Active("metadata").Any(e => e.Type == "cinemeta")) return null;
        var key = $"suggest:{term}";
        if (cache.TryGet(key, out var cached)) return cached;
        return await suggestFlight.RunAsync(key, () => FetchSuggestAsync(term, key), ct);
    }

    private async Task<JsonElement?> FetchSuggestAsync(string term, string key)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        try
        {
            using var client = http.CreateClient(HttpClientName);
            using var response = await client.GetAsync(ImdbSuggest + Uri.EscapeDataString(term) + ".json", HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            if (!response.IsSuccessStatusCode) return null;
            using var doc = await TorrentFlow.Core.Http.BoundedHttpContent.ReadJsonAsync(response.Content, timeout.Token);
            var root = doc.RootElement.Clone();
            cache.Set(key, root, TimeSpan.FromMinutes(15));
            return root;
        }
        catch (Exception e) when (e is HttpRequestException or OperationCanceledException or JsonException) { return null; }
    }

    /// <summary>The title and year IMDb shows for an id, or null when IMDb does not answer.</summary>
    private async Task<(string Title, int? Year)?> ImdbTitleAsync(string id, CancellationToken ct)
    {
        if (await SuggestRootAsync(id, ct) is not { ValueKind: JsonValueKind.Object } root ||
            !root.TryGetProperty("d", out var hits) || hits.ValueKind != JsonValueKind.Array) return null;
        foreach (var hit in hits.EnumerateArray())
            if (hit.ValueKind == JsonValueKind.Object && Str(hit, "id") == id && Str(hit, "l") is { } label && label.Trim().Length > 0)
                return (label.Trim(), hit.TryGetProperty("y", out var y) && y.TryGetInt32(out var n) ? n : null);
        return null;
    }

    /// <summary>IMDb's year (the first release) in place of Cinemeta's when they differ; the release date goes with
    /// Cinemeta's year, since it is that release's date.</summary>
    private static MediaMetadata WithImdbYear(MediaMetadata row, int? imdbYear) =>
        imdbYear is null || row.Year == imdbYear ? row : row with { Year = imdbYear, ReleaseDate = null };

    /// <summary>IMDb's title becomes the name and Cinemeta's differing one stays as an alias, so either still identifies the work.</summary>
    private static MediaMetadata WithImdbTitle(MediaMetadata row, string? imdbTitle) =>
        imdbTitle is null || SameTitle(row.Title, imdbTitle) ? row
            : row with { Title = imdbTitle, Aliases = [.. row.Aliases ?? [], row.Title],
                Names = [.. WorkNames.Of([new WorkName(imdbTitle, WorkNameKind.English)]).Merge(WorkNames.Of(row)).All] };

    private static bool SameTitle(string? a, string b) =>
        a is not null && string.Equals(Fold(a), Fold(b), StringComparison.Ordinal);

    private static string Fold(string value) =>
        new(value.Normalize(System.Text.NormalizationForm.FormD)
            .Where(c => char.IsLetterOrDigit(c)).Select(char.ToLowerInvariant).ToArray());
    /// <summary>A Cinemeta catalog ("top" is IMDb's popular list, "year" one year's titles), optionally one genre of it. Pages hold 50; <paramref name="skip"/> starts later.</summary>
    public Task<List<MediaMetadata>> CatalogAsync(string type, string catalog, string? genre, int limit, CancellationToken ct = default, int skip = 0)
    {
        var extras = new List<string>();
        if (genre is not null) extras.Add($"genre={Uri.EscapeDataString(genre)}");
        if (skip > 0) extras.Add($"skip={skip.ToString(CultureInfo.InvariantCulture)}");
        var path = extras.Count == 0 ? $"/catalog/{Kind(type)}/{catalog}.json" : $"/catalog/{Kind(type)}/{catalog}/{string.Join('&', extras)}.json";
        return List(path, type, limit, ct);
    }
    private async Task<List<MediaMetadata>> List(string path, string type, int limit, CancellationToken ct)
    {
        var root = await Get(path, ct);
        return root is { ValueKind: JsonValueKind.Object } obj && obj.TryGetProperty("metas", out var metas) && metas.ValueKind == JsonValueKind.Array
            ? metas.EnumerateArray().Select(r => Map(r, type)).OfType<MediaMetadata>().Take(limit).ToList() : [];
    }
    public async Task<MediaMetadata?> GetByIdAsync(string id, string type, CancellationToken ct = default)
    {
        if (!System.Text.RegularExpressions.Regex.IsMatch(id, "^tt[0-9]+$")) return null;
        // Search names an id the way IMDb does (see SearchAsync), so the record for that id must answer to the same name:
        // a "dune-2021" link built from the "Dune" hit is checked against tt1160419, which Cinemeta calls "Dune: Part One".
        var imdbTitle = ImdbTitleAsync(id, ct);
        var root = await Get($"/meta/{Kind(type)}/{id}.json", ct);
        var meta = root is { ValueKind: JsonValueKind.Object } obj && obj.TryGetProperty("meta", out var row) ? Map(row, type) : null;
        var title = await imdbTitle;
        return meta is null ? null : title is { } imdb ? WithImdbYear(WithImdbTitle(meta, imdb.Title), imdb.Year) : meta;
    }
    private static string Kind(string type) => type is "tv" or "series" ? "series" : "movie";
    private static MediaMetadata? Map(JsonElement row, string type)
    {
        if (row.ValueKind != JsonValueKind.Object) return null;
        var id = Str(row, "imdb_id") ?? Str(row, "id");
        var title = Str(row, "name");
        if (string.IsNullOrWhiteSpace(id) || string.IsNullOrWhiteSpace(title)) return null;
        var release = Str(row, "releaseInfo") ?? Str(row, "year") ?? Str(row, "released");
        double? rating = double.TryParse(Str(row, "imdbRating"), CultureInfo.InvariantCulture, out var r) ? r : null;
        return new()
        {
            Source = "cinemeta", ExternalId = id, Title = title, MediaType = Kind(type) == "series" ? "tv" : "movie",
            PosterUrl = Str(row, "poster"), BackdropUrl = Str(row, "background"), Synopsis = Str(row, "description"),
            Year = YearOf(release), ReleaseDate = Str(row, "released") is { Length: >= 10 } date ? date[..10] : null,
            Rating = rating, Genres = StrArray(row, "genres"), Names = [new(title, WorkNameKind.English)], Ids = WorkIds.From("cinemeta", id),
            // "Japan" or "Japan, United States": the shared anime rule reads Animation made in Japan as anime.
            OriginCountry = Str(row, "country") is { Length: > 0 } country ? country.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries) : null,
            AdditionalProperties = new() { ["externalIds"] = JsonSerializer.SerializeToElement(new { imdb = id }) }
        };
    }
}
