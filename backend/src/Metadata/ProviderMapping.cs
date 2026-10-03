using System.Globalization;
using System.Text.Json;
using TorrentFlow.Domain;

namespace TorrentFlow.Metadata;

internal sealed partial class MetadataService
{
    private static void MapTmdb(WorkBuilder b, JsonElement e, WorkKind kind)
    {
        var id = e.Text("id");
        if (id is null) return;
        var link = b.Link("tmdb", id, JsonFacts.Kind(kind));
        b.Name(e.Text(kind == WorkKind.Film ? "title" : "name"), NameLabel.English, link);
        b.Name(e.Text(kind == WorkKind.Film ? "original_title" : "original_name"), NameLabel.Original, link);
        foreach (var name in e.Obj("alternative_titles").Obj(kind == WorkKind.Film ? "titles" : "results").Items())
            b.Name(name.Text("title"), NameLabel.Synonym, link);
        var ids = e.Obj("external_ids");
        foreach (var provider in new[] { "imdb", "tvdb" })
            if (ids.Text(provider + "_id") is { Length: > 0 } external && external != "0") b.Link(provider, external);
        var genres = e.Obj("genres").Items().Select(g => g.Text("name")).OfType<string>().ToArray();
        var anime = b.Work.Anime ?? (genres.Contains("Animation") &&
            (e.Obj("origin_country").Strings().Contains("JP") || e.Obj("production_countries").Items().Any(c => c.Text("iso_3166_1") == "JP"))
                ? true : false);
        var released = JsonFacts.Date(e.Text(kind == WorkKind.Film ? "release_date" : "first_air_date"));
        var runtime = e.Int("runtime") ?? e.Obj("episode_run_time").Items()
            .Select(r => int.TryParse(r.ToString(), out var n) ? (int?)n : null).FirstOrDefault();
        var theatrical = EarliestRelease(e, [1, 2, 3]) ?? (kind == WorkKind.Film ? released : null);
        var digital = EarliestRelease(e, [4]);
        var physical = EarliestRelease(e, [5]);
        b.Work = b.Work with
        {
            Kind = kind, Format = kind == WorkKind.Film ? WorkFormat.Movie : WorkFormat.Series, Anime = anime,
            Year = released?.Year ?? b.Work.Year, OriginalLanguage = e.Text("original_language"),
            RuntimeMinutes = runtime is > 0 ? runtime : b.Work.RuntimeMinutes,
            PosterUrl = JsonFacts.Image(e.Text("poster_path"), "w500") ?? b.Work.PosterUrl,
            BackdropUrl = JsonFacts.Image(e.Text("backdrop_path"), "w1280") ?? b.Work.BackdropUrl,
            Synopsis = e.Text("overview"), Rating = e.Number("vote_average"), RatingSource = "tmdb",
            Genres = [.. genres], TheatricalAt = theatrical ?? b.Work.TheatricalAt,
            DigitalAt = digital ?? b.Work.DigitalAt, PhysicalAt = physical ?? b.Work.PhysicalAt,
            ReleasePrecision = theatrical is null && digital is null && physical is null ? DatePrecision.Unknown : DatePrecision.Day,
            ProviderStatus = e.Text("status"),
        };
    }

    private static DateTimeOffset? EarliestRelease(JsonElement e, int[] types) =>
        e.Obj("release_dates").Obj("results").Items().SelectMany(c => c.Obj("release_dates").Items())
            .Where(r => r.Int("type") is { } type && types.Contains(type)).Select(r => JsonFacts.Date(r.Text("release_date")))
            .OfType<DateTimeOffset>().Order().Cast<DateTimeOffset?>().FirstOrDefault();

