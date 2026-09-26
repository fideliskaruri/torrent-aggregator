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

    public async Task<List<MediaMetadata>> SearchAsync(string query, string type, int limit = 12, CancellationToken ct = default) =>
        await List($"/catalog/{Kind(type)}/top/search={Uri.EscapeDataString(query.Trim())}.json", type, limit, ct);
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
        var root = await Get($"/meta/{Kind(type)}/{id}.json", ct);
        return root is { ValueKind: JsonValueKind.Object } obj && obj.TryGetProperty("meta", out var meta) ? Map(meta, type) : null;
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
