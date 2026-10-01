using System.Globalization;

namespace TorrentFlow.Metadata.Browse;

/// <summary>One provider list a home rail can be filled from. Feeds are tried in order; see CatalogService.RefreshHomeRailAsync.</summary>
public abstract record HomeFeed(string Provider);

/// <summary>A TMDB list. <see cref="Query"/> may name {today} or {today-N}, replaced with local dates at refresh.</summary>
public sealed record TmdbHomeFeed(string Path, string Query = "") : HomeFeed("tmdb");

/// <summary>A Cinemeta catalog (kind movie|series, catalog top|year) with an optional Cinemeta genre; "{year}" is this year.</summary>
public sealed record CinemetaHomeFeed(string Kind, string Catalog, string? Genre = null) : HomeFeed("cinemeta");

/// <summary>An AniList anime page by sort, optionally limited to this season or one AniList genre.</summary>
public sealed record AniListHomeFeed(string Sort, bool ThisSeason = false, string? Genre = null) : HomeFeed("anilist");

public sealed record HomeGenre(string Id, string Label);

/// <summary>One home rail. Its id is also its CatalogEntry partition (Source = id, SeedTitle = null).</summary>
public sealed record HomeRail(string Id, string Title, string Kind, HomeGenre? Genre, IReadOnlyList<HomeFeed> Feeds);

/// <summary>What /api/browse was asked for: all, one type, or one type's genre.</summary>
public sealed record HomeView(string Type, HomeRail? GenreRail)
{
    public static readonly HomeView All = new(HomeRails.AllView, null);
    public IReadOnlyList<HomeRail> Rails => GenreRail is { } genre ? [genre] : HomeRails.ForView(Type);
}

/// <summary>
/// The home page's rails, in order. One list drives the refresh, the payload and the genre chips, so a rail is added or
/// removed here and nowhere else.
/// </summary>
public static class HomeRails
{
    public const string AllView = "all";
    public const string Films = "films";
    public const string Series = "series";
    public const string Anime = "anime";
    public static readonly IReadOnlyList<string> Types = [Films, Series, Anime];

    // TMDB's "anime" keyword: anime has its own type, so series lists leave it out.
    private const string NotAnime = "without_keywords=210024";
    // News, talk and soap shows are not something to download.
    private const string NotTalk = "without_genres=10763|10767|10766";

    /// <summary>The All view, and each type's first three rails.</summary>
    public static readonly IReadOnlyList<HomeRail> Featured =
    [
        new("films-popular", "Popular films", Films, null,
            [new TmdbHomeFeed("/trending/movie/week"), new CinemetaHomeFeed("movie", "top")]),
        new("series-popular", "Popular series", Series, null,
            [new TmdbHomeFeed("/trending/tv/week"), new CinemetaHomeFeed("series", "top")]),
        new("anime-season", "Anime this season", Anime, null, [new AniListHomeFeed("POPULARITY_DESC", ThisSeason: true)]),
        // Released to buy or rent in the last 90 days: the films a release can exist for.
        new("films-new", "New films", Films, null,
        [
            new TmdbHomeFeed("/discover/movie",
                "region=US&with_release_type=4|5&release_date.gte={today-90}&release_date.lte={today}&sort_by=popularity.desc&vote_count.gte=20&include_adult=false"),
            new CinemetaHomeFeed("movie", "year", "{year}"),
        ]),
        new("series-new", "New series", Series, null,
        [
            new TmdbHomeFeed("/discover/tv",
                $"first_air_date.gte={{today-180}}&first_air_date.lte={{today}}&sort_by=popularity.desc&vote_count.gte=10&{NotTalk}&{NotAnime}&include_adult=false"),
            new CinemetaHomeFeed("series", "year", "{year}"),
        ]),
        new("anime-trending", "Trending anime", Anime, null, [new AniListHomeFeed("TRENDING_DESC")]),
        // Cinemeta's "Featured" list is not a rating sort, so top rated films and series need TMDB.
        new("films-top", "Top rated films", Films, null,
            [new TmdbHomeFeed("/discover/movie", "sort_by=vote_average.desc&vote_count.gte=5000&include_adult=false")]),
        new("series-top", "Top rated series", Series, null,
            [new TmdbHomeFeed("/discover/tv", $"sort_by=vote_average.desc&vote_count.gte=2000&{NotTalk}&{NotAnime}&include_adult=false")]),
        new("anime-top", "Top rated anime", Anime, null, [new AniListHomeFeed("SCORE_DESC")]),
    ];

