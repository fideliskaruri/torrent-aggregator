using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using TorrentFlow.Metadata.Text;
using static TorrentFlow.Metadata.Providers.TmdbClient;

namespace TorrentFlow.Metadata.Providers;

public sealed record TvmazeCandidate(int Id, string Title, int? Year, string? PosterUrl, double Score, string? Summary,
    IReadOnlyList<string> Genres, double? Rating, string? Premiered, int? RuntimeMin);

public sealed record TvmazeEpisode(int Season, int Episode, string? Name, string? AirDate, int? RuntimeMin, string? StillUrl);

public sealed record ItunesCandidate(int Id, string Title, int? Year, string? PosterUrl, string Kind, string? Description, string? Genre,
    string? ReleaseDate, int? RuntimeMin);

/// <summary>Ports of src/lib/metadata/tvmaze.ts and itunes.ts (keyless providers, 5s default timeout, never throw).</summary>
public sealed partial class KeylessClients(IHttpClientFactory httpFactory)
{
    public const string TvmazeSearch = "https://api.tvmaze.com/search/shows";
    public const string TvmazeShows = "https://api.tvmaze.com/shows";
    public const string ItunesSearch = "https://itunes.apple.com/search";

    [GeneratedRegex(@"^\d{4}-\d{2}-\d{2}$")] private static partial Regex IsoDay();
    [GeneratedRegex(@"/\d+x\d+bb\.(jpg|png)$", RegexOptions.IgnoreCase)] private static partial Regex ItunesArt();
    [GeneratedRegex(@"^\d{4}-\d{2}-\d{2}")] private static partial Regex IsoPrefix();

    private async Task<JsonElement?> GetAsync(string url, int timeoutMs, CancellationToken ct)
    {
        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(TimeSpan.FromMilliseconds(Math.Max(1, timeoutMs)));
            using var response = await httpFactory.CreateClient(HttpClientName).GetAsync(url, cts.Token).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode) return null;
            using var doc = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(cts.Token).ConfigureAwait(false), cancellationToken: cts.Token).ConfigureAwait(false);
            return doc.RootElement.Clone();
        }
        catch (Exception e) when (e is HttpRequestException or OperationCanceledException or JsonException && !ct.IsCancellationRequested)
        {
            return null;
        }
    }

    public async Task<List<TvmazeCandidate>> SearchTvmazeAsync(string query, int limit = 8, int timeoutMs = 5000, CancellationToken ct = default)
    {
        var term = query.Trim();
        if (term.Length == 0) return [];
        var root = await GetAsync($"{TvmazeSearch}?{TextUtil.BuildQuery([("q", term)])}", timeoutMs, ct).ConfigureAwait(false);
        if (root is not { ValueKind: JsonValueKind.Array } rows) return [];
        var output = new List<TvmazeCandidate>();
        foreach (var row in rows.EnumerateArray().Take(limit))
        {
            if (row.ValueKind != JsonValueKind.Object || !row.TryGetProperty("show", out var show) || show.ValueKind != JsonValueKind.Object) continue;
            var name = Str(show, "name");
            if (string.IsNullOrEmpty(name)) continue;
            var premiered = Str(show, "premiered");
            string? poster = null;
            if (show.TryGetProperty("image", out var img) && img.ValueKind == JsonValueKind.Object) poster = Str(img, "original").OrEmpty(Str(img, "medium"));
            double? rating = null;
            if (show.TryGetProperty("rating", out var r) && r.ValueKind == JsonValueKind.Object && Num(r, "average") is { } avg && avg > 0) rating = avg;
            output.Add(new TvmazeCandidate(Int(show, "id") ?? 0, name, YearOf(premiered), poster, Num(row, "score") ?? 0,
                Optional(Str(show, "summary")), StrArray(show, "genres").Where(g => g.Trim().Length > 0).ToList(), rating,
                DateOnlyString(premiered), PositiveInt(show, "runtime") ?? PositiveInt(show, "averageRuntime")));
        }
        return output;
    }

    public async Task<List<TvmazeEpisode>> GetTvmazeEpisodesAsync(int showId, int timeoutMs = 5000, CancellationToken ct = default)
    {
        if (showId <= 0) return [];
        var root = await GetAsync($"{TvmazeShows}/{showId}/episodes", timeoutMs, ct).ConfigureAwait(false);
        if (root is not { ValueKind: JsonValueKind.Array } rows) return [];
        var output = new List<TvmazeEpisode>();
        foreach (var row in rows.EnumerateArray().Take(5000))
        {
            var season = PositiveInt(row, "season");
            var episode = PositiveInt(row, "number");
            if (season == null || episode == null) continue;
            string? still = null;
            if (row.TryGetProperty("image", out var img) && img.ValueKind == JsonValueKind.Object) still = Str(img, "original") ?? Str(img, "medium");
            output.Add(new TvmazeEpisode(season.Value, episode.Value, Optional(Str(row, "name")), DateOnlyString(Str(row, "airdate")), PositiveInt(row, "runtime"), still));
        }
        return output.OrderBy(e => e.Season).ThenBy(e => e.Episode).ToList();
    }

    public static string? UpscaleItunesArtwork(string? url, string size = "600x900")
    {
        if (string.IsNullOrEmpty(url)) return null;
        var resized = ItunesArt().Replace(url, $"/{size}bb.jpg");
        return resized == url ? null : resized;
    }

    public async Task<List<ItunesCandidate>> SearchItunesAsync(string query, int limit = 12, int timeoutMs = 5000, IReadOnlyCollection<string>? kinds = null, CancellationToken ct = default)
    {
        var term = query.Trim();
        if (term.Length == 0) return [];
        var allowed = kinds ?? ["feature-movie"];
        var root = await GetAsync($"{ItunesSearch}?{TextUtil.BuildQuery([("term", term), ("limit", limit.ToString(CultureInfo.InvariantCulture))])}", timeoutMs, ct).ConfigureAwait(false);
        if (root is not { ValueKind: JsonValueKind.Object } obj || !obj.TryGetProperty("results", out var results) || results.ValueKind != JsonValueKind.Array) return [];
        var output = new List<ItunesCandidate>();
        foreach (var row in results.EnumerateArray())
        {
            var title = Str(row, "trackName").OrEmpty(Str(row, "collectionName"));
            var kind = Str(row, "kind");
            if (string.IsNullOrEmpty(title) || string.IsNullOrEmpty(kind) || !allowed.Contains(kind)) continue;
            var release = Str(row, "releaseDate");
            var millis = Num(row, "trackTimeMillis");
            output.Add(new ItunesCandidate(Int(row, "trackId") ?? Int(row, "collectionId") ?? 0, title, YearOf(release),
                UpscaleItunesArtwork(Str(row, "artworkUrl100")), kind,
                Optional(Str(row, "longDescription")) ?? Optional(Str(row, "shortDescription")), Optional(Str(row, "primaryGenreName")),
                release != null && IsoPrefix().IsMatch(release) ? release[..10] : null,
                millis is > 0 ? (int)Math.Round(millis.Value / 60000, MidpointRounding.AwayFromZero) : null));
        }
        return output;
    }

    private static int? PositiveInt(JsonElement e, string name) => Int(e, name) is { } v && v > 0 ? v : null;

    private static string? Optional(string? value)
    {
        var t = value?.Trim();
        return string.IsNullOrEmpty(t) ? null : t;
    }

    private static string? DateOnlyString(string? value) => value != null && IsoDay().IsMatch(value) ? value : null;
}