    private static void MapAnime(WorkBuilder b, JsonElement e, bool overlay = false)
    {
        var link = b.Link("anilist", e.Text("id")!);
        if (e.Text("idMal") is { Length: > 0 } mal) b.Link("mal", mal);
        var titles = e.Obj("title");
        b.Name(titles.Text("english"), NameLabel.English, link);
        b.Name(titles.Text("romaji"), NameLabel.Romaji, link);
        b.Name(titles.Text("native"), NameLabel.Native, link);
        foreach (var name in e.Obj("synonyms").Strings()) b.Name(name, NameLabel.Synonym, link);
        var format = e.Text("format");
        var start = JsonFacts.Start(e.Obj("startDate"));
        b.Work = b.Work with
        {
            Anime = true,
            Kind = overlay ? b.Work.Kind : format == "MOVIE" ? WorkKind.Film : WorkKind.Series,
            Format = overlay ? b.Work.Format : format == "MOVIE" ? WorkFormat.Movie :
                format is "SPECIAL" or "OVA" or "MUSIC" ? WorkFormat.Special : WorkFormat.Series,
            Year = overlay ? b.Work.Year : e.Obj("startDate").Int("year") ?? e.Int("seasonYear"),
            OriginalLanguage = b.Work.OriginalLanguage ?? (e.Text("countryOfOrigin") == "JP" ? "ja" : null),
            RuntimeMinutes = e.Int("duration") ?? b.Work.RuntimeMinutes,
            PosterUrl = b.Work.PosterUrl ?? e.Obj("coverImage").Text("extraLarge") ?? e.Obj("coverImage").Text("large"),
            BackdropUrl = b.Work.BackdropUrl ?? e.Text("bannerImage"),
            Synopsis = b.Work.Synopsis ?? JsonFacts.Plain(e.Text("description")),
            Rating = b.Work.Rating ?? (e.Number("averageScore") is { } score ? Math.Clamp(score / 10, 0, 10) : null),
            RatingSource = b.Work.RatingSource ?? "anilist",
            Genres = b.Work.Genres.IsEmpty ? [.. e.Obj("genres").Strings()] : b.Work.Genres,
            ProviderStatus = e.Text("status"),
            TheatricalAt = format == "MOVIE" ? b.Work.TheatricalAt ?? start : b.Work.TheatricalAt,
            ReleasePrecision = format == "MOVIE" && start is not null ? DatePrecision.Day : b.Work.ReleasePrecision,
        };
    }

    private static void MapCinemeta(WorkBuilder b, JsonElement e, WorkKind requested)
    {
        var id = e.Text("imdb_id") ?? e.Text("id");
        if (id is null) return;
        var kind = e.Text("type") == "series" ? WorkKind.Series : e.Text("type") == "movie" ? WorkKind.Film : requested;
        var link = b.Link("imdb", id);
        b.Link("cinemeta", id, CinemetaClient.Kind(kind));
        b.Name(e.Text("name"), NameLabel.English, link);
        var tmdbId = e.Text("moviedb_id");
        if (tmdbId is { Length: > 0 } && tmdbId != "0") b.Link("tmdb", tmdbId, JsonFacts.Kind(kind));
        var genres = e.Obj("genres").Strings().Concat(e.Obj("genre").Strings()).Distinct().ToArray();
        var runtimeText = e.Text("runtime")?.Split(' ')[0];
        int? runtime = int.TryParse(runtimeText, out var minutes) && minutes > 0 ? minutes : null;
        var release = JsonFacts.Date(e.Text("released"));
        b.Work = b.Work with
        {
            Kind = kind, Format = kind == WorkKind.Film ? WorkFormat.Movie : WorkFormat.Series,
            Anime = genres.Contains("Anime") || genres.Contains("Animation") && e.Text("country") == "Japan",
            Year = JsonFacts.Year(e.Text("releaseInfo") ?? e.Text("year")) ?? release?.Year,
            RuntimeMinutes = runtime, PosterUrl = e.Text("poster"), BackdropUrl = e.Text("background"),
            Synopsis = e.Text("description"), Rating = e.Number("imdbRating"), RatingSource = "imdb",
            Genres = [.. genres], TheatricalAt = kind == WorkKind.Film ? release : null,
            PhysicalAt = kind == WorkKind.Film ? JsonFacts.Date(e.Text("dvdRelease")) : null,
            ReleasePrecision = kind == WorkKind.Film && release is not null ? DatePrecision.Day : DatePrecision.Unknown,
        };
        if (kind != WorkKind.Series) return;
        var videos = e.Obj("videos").Items().Where(v => v.Int("season") is >= 0 && v.Int("episode") is > 0)
            .OrderBy(v => v.Int("season")).ThenBy(v => v.Int("episode")).ToArray();
        var absolute = 0;
        foreach (var season in videos.GroupBy(v => v.Int("season")!.Value))
        {
            b.Season(season.Key, "Season " + season.Key, season.Count(), null);
            foreach (var episode in season)
                b.Episode(season.Key, episode.Int("episode")!.Value, season.Key == 0 ? null : ++absolute,
                    "imdb", episode.Text("id"), episode.Text("title"), JsonFacts.Date(episode.Text("released")),
                    DatePrecision.Day, runtime, MappingStatus.Confirmed,
                    episode.Text("overview"), episode.Text("thumbnail"));
        }
    }

