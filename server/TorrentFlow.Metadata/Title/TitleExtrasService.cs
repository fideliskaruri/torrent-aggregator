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
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? StillUrl,
    string? AirStamp = null, bool? HasAired = null);

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
    /// <summary>Aired episode count per season number, when the provider can say. Missing season = unknown.</summary>
    public IReadOnlyDictionary<int, int> AiredEpisodes { get; init; } = new Dictionary<int, int>();
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
    AnimeFranchiseService franchises,
    TimeProvider time,
    ILogger<TitleExtrasService> logger, CinemetaClient? cinemeta = null, Browse.HomeReleaseCache? homeRelease = null)
{
    public const int ExtrasTimeoutMs = 4_000;
    public const int EpisodePlaceholderCap = 200;
    public const int AnimeEpisodePlaceholderCap = 5000;
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
        var memoKey = string.Join('\u0000', tmdb.CredentialRevision, q.WorkKey, q.Title, q.Year, q.MediaType, q.Season, q.Provider, q.ProviderId);
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
            var viewTask = franchises.ResolveAsync(new(q.Title, q.Year, q.MediaType, q.Provider, q.ProviderId), ct);
            var railTask = recommendations.RecommendationsForProviderAsync("anilist", q.Title, "anime", aid, new HashSet<string>(), 12, ct);
            _ = railTask.ContinueWith(t => logger.LogDebug(t.Exception, "AniList recommendations failed"),
                CancellationToken.None, TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
            var work = await workTask.ConfigureAwait(false);
            var view = await viewTask.ConfigureAwait(false);
            var rail = await railTask.ConfigureAwait(false);
            var m = work?.Metadata;
            // The franchise view numbers the page: a first season shows the matched show's seasons, names and stills; a
            // sequel entry, or a show with no confident match, keeps the entry's own Season 1 with the banner as art.
            var series = work?.IsSeries == true;
            var seasons = series ? view?.Seasons ?? [] : [];
            int? animeSeason = series ? (q.Season is >= 1 ? q.Season : seasons.Cast<int?>().FirstOrDefault() ?? 1) : null;
            var animeEpisodes = series && view is not null && animeSeason is { } shown
                ? view.EpisodesOf(shown).Select(e => new TitleEpisodeMeta(e.Episode, e.Name, e.Overview, e.AirDate, e.RuntimeMin, e.StillUrl,
                    e.AirStamp, HasAired: e.Aired)).ToList()
                : [];
            return empty with
            {
                MoreLikeThis = (rail?.Items ?? []).Select(ToSimilarLink).ToList(),
                Overview = m?.Synopsis, Rating = m?.Rating, RatingSource = m?.Rating is null ? null : "anilist",
                ReleaseDate = m?.ReleaseDate, Genres = m?.Genres ?? [],
                Season = animeSeason,
                SeasonCount = seasons.Count == 0 ? null : seasons.Count,
                Seasons = seasons,
                AiredEpisodes = series && view is not null
                    ? view.Episodes.GroupBy(e => e.Season).ToDictionary(g => g.Key, g => g.Count(e => e.Aired)) : new Dictionary<int, int>(),
                Episodes = animeEpisodes,
                Resolved = m is not null && (!series || animeEpisodes.Count > 0),
            };
        }

        TmdbRef? tmdbRef = null;
        if (tmdb.HasKey && q.Provider == "tmdb" && int.TryParse(q.ProviderId, NumberStyles.None, CultureInfo.InvariantCulture, out var tid))
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
        if (cinemeta is not null && (q.Provider == "cinemeta" || !isSeries))
        {
            var kind = isSeries ? "tv" : "movie";
            TorrentFlow.Core.Contracts.Metadata.MediaMetadata? metadata;
            if (q.Provider == "cinemeta" && q.ProviderId is { } imdb)
                metadata = await cinemeta.GetByIdAsync(imdb, kind, ct);
            else
            {
                var hits = (await cinemeta.SearchAsync(q.Title, kind, 5, ct))
                    .Where(m => ArtworkMatching.MatchTier(q.Title, m.Title) >= ArtworkMatching.MinAccept).ToList();
                metadata = q.Year is { } year
                    ? hits.FirstOrDefault(m => m.Year == year) ?? hits.FirstOrDefault(m => m.Year is { } y && Math.Abs(y - year) == 1)
                        ?? hits.FirstOrDefault(m => m.Year is null)
                    : hits.FirstOrDefault();
                // Search rows carry only id, name and poster; the synopsis, rating and genres live on /meta/{id}.
                if (metadata is { Synopsis: null, ExternalId: { } hitId })
                    metadata = await cinemeta.GetByIdAsync(hitId, kind, ct) ?? metadata;
            }
            // The film's home card evidence (TMDB release dates when there is a key) through the shared rule; with no key
            // that is the 21-day window on both pages.
            var signal = isSeries || metadata is null || homeRelease is null ? null
                : await homeRelease.SignalForAsync(q.Title, q.Year ?? metadata.Year, ct).ConfigureAwait(false);
            var gate = isSeries ? Browse.TheatricalGate.Open
                : Browse.HomeRelease.TheatricalGateFromSignal("movie", metadata?.ReleaseDate, signal, time.GetUtcNow());
            if (metadata is not null) result = result with { Overview = metadata.Synopsis, Rating = metadata.Rating,
                RatingSource = metadata.Rating is null ? null : "cinemeta", ReleaseDate = metadata.ReleaseDate,
                InTheatricalWindow = gate.InTheatricalWindow, NextHomeReleaseAt = gate.NextHomeReleaseAt,
                Genres = metadata.Genres ?? [], Resolved = true };
        }
        if (isSeries && normalized != "anime")
        {
            var show = q.Provider == "tvmaze" && int.TryParse(q.ProviderId, out var showId) ? await keyless.GetTvmazeShowAsync(showId, ct) :
                (await keyless.SearchTvmazeAsync(q.Title, 5, ExtrasTimeoutMs, ct).ConfigureAwait(false))
                    .FirstOrDefault(s => ArtworkMatching.MatchTier(q.Title, s.Title) >= ArtworkMatching.MinAccept);
            if (show is not null)
            {
                var episodes = await keyless.GetTvmazeEpisodesAsync(show.Id, ExtrasTimeoutMs, ct).ConfigureAwait(false);
                var seasons = episodes.Select(e => e.Season).Where(s => s >= 1).Distinct().Order().ToList();
                var wanted = q.Season is >= 1 ? q.Season : seasons.Cast<int?>().FirstOrDefault() ?? 1;
                // TS merges resolveWorkDetail (keyless-detail tvmazeDetail) into the TVmaze listing: the summary as
                // plain text, TVmaze's own 0–10 score, genres and premiere date.
                var overview = HtmlText.StripToText(show.Summary);
                var rating = show.Rating is > 0 and <= 10 ? Math.Round(show.Rating.Value * 10, MidpointRounding.AwayFromZero) / 10 : (double?)null;
                var genres = show.Genres.Select(g => g.Trim()).Where(g => g.Length > 0).DistinctBy(g => g.ToLowerInvariant()).ToList();
                var premiered = string.IsNullOrWhiteSpace(show.Premiered) ? null : show.Premiered.Trim();
                var today = time.GetUtcNow().UtcDateTime.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
                var aired = episodes.Where(e => e.Season >= 1 && e.Episode >= 1).GroupBy(e => e.Season)
                    .ToDictionary(g => g.Key, g => g.Count(e => !string.IsNullOrEmpty(e.AirDate) && string.CompareOrdinal(e.AirDate, today) <= 0));
                result = result with
                {
                    Season = wanted, SeasonCount = seasons.Count == 0 ? null : seasons.Count, Seasons = seasons, AiredEpisodes = aired,
                    Episodes = episodes.Where(e => e.Season == wanted).Select(e => new TitleEpisodeMeta(e.Episode, e.Name, null, e.AirDate, e.RuntimeMin, e.StillUrl, e.AirStamp)).ToList(),
                    Overview = overview, Rating = rating, RatingSource = rating is null ? null : "tvmaze",
                    ReleaseDate = premiered, Genres = genres.Count > 0 ? genres : result.Genres,
                    Resolved = seasons.Count > 0 || overview is not null || rating is not null || genres.Count > 0 || premiered is not null,
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
        // last_episode_to_air bounds what has aired: earlier seasons are complete, later ones have nothing yet.
        var airedEpisodes = new Dictionary<int, int>();
        if (series && d.TryGetProperty("last_episode_to_air", out var last) && last.ValueKind == JsonValueKind.Object &&
            TmdbClient.Int(last, "season_number") is { } lastSeason && TmdbClient.Int(last, "episode_number") is { } lastEpisode)
            foreach (var (n, c) in seasonCounts)
                airedEpisodes[n] = n < lastSeason ? c : n == lastSeason ? lastEpisode : 0;

        var episodes = new List<TitleEpisodeMeta>();
        if (series && wanted is { } w && await tmdb.FetchSeasonAsync(r.Id, w, ExtrasTimeoutMs, ct).ConfigureAwait(false) is { } season &&
            season.TryGetProperty("episodes", out var eps) && eps.ValueKind == JsonValueKind.Array)
        {
            foreach (var e in eps.EnumerateArray())
                if (TmdbClient.Int(e, "episode_number") is { } en)
                    episodes.Add(new TitleEpisodeMeta(en, TmdbClient.Str(e, "name"), TmdbClient.Str(e, "overview").OrEmpty(null),
                        CatalogText.ParseReleaseDate(TmdbClient.Str(e, "air_date")), TmdbClient.Int(e, "runtime"), tmdb.ImageUrl(TmdbClient.Str(e, "still_path"), Artwork.ArtRole.Thumb)));
        }
        if (episodes.Count == 0 && wanted is { } pw && seasonCounts.TryGetValue(pw, out var count) && count >= 1)
            episodes = Enumerable.Range(1, Math.Min(count, EpisodePlaceholderCap)).Select(i => new TitleEpisodeMeta(i, null, null, null, null, null)).ToList();

        var releaseDate = CatalogText.ParseReleaseDate(TmdbClient.Str(d, series ? "first_air_date" : "release_date"));
        // The same gate home cards use (HomeRelease.TheatricalGateFromSignal), fed by this detail's release_dates.
        var now = time.GetUtcNow();
        var gate = series ? Browse.TheatricalGate.Open : Browse.HomeRelease.TheatricalGateFromSignal("movie", releaseDate,
            Browse.HomeRelease.ClassifyHomeReleaseEvidence(Browse.HomeRelease.ReleaseDatesOf(d), now), now);
        var vote = TmdbClient.Num(d, "vote_average");

        return empty with
        {
            Season = series ? wanted : null,
            SeasonCount = series && seasonCounts.Count > 0 ? seasonCounts.Count : null,
            Seasons = seasonCounts.Keys.ToList(),
            AiredEpisodes = airedEpisodes,
            Episodes = episodes,
            MoreLikeThis = (rail?.Items ?? []).Select(ToSimilarLink).ToList(),
            Overview = TmdbClient.Str(d, "overview").OrEmpty(null),
            Rating = vote is { } v && v > 0 ? Math.Round(v * 10, MidpointRounding.AwayFromZero) / 10 : null,
            RatingSource = vote is > 0 ? "tmdb" : null,
            ReleaseDate = releaseDate,
            InTheatricalWindow = gate.InTheatricalWindow,
            NextHomeReleaseAt = gate.NextHomeReleaseAt,
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