    /// <summary>One rail per genre, shown on its type's view and as that genre's page.</summary>
    public static readonly IReadOnlyList<HomeRail> Genres =
    [
        Film("action", "Action", "Action films", 28, "Action"),
        Film("comedy", "Comedy", "Comedy films", 35, "Comedy"),
        Film("drama", "Drama", "Drama films", 18, "Drama"),
        Film("thriller", "Thriller", "Thrillers", 53, "Thriller"),
        Film("horror", "Horror", "Horror films", 27, "Horror"),
        Film("science-fiction", "Science fiction", "Science fiction films", 878, "Sci-Fi"),
        Film("crime", "Crime", "Crime films", 80, "Crime"),
        Film("romance", "Romance", "Romance films", 10749, "Romance"),
        Film("family", "Family", "Family films", 10751, "Family"),
        Film("documentary", "Documentary", "Documentaries", 99, "Documentary"),
        Show("drama", "Drama", "Drama series", 18, "Drama"),
        Show("comedy", "Comedy", "Comedy series", 35, "Comedy"),
        Show("crime", "Crime", "Crime series", 80, "Crime"),
        Show("action-adventure", "Action and adventure", "Action and adventure series", 10759, "Action"),
        Show("sci-fi-fantasy", "Sci-fi and fantasy", "Sci-fi and fantasy series", 10765, "Sci-Fi"),
        Show("mystery", "Mystery", "Mystery series", 9648, "Mystery"),
        Show("documentary", "Documentary", "Documentary series", 99, "Documentary"),
        Show("reality", "Reality", "Reality series", 10764, "Reality-TV"),
        AnimeGenre("action", "Action", "Action anime", "Action"),
        AnimeGenre("romance", "Romance", "Romance anime", "Romance"),
        AnimeGenre("fantasy", "Fantasy", "Fantasy anime", "Fantasy"),
        AnimeGenre("comedy", "Comedy", "Comedy anime", "Comedy"),
        AnimeGenre("slice-of-life", "Slice of life", "Slice of life anime", "Slice of Life"),
        AnimeGenre("sci-fi", "Sci-fi", "Sci-fi anime", "Sci-Fi"),
        AnimeGenre("sports", "Sports", "Sports anime", "Sports"),
        AnimeGenre("mystery", "Mystery", "Mystery anime", "Mystery"),
    ];

    public static readonly IReadOnlyList<HomeRail> Every = [.. Featured, .. Genres];

    /// <summary>The pool the Because rail falls back to when TMDB cannot recommend.</summary>
    public static readonly IReadOnlyList<string> RelatedPool = ["films-popular", "series-popular", "anime-trending"];

    private static HomeRail Film(string id, string label, string title, int tmdbGenre, string cinemetaGenre) =>
        new($"{Films}-{id}", title, Films, new(id, label),
        [
            new TmdbHomeFeed("/discover/movie", $"with_genres={tmdbGenre}&sort_by=popularity.desc&vote_count.gte=300&include_adult=false"),
            new CinemetaHomeFeed("movie", "top", cinemetaGenre),
        ]);

    private static HomeRail Show(string id, string label, string title, int tmdbGenre, string cinemetaGenre) =>
        new($"{Series}-{id}", title, Series, new(id, label),
        [
            new TmdbHomeFeed("/discover/tv", $"with_genres={tmdbGenre}&sort_by=popularity.desc&vote_count.gte=100&{NotTalk}&{NotAnime}&include_adult=false"),
            new CinemetaHomeFeed("series", "top", cinemetaGenre),
        ]);

    private static HomeRail AnimeGenre(string id, string label, string title, string aniListGenre) =>
        new($"{Anime}-{id}", title, Anime, new(id, label), [new AniListHomeFeed("POPULARITY_DESC", Genre: aniListGenre)]);

    /// <summary>All: the featured rails. A type: its featured rails, then its genre rails.</summary>
    public static IReadOnlyList<HomeRail> ForView(string type) =>
        type == AllView ? Featured : [.. Featured.Where(r => r.Kind == type), .. Genres.Where(r => r.Kind == type)];

    public static IReadOnlyList<HomeGenre> GenresOf(string type) =>
        [.. Genres.Where(r => r.Kind == type).Select(r => r.Genre!)];

    /// <summary>False for a type or genre home does not have. No type means All; a genre needs a type.</summary>
    public static bool TryParseView(string? type, string? genre, out HomeView view)
    {
        view = HomeView.All;
        var t = string.IsNullOrWhiteSpace(type) ? AllView : type.Trim().ToLowerInvariant();
        var g = string.IsNullOrWhiteSpace(genre) ? null : genre.Trim().ToLowerInvariant();
        if (t != AllView && !Types.Contains(t)) return false;
        if (g is null) { view = new HomeView(t, null); return true; }
        if (Genres.FirstOrDefault(r => r.Kind == t && r.Genre!.Id == g) is not { } rail) return false;
        view = new HomeView(t, rail);
        return true;
    }

    /// <summary>A TMDB feed's query with {today} / {today-N} resolved against the local day.</summary>
    public static List<(string, string)> TmdbQuery(string query, DateOnly today) =>
        [.. query.Split('&', StringSplitOptions.RemoveEmptyEntries).Select(pair =>
        {
            var at = pair.IndexOf('=');
            var value = pair[(at + 1)..];
            if (value.StartsWith("{today", StringComparison.Ordinal))
            {
                var days = value.Length > "{today}".Length && int.TryParse(value["{today".Length..^1], NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var d) ? d : 0;
                value = today.AddDays(days).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            }
            return (pair[..at], value);
        })];

    /// <summary>AniList's season for a day: anime seasons start in January, April, July and October.</summary>
    public static string AniListSeason(DateOnly day) => day.Month switch
    {
        <= 3 => "WINTER",
        <= 6 => "SPRING",
        <= 9 => "SUMMER",
        _ => "FALL",
    };
}