    private void ApplyMap(WorkBuilder b, IEnumerable<AnimeMapEntry> entries)
    {
        foreach (var entry in entries)
        {
            b.Work = b.Work with { Anime = true };
            if (entry.AniList is { } ani) b.Link("anilist", ani.ToString(CultureInfo.InvariantCulture), source: "fribb", version: map.Version);
            if (entry.Mal is { } mal) b.Link("mal", mal.ToString(CultureInfo.InvariantCulture), source: "fribb", version: map.Version);
            if (entry.Tvdb is { } tvdb) b.Link("tvdb", tvdb.ToString(CultureInfo.InvariantCulture), source: "fribb", version: map.Version);
            if (b.Work.Kind == WorkKind.Series && entry.TmdbTv is { } tv)
                b.Link("tmdb", tv.ToString(CultureInfo.InvariantCulture), "tv", "fribb", map.Version);
            if (b.Work.Kind == WorkKind.Film)
                foreach (var movie in entry.TmdbMovies) b.Link("tmdb", movie.ToString(CultureInfo.InvariantCulture), "movie", "fribb", map.Version);
            foreach (var imdb in entry.Imdb) b.Link("imdb", imdb, source: "fribb", version: map.Version);
        }
    }

    private async Task TmdbSeasonsAsync(WorkBuilder b, JsonElement detail, bool force, CancellationToken ct)
    {
        var id = detail.Text("id")!;
        var allSeasons = detail.Obj("seasons").Items().Where(s => s.Int("season_number") is >= 0)
            .OrderBy(s => s.Int("season_number")).ToArray();
        var seasonNodes = allSeasons.Take(40).ToArray();
        b.Complete &= allSeasons.Length <= 40;
        var answers = await Task.WhenAll(seasonNodes.Select(s => tmdb.SeasonAsync(id, s.Int("season_number")!.Value, ct, force)));
        b.Seasons.Clear();
        b.Episodes.Clear();
        var absolute = 0;
        var prefixKnown = true;
        for (var i = 0; i < seasonNodes.Length; i++)
        {
            var number = seasonNodes[i].Int("season_number")!.Value;
            var answer = answers[i];
            var node = answer.Json ?? seasonNodes[i];
            var status = answer.Complete && !answer.Stale ? MappingStatus.Confirmed : MappingStatus.Unavailable;
            b.Complete &= answer.Complete;
            b.Stale |= answer.Stale;
            b.Season(number, node.Text("name"), seasonNodes[i].Int("episode_count"), node.Text("id"), status,
                node.Text("overview"), JsonFacts.Image(node.Text("poster_path"), "w500"));
            if (number > 0 && status == MappingStatus.Unavailable) prefixKnown = false;
            foreach (var e in node.Obj("episodes").Items().OrderBy(e => e.Int("episode_number")))
                if (e.Int("episode_number") is { } n)
                    b.Episode(number, n, number == 0 || !prefixKnown ? null : ++absolute, "tmdb", e.Text("id"), e.Text("name"),
                        JsonFacts.Date(e.Text("air_date")), DatePrecision.Day, e.Int("runtime") ?? b.Work.RuntimeMinutes,
                        !prefixKnown && number > 0 ? MappingStatus.Provisional : status,
                        e.Text("overview"), JsonFacts.Image(e.Text("still_path"), "w780"));
        }
    }

