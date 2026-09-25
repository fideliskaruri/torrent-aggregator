using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Logging;
using TorrentFlow.Metadata.Artwork;
using TorrentFlow.Metadata.Caching;
using TorrentFlow.Metadata.Catalog;
using TorrentFlow.Metadata.Providers;
using TorrentFlow.Metadata.Recommend;
using TorrentFlow.Metadata.Text;

namespace TorrentFlow.Metadata.Title;

public sealed record TitleEpisodeMeta(
    int Episode,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? Name,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? Overview,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? AirDate,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] int? RuntimeMin,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? StillUrl);

public sealed record TitleSimilar(
    string WorkKey, string Href, string Title,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] int? Year,
    string MediaType,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? PosterUrl,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] double? Rating);

/// <summary>src/components/title/types.ts TitleExtrasPayload. ratingSource is optional (omitted when null).</summary>
public sealed record TitleExtrasPayload
{
    public required string WorkKey { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public int? Season { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public int? SeasonCount { get; init; }
    public IReadOnlyList<int> Seasons { get; init; } = [];
    public IReadOnlyList<TitleEpisodeMeta> Episodes { get; init; } = [];
    public IReadOnlyList<TitleSimilar> MoreLikeThis { get; init; } = [];
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? Overview { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public double? Rating { get; init; }
    public string? RatingSource { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? ReleaseDate { get; init; }
    public bool InTheatricalWindow { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? NextHomeReleaseAt { get; init; }
    public IReadOnlyList<string> Genres { get; init; } = [];
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public int? VoteCount { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? Certification { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? OriginalLanguage { get; init; }
    public bool Resolved { get; init; }
    public required string GeneratedAt { get; init; }
}

public sealed record TitleExtrasQuery(string WorkKey, string Title, int? Year, string? MediaType, int? Season,
    string? Provider, string? ProviderId, string? PosterUrl, bool SeriesHint);

/// <summary>
/// GET /api/title/{workKey}/extras (simplified port of extras/route.ts + tmdb-extras.ts). Failure-tolerant: every
/// error produces the empty payload with resolved=false, never a non-200.
/// </summary>
public sealed class TitleExtrasService(
    TmdbClient tmdb,
    AniListClient anilist,
    KeylessClients keyless,
    ArtworkResolver artwork,
    RecommendationService recommendations,
    TimeProvider time,
    ILogger<TitleExtrasService> logger)
{
    public const int ExtrasTimeoutMs = 4_000;
    public const int EpisodePlaceholderCap = 200;
    private static readonly HashSet<string> HomeReleaseTypes = ["4", "5", "6"];
    private readonly BoundedTtlCache<TitleExtrasPayload> _memo = new(400, time);

    public TitleExtrasPayload Empty(string key, int? season) => new()
    {
        WorkKey = key, Season = season, GeneratedAt = Now(),
    };

    private string Now() => time.GetUtcNow().UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);

    public async Task<TitleExtrasPayload> GetAsync(TitleExtrasQuery q, CancellationToken ct = default)
    {
        var empty = Empty(q.WorkKey, q.Season);
        if (q.Title.Length == 0) return empty;
        var memoKey = string.Join('\u0000', q.WorkKey, q.Title, q.Year, q.MediaType, q.Season, q.Provider, q.ProviderId);
        if (_memo.TryGet(memoKey, out var cached)) return cached with { GeneratedAt = Now() };
        try
        {
            var result = await ResolveAsync(q, empty, ct).ConfigureAwait(false);
            _memo.Set(memoKey, result, result.Resolved ? TimeSpan.FromHours(6) : TimeSpan.FromMinutes(2));
            return result;
        }
        catch (Exception e) when (!ct.IsCancellationRequested)
        {
            logger.LogError(e, "[title:extras]");
            return empty;
        }
    }

    private async Task<TitleExtrasPayload> ResolveAsync(TitleExtrasQuery q, TitleExtrasPayload empty, CancellationToken ct)
    {
        var normalized = MediaTypes.Normalize(q.MediaType);
        if (q.Provider == "anilist" && q.ProviderId is { } aid && aid.All(char.IsAsciiDigit))
        {
            var workTask = anilist.GetWorkByIdAsync(aid, ct);
            var railTask = recommendations.RecommendationsForProviderAsync("anilist", q.Title, "anime", aid, new HashSet<string>(), 12, ct);
            _ = railTask.ContinueWith(t => logger.LogDebug(t.Exception, "AniList recommendations failed"),
                CancellationToken.None, TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
            var work = await workTask.ConfigureAwait(false);
            var rail = await railTask.ConfigureAwait(false);
            var m = work?.Metadata;
            return empty with
            {
                MoreLikeThis = (rail?.Items ?? []).Select(ToSimilarLink).ToList(),
                Overview = m?.Synopsis, Rating = m?.Rating, RatingSource = m?.Rating is null ? null : "anilist",
                ReleaseDate = m?.ReleaseDate, Genres = m?.Genres ?? [],
                SeasonCount = work?.IsSeries == true ? 1 : null,
                Resolved = m is not null,
            };
        }

        TmdbRef? tmdbRef = null;
        if (q.Provider == "tmdb" && int.TryParse(q.ProviderId, NumberStyles.None, CultureInfo.InvariantCulture, out var tid))
            tmdbRef = new TmdbRef(tid, normalized == "tv" ? "tv" : "movie");
        else if (q.Provider is null && tmdb.ApiKey is not null)
            tmdbRef = await artwork.ResolveTmdbRefAsync(new ArtworkQuery(q.Title, q.Year, q.MediaType), ct).ConfigureAwait(false);

        return tmdbRef is null ? await KeylessAsync(q, normalized, empty, ct).ConfigureAwait(false) : await TmdbAsync(q, tmdbRef, empty, ct).ConfigureAwait(false);
    }

    private async Task<TitleExtrasPayload> KeylessAsync(TitleExtrasQuery q, string? normalized, TitleExtrasPayload empty, CancellationToken ct)
    {
        var isSeries = normalized is "tv" or "anime" || q.SeriesHint;
        var animeTask = normalized == "anime"
            ? AnimeRecommendationsAsync(q, ct)
            : Task.FromResult(new List<AniListWork>());
        var result = empty;
        if (isSeries && normalized != "anime")
        {
            var shows = await keyless.SearchTvmazeAsync(q.Title, 5, ExtrasTimeoutMs, ct).ConfigureAwait(false);
            var show = shows.FirstOrDefault(s => ArtworkMatching.MatchTier(q.Title, s.Title) >= ArtworkMatching.MinAccept);
            if (show is not null)
            {
                var episodes = await keyless.GetTvmazeEpisodesAsync(show.Id, ExtrasTimeoutMs, ct).ConfigureAwait(false);
                var seasons = episodes.Select(e => e.Season).Where(s => s >= 1).Distinct().Order().ToList();
                var wanted = q.Season is >= 1 ? q.Season : seasons.Cast<int?>().FirstOrDefault() ?? 1;
                result = result with
                {
                    Season = wanted, SeasonCount = seasons.Count == 0 ? null : seasons.Count, Seasons = seasons,
                    Episodes = episodes.Where(e => e.Season == wanted).Select(e => new TitleEpisodeMeta(e.Episode, e.Name, null, e.AirDate, e.RuntimeMin, e.StillUrl)).ToList(),
                    Overview = show.Summary, Resolved = seasons.Count > 0 || show.Summary is not null,
                };
            }
        }
        var anime = await animeTask.ConfigureAwait(false);
        var moreLikeThis = anime.Select(w => ToSimilarLink(new Recommendation("anilist", "anime", "anime", w.IsSeries ? "anime" : "movie",
            w.Metadata.ExternalId, w.Metadata.Title, w.Metadata.PosterUrl, w.Metadata.Year, w.Metadata.Rating, w.Format, w.IsSeries))).ToList();
        return result with { MoreLikeThis = moreLikeThis };
    }

    private async Task<List<AniListWork>> AnimeRecommendationsAsync(TitleExtrasQuery q, CancellationToken ct)
    {
        try { return await anilist.RecommendationsForPosterAsync(q.Title, q.PosterUrl, 12, ct).ConfigureAwait(false); }
        catch (Exception e) when (!ct.IsCancellationRequested)
        {
            logger.LogDebug(e, "Anime recommendations unavailable");
            return [];
        }
    }

    private async Task<TitleExtrasPayload> TmdbAsync(TitleExtrasQuery q, TmdbRef r, TitleExtrasPayload empty, CancellationToken ct)
    {
        var series = r.MediaType == "tv";
        var detailTask = tmdb.FetchDetailAsync(r.MediaType, r.Id, ExtrasTimeoutMs, ct);
        var railTask = TmdbRecommendationsAsync(q, r, ct);
        var detail = await detailTask.ConfigureAwait(false);
        var rail = await railTask.ConfigureAwait(false);
        if (detail is not { } d) return empty with { MoreLikeThis = (rail?.Items ?? []).Select(ToSimilarLink).ToList() };

        var seasonCounts = new SortedDictionary<int, int>();
        if (series && d.TryGetProperty("seasons", out var ss) && ss.ValueKind == JsonValueKind.Array)
            foreach (var s in ss.EnumerateArray())
                if (TmdbClient.Int(s, "season_number") is { } n && n >= 1) seasonCounts[n] = TmdbClient.Int(s, "episode_count") ?? 0;
        var wanted = q.Season is >= 1 ? q.Season : seasonCounts.Keys.Cast<int?>().FirstOrDefault() ?? (series ? 1 : null);

        var episodes = new List<TitleEpisodeMeta>();
        if (series && wanted is { } w && await tmdb.FetchSeasonAsync(r.Id, w, ExtrasTimeoutMs, ct).ConfigureAwait(false) is { } season &&
            season.TryGetProperty("episodes", out var eps) && eps.ValueKind == JsonValueKind.Array)
        {
            foreach (var e in eps.EnumerateArray())
                if (TmdbClient.Int(e, "episode_number") is { } en)
                    episodes.Add(new TitleEpisodeMeta(en, TmdbClient.Str(e, "name"), TmdbClient.Str(e, "overview").OrEmpty(null),
                        CatalogText.ParseReleaseDate(TmdbClient.Str(e, "air_date")), TmdbClient.Int(e, "runtime"), TmdbClient.StillUrl(TmdbClient.Str(e, "still_path"))));
        }
        if (episodes.Count == 0 && wanted is { } pw && seasonCounts.TryGetValue(pw, out var count) && count >= 1)
            episodes = Enumerable.Range(1, Math.Min(count, EpisodePlaceholderCap)).Select(i => new TitleEpisodeMeta(i, null, null, null, null, null)).ToList();

        var releaseDate = CatalogText.ParseReleaseDate(TmdbClient.Str(d, series ? "first_air_date" : "release_date"));
        var (released, next, checkedDates) = series ? (false, null, false) : HomeRelease(d, time.GetUtcNow().UtcDateTime);
        var today = time.GetUtcNow().UtcDateTime.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        var inWindow = !series && releaseDate is not null && string.CompareOrdinal(releaseDate, today) <= 0 && checkedDates && !released;
        var vote = TmdbClient.Num(d, "vote_average");

        return empty with
        {
            Season = series ? wanted : null,
            SeasonCount = series && seasonCounts.Count > 0 ? seasonCounts.Count : null,
            Seasons = seasonCounts.Keys.ToList(),
            Episodes = episodes,
            MoreLikeThis = (rail?.Items ?? []).Select(ToSimilarLink).ToList(),
            Overview = TmdbClient.Str(d, "overview").OrEmpty(null),
            Rating = vote is { } v && v > 0 ? Math.Round(v * 10, MidpointRounding.AwayFromZero) / 10 : null,
            ReleaseDate = releaseDate,
            InTheatricalWindow = inWindow,
            NextHomeReleaseAt = inWindow ? next : null,
            Genres = d.TryGetProperty("genres", out var g) && g.ValueKind == JsonValueKind.Array
                ? g.EnumerateArray().Select(x => TmdbClient.Str(x, "name")).OfType<string>().ToList() : [],
            VoteCount = TmdbClient.Int(d, "vote_count"),
            Certification = Certification(d, series),
            OriginalLanguage = TmdbClient.Str(d, "original_language").OrEmpty(null),
            Resolved = true,
        };
    }

    private async Task<RecommendationRail?> TmdbRecommendationsAsync(TitleExtrasQuery q, TmdbRef r, CancellationToken ct)
    {
        try
        {
            return await recommendations.RecommendationsForProviderAsync("tmdb", q.Title, r.MediaType,
                r.Id.ToString(CultureInfo.InvariantCulture), new HashSet<string>(), 12, ct).ConfigureAwait(false);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            logger.LogDebug(e, "TMDB recommendations unavailable");
            return null;
        }
    }

    /// <summary>US certification first, then any non-empty one.</summary>
    public static string? Certification(JsonElement d, bool series)
    {
        var entries = new List<(string Country, string Cert)>();
        if (series && d.TryGetProperty("content_ratings", out var cr) && cr.TryGetProperty("results", out var crs) && crs.ValueKind == JsonValueKind.Array)
            entries.AddRange(crs.EnumerateArray().Select(x => (TmdbClient.Str(x, "iso_3166_1") ?? "", TmdbClient.Str(x, "rating")?.Trim() ?? "")));
        if (!series && d.TryGetProperty("release_dates", out var rd) && rd.TryGetProperty("results", out var rds) && rds.ValueKind == JsonValueKind.Array)
            foreach (var c in rds.EnumerateArray())
                if (c.TryGetProperty("release_dates", out var list) && list.ValueKind == JsonValueKind.Array)
                    entries.AddRange(list.EnumerateArray().Select(x => (TmdbClient.Str(c, "iso_3166_1") ?? "", TmdbClient.Str(x, "certification")?.Trim() ?? "")));
        var valid = entries.Where(e => e.Cert.Length > 0).ToList();
        return valid.FirstOrDefault(e => e.Country == "US").Cert ?? valid.FirstOrDefault().Cert;
    }

    /// <summary>Digital / Physical / TV release evidence (types 4–6) from append_to_response=release_dates.</summary>
    public static (bool Released, string? Next, bool Checked) HomeRelease(JsonElement d, DateTime now)
    {
        if (!d.TryGetProperty("release_dates", out var rd) || !rd.TryGetProperty("results", out var rds) || rds.ValueKind != JsonValueKind.Array)
            return (false, null, false);
        var released = false;
        DateTime? next = null;
        foreach (var c in rds.EnumerateArray())
        {
            if (!c.TryGetProperty("release_dates", out var list) || list.ValueKind != JsonValueKind.Array) continue;
            foreach (var x in list.EnumerateArray())
            {
                if (!x.TryGetProperty("type", out var t) || !HomeReleaseTypes.Contains(t.GetRawText())) continue;
                if (!DateTime.TryParse(TmdbClient.Str(x, "release_date"), CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var at)) continue;
                if (at <= now) released = true;
                else if (next is null || at < next) next = at;
            }
        }
        return (released, next?.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture), true);
    }

    /// <summary>extras/route.ts toSimilarLink.</summary>
    public static TitleSimilar ToSimilarLink(Recommendation item)
    {
        var normalized = MediaTypes.Normalize(item.TitleMediaType);
        var series = normalized is "tv" or "anime";
        var key = WorkKeys.WorkKeyFor(item.Title, series ? null : item.Year);
        var mediaType = normalized ?? item.MediaType;
        var href = WorkKeys.TitlePath(key, new WorkKeys.TitleLink(item.Title, item.Year, mediaType, item.Provider, item.ExternalId,
            item.SourceMediaType, item.Format, item.IsSeries));
        return new TitleSimilar(key, href, item.Title, item.Year, mediaType, item.PosterUrl, item.Rating);
    }
}
