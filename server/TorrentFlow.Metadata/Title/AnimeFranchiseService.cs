using System.Globalization;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Metadata.Artwork;
using TorrentFlow.Metadata.Caching;
using TorrentFlow.Metadata.Catalog;
using TorrentFlow.Metadata.Providers;

namespace TorrentFlow.Metadata.Title;

public sealed record FranchiseQuery(string Title, int? Year, string? MediaType, string? Provider, string? ProviderId);

/// <summary>
/// One regular episode as the title page numbers it (<see cref="Season"/>, <see cref="Episode"/>), with its franchise
/// (absolute) number and the AniList entry that numbers it as its own episode <see cref="AniListEpisode"/>.
/// </summary>
public sealed record FranchiseEpisode(int Season, int Episode, int? Absolute, bool Aired, string? AniListId, int? AniListEpisode,
    string? Name = null, string? Overview = null, string? AirDate = null, string? AirStamp = null, int? RuntimeMin = null,
    string? StillUrl = null);

/// <param name="Source">Whose numbering the page uses: tmdb or tvmaze when a show matched, anilist for an entry's own Season 1.</param>
/// <param name="Banner">The entry's AniList banner, the art for episodes the show has no still for.</param>
public sealed record FranchiseView(string Source, IReadOnlyList<FranchiseEpisode> Episodes, string? Banner)
{
    public IReadOnlyList<int> Seasons => Episodes.Select(e => e.Season).Distinct().Order().ToList();
    public IReadOnlyList<FranchiseEpisode> EpisodesOf(int season) => Episodes.Where(e => e.Season == season).ToList();

    /// <summary>An episode has aired once its air time (or, without one, its air day) has passed.</summary>
    public static bool HasAired(string? airDate, string? airStamp, DateTimeOffset now) =>
        DateTimeOffset.TryParse(airStamp, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var at) ? at <= now :
        DateOnly.TryParse(airDate?.Length >= 10 ? airDate[..10] : airDate, CultureInfo.InvariantCulture, DateTimeStyles.None, out var day) &&
        day <= DateOnly.FromDateTime(now.UtcDateTime);
}

