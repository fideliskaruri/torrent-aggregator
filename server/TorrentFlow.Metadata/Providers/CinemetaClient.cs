using System.Globalization;
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
        // IMDb's exact title wins for the same id: Cinemeta lists tt1160419 as "Dune: Part One", IMDb as "Dune".
        var imdbTitles = suggested.Where(s => s.ExternalId is not null).GroupBy(s => s.ExternalId!).ToDictionary(g => g.Key, g => g.First().Title);
        rows = rows.Select(r => r.ExternalId is { } id && imdbTitles.TryGetValue(id, out var t) && !SameTitle(r.Title, query) ? WithImdbTitle(r, t) : r).ToList();
        if (rows.Any(r => SameTitle(r.Title, query))) return rows;
        var extra = suggested.Where(s => rows.All(r => r.ExternalId != s.ExternalId));
        return extra.Concat(rows).Take(limit).ToList();
    }

    private static readonly HashSet<string> MovieKinds = ["movie", "short", "tvMovie", "video"];
    private static readonly HashSet<string> SeriesKinds = ["tvSeries", "tvMiniSeries"];

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
            if (!SameTitle(title, query)) continue;
            int? year = hit.TryGetProperty("y", out var y) && y.TryGetInt32(out var n) ? n : null;
            var poster = hit.TryGetProperty("i", out var image) && image.ValueKind == JsonValueKind.Object ? Str(image, "imageUrl") : null;
            list.Add(new()
            {
                Source = "cinemeta", ExternalId = id, Title = title, MediaType = Kind(type) == "series" ? "tv" : "movie",
                PosterUrl = poster, Year = year,
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

    /// <summary>The title IMDb shows for an id, or null when IMDb does not answer.</summary>
    private async Task<string?> ImdbTitleAsync(string id, CancellationToken ct)
    {
        if (await SuggestRootAsync(id, ct) is not { ValueKind: JsonValueKind.Object } root ||
            !root.TryGetProperty("d", out var hits) || hits.ValueKind != JsonValueKind.Array) return null;
        foreach (var hit in hits.EnumerateArray())
            if (hit.ValueKind == JsonValueKind.Object && Str(hit, "id") == id && Str(hit, "l") is { } label && label.Trim().Length > 0)
                return label.Trim();
        return null;
    }

    /// <summary>IMDb's title becomes the name and Cinemeta's differing one stays as an alias, so either still identifies the work.</summary>
    private static MediaMetadata WithImdbTitle(MediaMetadata row, string? imdbTitle) =>
        imdbTitle is null || SameTitle(row.Title, imdbTitle) ? row
            : row with { Title = imdbTitle, Aliases = [.. row.Aliases ?? [], row.Title] };

    private static bool SameTitle(string? a, string b) =>
        a is not null && string.Equals(Fold(a), Fold(b), StringComparison.Ordinal);

    private static string Fold(string value) =>
        new(value.Normalize(System.Text.NormalizationForm.FormD)
            .Where(c => char.IsLetterOrDigit(c)).Select(char.ToLowerInvariant).ToArray());
    public Task<List<MediaMetadata>> CatalogAsync(string type, int limit = 24, CancellationToken ct = default) =>
        List($"/catalog/{Kind(type)}/top.json", type, limit, ct);
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
        return meta is null ? null : WithImdbTitle(meta, title);
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
            Rating = rating, Genres = StrArray(row, "genres"),
            AdditionalProperties = new() { ["externalIds"] = JsonSerializer.SerializeToElement(new { imdb = id }) }
        };
    }
}