    private async Task TvmazeEpisodesAsync(WorkBuilder b, string imdbId, CancellationToken ct)
    {
        var answer = await cinemeta.TvmazeAsync("/lookup/shows?imdb=" + imdbId, ct);
        if (answer.Json is not { ValueKind: JsonValueKind.Object } show) { b.Complete = false; return; }
        var id = show.Text("id");
        if (id is null) return;
        var episodes = await cinemeta.TvmazeAsync("/shows/" + id + "?embed=episodes", ct);
        if (episodes.Json is not { ValueKind: JsonValueKind.Object } full) { b.Complete = false; return; }
        MapTvmaze(b, full, id);
    }

    private static void MapTvmaze(WorkBuilder b, JsonElement show, string id)
    {
        var link = b.Link("tvmaze", id);
        b.Name(show.Text("name"), b.Names.Count == 0 ? NameLabel.Original : NameLabel.Synonym, link);
        if (show.Obj("externals").Text("imdb") is { } imdb) b.Link("imdb", imdb);
        if (show.Obj("externals").Text("thetvdb") is { } tvdb) b.Link("tvdb", tvdb);
        b.Work = b.Work with
        {
            Kind = WorkKind.Series, Format = WorkFormat.Series,
            Year = b.Work.Year ?? JsonFacts.Year(show.Text("premiered")),
            RuntimeMinutes = b.Work.RuntimeMinutes ?? show.Int("averageRuntime") ?? show.Int("runtime"),
            Synopsis = b.Work.Synopsis ?? JsonFacts.Plain(show.Text("summary")),
            PosterUrl = b.Work.PosterUrl ?? show.Obj("image").Text("original"),
            Rating = b.Work.Rating ?? show.Obj("rating").Number("average"), ProviderStatus = show.Text("status"),
            Anime = b.Work.Anime ?? (show.Text("type") == "Animation" && show.Text("language") == "Japanese"),
        };
        var episodes = show.Obj("_embedded").Obj("episodes").Items().OrderBy(e => e.Int("season")).ThenBy(e => e.Int("number"));
        var absolute = 0;
        b.Seasons.Clear();
        b.Episodes.Clear();
        foreach (var group in episodes.Where(e => e.Int("number") is > 0).GroupBy(e => e.Int("season") ?? 1))
        {
            b.Season(group.Key, "Season " + group.Key, group.Count(), id);
            foreach (var e in group)
            {
                var instant = JsonFacts.Date(e.Text("airstamp"));
                b.Episode(group.Key, e.Int("number")!.Value, group.Key == 0 ? null : ++absolute,
                    "tvmaze", e.Text("id"), e.Text("name"), instant ?? JsonFacts.Date(e.Text("airdate")),
                    instant is null ? DatePrecision.Day : DatePrecision.Instant, e.Int("runtime"),
                    MappingStatus.Confirmed, JsonFacts.Plain(e.Text("summary")), e.Obj("image").Text("original"));
            }
        }
    }

    private static void MapItunes(WorkBuilder b, JsonElement movie)
    {
        var link = b.Link("itunes", movie.Text("trackId")!);
        b.Name(movie.Text("trackName"), NameLabel.English, link);
        b.Work = b.Work with
        {
            Kind = WorkKind.Film, Format = WorkFormat.Movie, Anime = null,
            Year = JsonFacts.Year(movie.Text("releaseDate")), TheatricalAt = JsonFacts.Date(movie.Text("releaseDate")),
            ReleasePrecision = DatePrecision.Day, Synopsis = movie.Text("longDescription"),
            RuntimeMinutes = movie.Int("trackTimeMillis") / 60000, PosterUrl = movie.Text("artworkUrl100"),
            Genres = movie.Text("primaryGenreName") is { } genre ? [genre] : [],
        };
    }
}
