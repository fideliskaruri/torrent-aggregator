using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using TorrentFlow.Metadata.Text;
using TorrentFlow.Core.Sources;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Metadata.Caching;
using static TorrentFlow.Metadata.Providers.TmdbClient;

namespace TorrentFlow.Metadata.Providers;

public sealed record TvmazeCandidate(int Id, string Title, int? Year, string? PosterUrl, double Score, string? Summary,
    IReadOnlyList<string> Genres, double? Rating, string? Premiered, int? RuntimeMin, string? ImdbId = null, int? TvdbId = null);

public sealed record TvmazeEpisode(int Season, int Episode, string? Name, string? AirDate, int? RuntimeMin, string? StillUrl, string? AirStamp = null);

public sealed record ItunesCandidate(int Id, string Title, int? Year, string? PosterUrl, string Kind, string? Description, string? Genre,
    string? ReleaseDate, int? RuntimeMin);

/// <summary>Ports of src/lib/metadata/tvmaze.ts and itunes.ts (keyless providers, 5s default timeout, never throw).</summary>
public sealed partial class KeylessClients(IHttpClientFactory httpFactory, SourceRegistry? registry = null) : IKeylessSeriesLookup
{
    private readonly BoundedTtlCache<JsonElement> cache = new(1000, TimeProvider.System);
    private readonly SemaphoreSlim tvmazeGate = new(1, 1);
    private DateTimeOffset nextTvmazeCall;
    public const string TvmazeSearch = "https://api.tvmaze.com/search/shows";
    public const string TvmazeShows = "https://api.tvmaze.com/shows";
    public const string ItunesSearch = "https://itunes.apple.com/search";

    [GeneratedRegex(@"^\d{4}-\d{2}-\d{2}$")] private static partial Regex IsoDay();
    [GeneratedRegex(@"/\d+x\d+bb\.(jpg|png)$", RegexOptions.IgnoreCase)] private static partial Regex ItunesArt();
    [GeneratedRegex(@"^\d{4}-\d{2}-\d{2}")] private static partial Regex IsoPrefix();

    private async Task<JsonElement?> GetAsync(string url, int timeoutMs, CancellationToken ct)
    {
        var cacheKey = $"{registry?.Revision}:{SourceExecution.Current?.Id}:{url}";
        if (cache.TryGet(cacheKey, out var cached)) return cached;
        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(TimeSpan.FromMilliseconds(Math.Max(1, timeoutMs)));
            using var client = httpFactory.CreateClient(HttpClientName);
            if (url.StartsWith("https://api.tvmaze.com/", StringComparison.Ordinal))
            {
                await tvmazeGate.WaitAsync(cts.Token);
                try
                {
                    var delay = nextTvmazeCall - DateTimeOffset.UtcNow;
                    if (delay > TimeSpan.Zero) await Task.Delay(delay, cts.Token);
                    nextTvmazeCall = DateTimeOffset.UtcNow.AddMilliseconds(550);
                }
                finally { tvmazeGate.Release(); }
            }
            using var response = await client.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, cts.Token).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode) return null;
            using var doc = await TorrentFlow.Core.Http.BoundedHttpContent.ReadJsonAsync(response.Content, cts.Token).ConfigureAwait(false);
            var result = doc.RootElement.Clone();
            cache.Set(cacheKey, result, TimeSpan.FromMinutes(15));
            return result;
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
                DateOnlyString(premiered), PositiveInt(show, "runtime") ?? PositiveInt(show, "averageRuntime"),
                show.TryGetProperty("externals", out var external) && external.ValueKind == JsonValueKind.Object ? Str(external, "imdb") : null,
                external.ValueKind == JsonValueKind.Object ? Int(external, "thetvdb") : null));
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
            output.Add(new TvmazeEpisode(season.Value, episode.Value, Optional(Str(row, "name")), DateOnlyString(Str(row, "airdate")), PositiveInt(row, "runtime"), still,
                Str(row, "airstamp")));
        }
        return output.OrderBy(e => e.Season).ThenBy(e => e.Episode).ToList();
    }

    public async Task<TvmazeCandidate?> GetTvmazeShowAsync(int id, CancellationToken ct = default)
    {
        var root = await GetAsync($"{TvmazeShows}/{id}", 5000, ct);
        if (root is not { ValueKind: JsonValueKind.Object } show) return null;
        var title = Str(show, "name");
        if (string.IsNullOrWhiteSpace(title)) return null;
        var premiere = Str(show, "premiered");
        return new(id, title, YearOf(premiere),
            show.TryGetProperty("image", out var image) && image.ValueKind == JsonValueKind.Object ? Str(image, "original") ?? Str(image, "medium") : null,
            1, Str(show, "summary"), StrArray(show, "genres"),
            show.TryGetProperty("rating", out var rating) && rating.ValueKind == JsonValueKind.Object ? Num(rating, "average") : null,
            DateOnlyString(premiere), PositiveInt(show, "runtime"),
            show.TryGetProperty("externals", out var external) && external.ValueKind == JsonValueKind.Object ? Str(external, "imdb") : null,
            external.ValueKind == JsonValueKind.Object ? Int(external, "thetvdb") : null);
    }

    public async Task<string?> FindImdbIdAsync(string title, CancellationToken cancellationToken = default)
    {
        var shows = await SearchTvmazeAsync(title, 5, 8000, cancellationToken);
        var show = shows.FirstOrDefault(s => string.Equals(QueryVariants.Canonicalize(s.Title), QueryVariants.Canonicalize(title), StringComparison.OrdinalIgnoreCase));
        return show?.ImdbId;
    }

    public static MediaMetadata Metadata(TvmazeCandidate show) => new()
    {
        Source = "tvmaze", MediaType = "tv", ExternalId = show.Id.ToString(CultureInfo.InvariantCulture), Title = show.Title,
        Year = show.Year, PosterUrl = show.PosterUrl, Synopsis = HtmlText.StripToText(show.Summary), Rating = show.Rating,
        ReleaseDate = show.Premiered, Genres = show.Genres,
        AdditionalProperties = new() { ["externalIds"] = JsonSerializer.SerializeToElement(new { tvmaze = show.Id, imdb = show.ImdbId, tvdb = show.TvdbId }) }
    };

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
