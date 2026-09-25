using System.Globalization;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using TorrentFlow.Data;
using TorrentFlow.Metadata.Caching;
using TorrentFlow.Metadata.Catalog;
using TorrentFlow.Metadata.Providers;

namespace TorrentFlow.Metadata.Recommend;

/// <summary>src/lib/recommend/index.ts Recommendation. Every field is always serialized, nulls included.</summary>
public sealed record Recommendation(
    string Provider,
    string SourceMediaType,
    string MediaType,
    string TitleMediaType,
    string ExternalId,
    string Title,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? PosterUrl,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] int? Year,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] double? Rating,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? Format,
    bool IsSeries);

public sealed record RecommendationRail(string SeedTitle, IReadOnlyList<Recommendation> Items);

/// <summary>"Because you're watching X" — one seed, one rail, from the catalogs' own recommendations.</summary>
public sealed partial class RecommendationService(
    IHttpClientFactory httpFactory,
    TmdbClient tmdb,
    IDbContextFactory<TorrentFlowDbContext> dbFactory,
    TimeProvider time,
    ILogger<RecommendationService> logger)
{
    public const string AniListRecommendationsUrl = "https://graphql.anilist.co?operation=recommendations";
    private const string Img = "https://image.tmdb.org/t/p/w342";
    private static readonly TimeSpan PositiveTtl = TimeSpan.FromHours(6);
    private static readonly TimeSpan NegativeTtl = TimeSpan.FromMinutes(2);
    private static readonly HashSet<string> AniListFormats = ["TV", "TV_SHORT", "MOVIE", "SPECIAL", "OVA", "ONA", "MUSIC"];

    private const string AniListQuery = """

        query ($id: Int) {
          Media(id: $id, type: ANIME) {
            recommendations(sort: RATING_DESC, perPage: 12) {
              nodes {
                mediaRecommendation {
                  id
                  title { romaji english }
                  coverImage { large }
                  startDate { year }
                  averageScore
                  format
                }
              }
            }
          }
        }

        """;

    private readonly BoundedTtlCache<List<Recommendation>> _tmdbCache = new(400, time);

    [GeneratedRegex(@"^\d+$")] private static partial Regex Digits();

    public void ResetCache() => _tmdbCache.Clear();

    /// <summary>`mediaType:externalId`, the key a rail excludes on.</summary>
    public static string LibraryKey(string mediaType, string externalId) => $"{MediaTypes.Normalize(mediaType) ?? mediaType}:{externalId}";

    /// <summary>GET /api/recommendations body: seed is the most recent "watching" row.</summary>
    public async Task<RecommendationRail?> ForUserAsync(string userId, CancellationToken ct = default)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct).ConfigureAwait(false);
        var items = await db.WatchListItems.AsNoTracking().Where(w => w.UserId == userId)
            .OrderByDescending(w => w.UpdatedAt)
            .Select(w => new { w.Title, w.MediaType, w.ExternalId, w.Status })
            .ToListAsync(ct).ConfigureAwait(false);
        var seed = items.FirstOrDefault(i => i.Status == "watching");
        if (seed is null) return null;
        return await RecommendationsForAsync(seed.Title, seed.MediaType, seed.ExternalId,
            items.Select(i => LibraryKey(i.MediaType, i.ExternalId)).ToHashSet(), 6, ct).ConfigureAwait(false);
    }

    public Task<RecommendationRail?> RecommendationsForAsync(string title, string mediaType, string externalId, IReadOnlySet<string> exclude, int limit = 6, CancellationToken ct = default)
    {
        var normalized = MediaTypes.Normalize(mediaType);
        return RecommendationsForProviderAsync(normalized == "anime" ? "anilist" : "tmdb", title, normalized ?? mediaType, externalId, exclude, limit, ct);
    }

    public async Task<RecommendationRail?> RecommendationsForProviderAsync(string provider, string title, string mediaType, string externalId,
        IReadOnlySet<string> exclude, int limit = 6, CancellationToken ct = default)
    {
        if (!Digits().IsMatch(externalId)) return null;
        var mt = MediaTypes.Normalize(mediaType);
        List<Recommendation> found;
        try
        {
            found = provider == "anilist" ? await FromAniListAsync(externalId, ct).ConfigureAwait(false)
                : mt is "tv" or "movie" ? await FromTmdbAsync(mt, externalId, ct).ConfigureAwait(false)
                : [];
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            logger.LogError("[recommend] {Provider} recommendations failed for {Id}: {Message}", provider, externalId, e.Message);
            return null;
        }

        var seen = new HashSet<string>();
        var items = found.Where(r => !string.IsNullOrEmpty(r.PosterUrl))
            .Where(r => { var k = LibraryKey(r.MediaType, r.ExternalId); return !exclude.Contains(k) && seen.Add(k); })
            .Take(limit).ToList();
        return items.Count > 0 ? new RecommendationRail(title, items) : null;
    }

    private async Task<List<Recommendation>> FromAniListAsync(string id, CancellationToken ct)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(TimeSpan.FromSeconds(10));
        var body = JsonSerializer.Serialize(new { query = AniListQuery, variables = new { id = long.Parse(id, CultureInfo.InvariantCulture) } });
        using var req = new HttpRequestMessage(HttpMethod.Post, AniListRecommendationsUrl) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        req.Headers.Accept.ParseAdd("application/json");
        using var res = await httpFactory.CreateClient(TmdbClient.HttpClientName).SendAsync(req, cts.Token).ConfigureAwait(false);
        if (!res.IsSuccessStatusCode) return [];
        var json = await res.Content.ReadFromJsonAsync<JsonElement>(cts.Token).ConfigureAwait(false);
        return ParseAniList(json);
    }

    public static List<Recommendation> ParseAniList(JsonElement json)
    {
        var output = new List<Recommendation>();
        if (!Path(json, "data", "Media", "recommendations", "nodes", out var nodes) || nodes.ValueKind != JsonValueKind.Array) return output;
        foreach (var node in nodes.EnumerateArray())
        {
            if (node.ValueKind != JsonValueKind.Object || !node.TryGetProperty("mediaRecommendation", out var m) || m.ValueKind != JsonValueKind.Object) continue;
            if (!m.TryGetProperty("id", out var idEl) || idEl.ValueKind != JsonValueKind.Number || idEl.GetDouble() == 0) continue;
            var format = TmdbClient.Str(m, "format");
            if (format is null || !AniListFormats.Contains(format)) continue;
            var isSeries = format != "MOVIE";
            string? english = null, romaji = null;
            if (m.TryGetProperty("title", out var t) && t.ValueKind == JsonValueKind.Object) { english = TmdbClient.Str(t, "english"); romaji = TmdbClient.Str(t, "romaji"); }
            var title = english.OrEmpty(romaji) ?? "";
            if (title.Length == 0) continue;
            string? poster = m.TryGetProperty("coverImage", out var c) && c.ValueKind == JsonValueKind.Object ? TmdbClient.Str(c, "large") : null;
            int? year = m.TryGetProperty("startDate", out var sd) && sd.ValueKind == JsonValueKind.Object ? TmdbClient.Int(sd, "year") : null;
            var score = TmdbClient.Num(m, "averageScore");
            output.Add(new Recommendation("anilist", "anime", "anime", isSeries ? "anime" : "movie",
                idEl.GetRawText(), title, poster, year,
                score is { } s ? Math.Round(s, MidpointRounding.AwayFromZero) / 10 : null, format, isSeries));
        }
        return output;
    }

    private async Task<List<Recommendation>> FromTmdbAsync(string mediaType, string id, CancellationToken ct)
    {
        if (tmdb.ApiKey is not { } key) return [];
        var cacheKey = $"{mediaType}:{id}";
        if (_tmdbCache.TryGet(cacheKey, out var cached)) return cached;

        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(TimeSpan.FromSeconds(10));
        using var req = TmdbClient.BuildRequest(key, $"https://api.themoviedb.org/3/{mediaType}/{id}/recommendations", [("language", "en-US"), ("page", "1")]);
        using var res = await httpFactory.CreateClient(TmdbClient.HttpClientName).SendAsync(req, cts.Token).ConfigureAwait(false);
        if (!res.IsSuccessStatusCode) throw new HttpRequestException($"TMDB recommendations HTTP {(int)res.StatusCode}");
        var json = await res.Content.ReadFromJsonAsync<JsonElement>(cts.Token).ConfigureAwait(false);
        var recs = ParseTmdb(json, mediaType);
        _tmdbCache.Set(cacheKey, recs, recs.Count > 0 ? PositiveTtl : NegativeTtl);
        return recs;
    }

    public static List<Recommendation> ParseTmdb(JsonElement json, string mediaType)
    {
        var output = new List<Recommendation>();
        if (json.ValueKind != JsonValueKind.Object || !json.TryGetProperty("results", out var results) || results.ValueKind != JsonValueKind.Array) return output;
        foreach (var r in results.EnumerateArray())
        {
            if (r.ValueKind != JsonValueKind.Object || !r.TryGetProperty("id", out var idEl) || idEl.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined) continue;
            var title = TmdbClient.Str(r, "title").OrEmpty(TmdbClient.Str(r, "name")) ?? "";
            if (title.Length == 0) continue;
            var date = TmdbClient.Str(r, "release_date").OrEmpty(TmdbClient.Str(r, "first_air_date")) ?? "";
            int? year = date.Length > 0 && int.TryParse(date.AsSpan(0, Math.Min(4, date.Length)), NumberStyles.None, CultureInfo.InvariantCulture, out var y) && y != 0 ? y : null;
            var vote = TmdbClient.Num(r, "vote_average");
            var count = TmdbClient.Num(r, "vote_count") ?? 0;
            var poster = TmdbClient.Str(r, "poster_path");
            output.Add(new Recommendation("tmdb", mediaType, mediaType, mediaType, idEl.ValueKind == JsonValueKind.String ? idEl.GetString()! : idEl.GetRawText(),
                title, string.IsNullOrEmpty(poster) ? null : Img + poster, year,
                vote is { } v && v > 0 && count >= 20 ? Math.Round(v * 10, MidpointRounding.AwayFromZero) / 10 : null, null, mediaType == "tv"));
        }
        return output;
    }

    private static bool Path(JsonElement e, string a, string b, string c, string d, out JsonElement result)
    {
        result = e;
        foreach (var name in new[] { a, b, c, d })
        {
            if (result.ValueKind != JsonValueKind.Object || !result.TryGetProperty(name, out result)) return false;
        }
        return true;
    }
}