/// <summary>
/// The anime season shape: an AniList franchise (first season and its sequel cours) laid over the one TMDB or TVmaze
/// show it belongs to. The show is pinned by the work's own provider id, or else found by an exact title and premiere
/// match (one Animation candidate only), so each episode carries the show's season and episode, its absolute number and
/// its AniList entry numbering. With no confident show the entry keeps its own Season 1 and the banner as art.
/// </summary>
public sealed class AnimeFranchiseService(AniListClient anilist, TmdbClient tmdb, KeylessClients keyless, TimeProvider time,
    ILogger<AnimeFranchiseService> logger)
{
    private const int TimeoutMs = 5_000;
    private const int MaxSeasons = 40;
    private readonly BoundedTtlCache<FranchiseView?> _views = new(200, time);
    private readonly SingleFlight<FranchiseView?> _flight = new();

    private sealed record Show(string Source, IReadOnlyList<FranchiseEpisode> Episodes);

    public async Task<FranchiseView?> ResolveAsync(FranchiseQuery q, CancellationToken ct)
    {
        if (!AnimeIdentity.IsAnime(q.Provider, MediaTypes.Normalize(q.MediaType), q.ProviderId) || q.Provider == "anilist" && q.ProviderId is null) return null;
        var key = string.Join('\u0000', tmdb.CredentialRevision, tmdb.HasKey, q.Provider, q.ProviderId, q.Title, q.Year);
        if (_views.TryGet(key, out var cached)) return cached;
        return await _flight.RunAsync(key, async () =>
        {
            FranchiseView? view = null;
            try { view = await BuildAsync(q, CancellationToken.None).ConfigureAwait(false); }
            catch (Exception e) when (e is HttpRequestException or OperationCanceledException or JsonException)
            {
                logger.LogDebug(e, "Anime season shape unavailable for {Title}", q.Title);
            }
            _views.Set(key, view, view is { Source: not "anilist" } ? TimeSpan.FromHours(1) : TimeSpan.FromMinutes(5));
            return view;
        }, ct).ConfigureAwait(false);
    }

    private async Task<FranchiseView?> BuildAsync(FranchiseQuery q, CancellationToken ct)
    {
        var franchise = q.Provider == "anilist"
            ? await anilist.GetFranchiseAsync(q.ProviderId!, ct).ConfigureAwait(false)
            : await FindFranchiseAsync(q, ct).ConfigureAwait(false);
        if (franchise is null)
            return q.Provider == "anilist" && await anilist.GetWorkByIdAsync(q.ProviderId!, ct).ConfigureAwait(false) is { IsSeries: true } work
                ? EntryPage(new([new(work, null)], 0), null, work.Metadata.BackdropUrl) : null;
        var show = franchise.Root.Offset is null ? null : await ShowAsync(q, franchise.Root.Work.Metadata, ct).ConfigureAwait(false);
        var banner = franchise.Requested.Work.Metadata.BackdropUrl ?? franchise.Root.Work.Metadata.BackdropUrl;
        // A sequel's own AniList page keeps its own Season 1; the show only lends it names and stills.
        if (franchise.RequestedIndex > 0 || show is null) return q.Provider == "anilist" ? EntryPage(franchise, show, banner) : null;
        return ShowPage(franchise, show, banner);
    }

    private static FranchiseView ShowPage(AniListFranchise franchise, Show show, string? banner)
    {
        var episodes = new List<FranchiseEpisode>(show.Episodes.Count);
        foreach (var (e, absolute) in show.Episodes.Select((e, i) => (e, i + 1)))
        {
            var at = franchise.Locate(absolute);
            episodes.Add(e with { Absolute = absolute, Aired = e.Aired || e.AirDate is null && absolute <= franchise.AiredThrough,
                AniListId = at?.Entry.Id, AniListEpisode = at?.Episode, StillUrl = e.StillUrl ?? banner });
        }
        // AniList can know an aired cour the show's listing has not added yet: it continues the show's last season.
        if (show.Episodes.Count > 0)
        {
            var last = show.Episodes[^1];
            for (var absolute = show.Episodes.Count + 1; absolute <= franchise.AiredThrough &&
                absolute <= TitleExtrasService.AnimeEpisodePlaceholderCap; absolute++)
            {
                var at = franchise.Locate(absolute);
                episodes.Add(new(last.Season, last.Episode + absolute - show.Episodes.Count, absolute, true, at?.Entry.Id, at?.Episode,
                    StillUrl: banner));
            }
        }
        return new(show.Source, episodes, banner);
    }

    private static FranchiseView EntryPage(AniListFranchise franchise, Show? show, string? banner)
    {
        var entry = franchise.Requested;
        var count = Math.Min(entry.Work.EpisodeCount ?? entry.Work.AiredEpisodeCount ?? 0, TitleExtrasService.AnimeEpisodePlaceholderCap);
        var aired = entry.Work.AiredEpisodeCount ?? 0;
        var episodes = Enumerable.Range(1, Math.Max(0, count)).Select(i =>
        {
            int? absolute = entry.Offset is { } offset ? offset + i : null;
            var meta = absolute is { } a && show is not null && a <= show.Episodes.Count ? show.Episodes[a - 1] : null;
            return new FranchiseEpisode(1, i, absolute, i <= aired || meta?.Aired == true, entry.Id, i, meta?.Name, meta?.Overview,
                meta?.AirDate, meta?.AirStamp, meta?.RuntimeMin, meta?.StillUrl ?? banner);
        }).ToList();
        return new("anilist", episodes, banner);
    }

    /// <summary>A non-AniList anime work's franchise: the one AniList first season with exactly this title and year.</summary>
    private async Task<AniListFranchise?> FindFranchiseAsync(FranchiseQuery q, CancellationToken ct)
    {
        var wanted = ArtworkMatching.NormalizeTitleForMatch(q.Title);
        if (wanted.Length == 0) return null;
        var hits = (await anilist.SearchWorksAsync(q.Title, 8, ct).ConfigureAwait(false))
            .Where(w => w.IsSeries && (q.Year is null || w.Metadata.Year == q.Year) &&
                (w.Metadata.Aliases ?? []).Any(a => ArtworkMatching.NormalizeTitleForMatch(a) == wanted))
            .DistinctBy(w => w.Metadata.ExternalId).ToList();
        if (hits.Count != 1) return null;
        return await anilist.GetFranchiseAsync(hits[0].Metadata.ExternalId, ct).ConfigureAwait(false) is { RequestedIndex: 0 } franchise
            ? franchise : null;
    }

    private async Task<Show?> ShowAsync(FranchiseQuery q, TorrentFlow.Core.Contracts.Metadata.MediaMetadata root, CancellationToken ct)
    {
        if (q.Provider == "tmdb" && int.TryParse(q.ProviderId, NumberStyles.None, CultureInfo.InvariantCulture, out var tmdbId))
            return tmdb.HasKey ? await TmdbShowAsync(tmdbId, null, ct).ConfigureAwait(false) : null;
        if (q.Provider == "tvmaze" && int.TryParse(q.ProviderId, NumberStyles.None, CultureInfo.InvariantCulture, out var tvmazeId))
            return await TvmazeShowAsync(tvmazeId, ct).ConfigureAwait(false);
        var names = (root.Aliases ?? []).Prepend(root.Title).Select(n => n.Replace('\u2019', '\'').Trim())
            .Where(n => ArtworkMatching.NormalizeTitleForMatch(n).Length > 0)
            .DistinctBy(ArtworkMatching.NormalizeTitleForMatch).ToList();
        if (names.Count == 0) return null;
        if (tmdb.HasKey && await MatchTmdbAsync(names, root, ct).ConfigureAwait(false) is { } match &&
            await TmdbShowAsync(match.Id, match.Detail, ct).ConfigureAwait(false) is { } fromTmdb) return fromTmdb;
        return await MatchTvmazeAsync(names, root, ct).ConfigureAwait(false) is { } showId
            ? await TvmazeShowAsync(showId, ct).ConfigureAwait(false) : null;
    }

    private async Task<(int Id, JsonElement Detail)?> MatchTmdbAsync(IReadOnlyList<string> names, TorrentFlow.Core.Contracts.Metadata.MediaMetadata root,
        CancellationToken ct)
    {
        var keys = names.Select(ArtworkMatching.NormalizeTitleForMatch).ToHashSet(StringComparer.Ordinal);
        foreach (var name in names.Take(2))
        {
            var hits = (await tmdb.SearchCandidatesAsync("tv", name, root.Year, 10, TimeoutMs, ct).ConfigureAwait(false))
                .Where(c => keys.Contains(ArtworkMatching.NormalizeTitleForMatch(c.Title)) && c.Year == root.Year)
                .DistinctBy(c => c.Id).ToList();
            if (hits.Count > 1) return null;
            if (hits.Count == 0) continue;
            if (await tmdb.FetchDetailAsync("tv", hits[0].Id, TimeoutMs, ct).ConfigureAwait(false) is not { } detail) return null;
            var animation = detail.TryGetProperty("genres", out var genres) && genres.ValueKind == JsonValueKind.Array &&
                genres.EnumerateArray().Any(g => TmdbClient.Int(g, "id") == 16);
            return animation && SameStart(TmdbClient.Str(detail, "first_air_date"), root) ? (hits[0].Id, detail) : null;
        }
        return null;
    }

    private async Task<int?> MatchTvmazeAsync(IReadOnlyList<string> names, TorrentFlow.Core.Contracts.Metadata.MediaMetadata root, CancellationToken ct)
    {
        var keys = names.Select(ArtworkMatching.NormalizeTitleForMatch).ToHashSet(StringComparer.Ordinal);
        foreach (var name in names.Take(2))
        {
            var hits = (await keyless.SearchTvmazeAsync(name, 10, TimeoutMs, ct).ConfigureAwait(false))
                .Where(s => s.Type == "Animation" && keys.Contains(ArtworkMatching.NormalizeTitleForMatch(s.Title)) && SameStart(s.Premiered, root))
                .DistinctBy(s => s.Id).ToList();
            if (hits.Count > 1) return null;
            if (hits.Count == 1) return hits[0].Id;
        }
        return null;
    }

    /// <summary>The show premiered when the first AniList season did: the same year, or within a week across New Year.</summary>
    private static bool SameStart(string? premiered, TorrentFlow.Core.Contracts.Metadata.MediaMetadata root)
    {
        if (!DateOnly.TryParse(premiered?.Length >= 10 ? premiered[..10] : premiered, CultureInfo.InvariantCulture, DateTimeStyles.None, out var day))
            return false;
        if (day.Year == root.Year) return true;
        return DateOnly.TryParse(root.ReleaseDate, CultureInfo.InvariantCulture, DateTimeStyles.None, out var start) &&
            Math.Abs(day.DayNumber - start.DayNumber) <= 7;
    }

    private async Task<Show?> TmdbShowAsync(int id, JsonElement? known, CancellationToken ct)
    {
        if ((known ?? await tmdb.FetchDetailAsync("tv", id, TimeoutMs, ct).ConfigureAwait(false)) is not { } detail ||
            !detail.TryGetProperty("seasons", out var seasons) || seasons.ValueKind != JsonValueKind.Array) return null;
        var numbers = seasons.EnumerateArray().Select(s => TmdbClient.Int(s, "season_number")).OfType<int>()
            .Where(n => n >= 1).Distinct().Order().Take(MaxSeasons).ToList();
        var now = time.GetUtcNow();
        var episodes = new List<FranchiseEpisode>();
        foreach (var number in numbers)
        {
            // A season that cannot be read would shift every later absolute number, so the show is not used.
            if (await tmdb.FetchSeasonAsync(id, number, TimeoutMs, ct).ConfigureAwait(false) is not { } season ||
                !season.TryGetProperty("episodes", out var rows) || rows.ValueKind != JsonValueKind.Array) return null;
            foreach (var row in rows.EnumerateArray())
            {
                if (TmdbClient.Int(row, "episode_number") is not { } episode || episode < 1) continue;
                var airDate = CatalogText.ParseReleaseDate(TmdbClient.Str(row, "air_date"));
                episodes.Add(new(number, episode, null, FranchiseView.HasAired(airDate, null, now), null, null,
                    TmdbClient.Str(row, "name"), TmdbClient.Str(row, "overview").OrEmpty(null), airDate, null,
                    TmdbClient.Int(row, "runtime"), tmdb.ImageUrl(TmdbClient.Str(row, "still_path"), Artwork.ArtRole.Thumb)));
            }
        }
        return Regular("tmdb", episodes);
    }

    private async Task<Show?> TvmazeShowAsync(int id, CancellationToken ct)
    {
        var now = time.GetUtcNow();
        var episodes = (await keyless.GetTvmazeEpisodesAsync(id, TimeoutMs, ct).ConfigureAwait(false))
            .Select(e => new FranchiseEpisode(e.Season, e.Episode, null, FranchiseView.HasAired(e.AirDate, e.AirStamp, now), null, null,
                e.Name, e.Overview, e.AirDate, e.AirStamp, e.RuntimeMin, e.StillUrl)).ToList();
        return Regular("tvmaze", episodes);
    }

    /// <summary>Regular episodes only (specials have no place in the absolute order), each season and episode once, in order.</summary>
    private static Show? Regular(string source, IEnumerable<FranchiseEpisode> episodes)
    {
        var regular = episodes.Where(e => e.Season >= 1 && e.Episode >= 1).DistinctBy(e => (e.Season, e.Episode))
            .OrderBy(e => e.Season).ThenBy(e => e.Episode).ToList();
        return regular.Count == 0 ? null : new(source, regular);
    }
}
