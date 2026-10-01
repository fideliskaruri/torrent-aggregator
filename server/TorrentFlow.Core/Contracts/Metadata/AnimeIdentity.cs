namespace TorrentFlow.Core.Contracts.Metadata;

/// <summary>
/// The one "is this anime?" rule. Every grab (film, season, episode, request, wanted queue, picked release) and the
/// release classifier ask it, so an anime film and an anime series land under anime.
/// Owner's rule, in order: metadata from an anime source (AniList, Kitsu, MyAnimeList, AniDB, an anime Cinemeta addon,
/// or a nyaa anime category) is anime, with no other check. Only metadata from TMDB or Cinemeta falls back to the
/// genres: an "Anime" genre, or Animation made in Japan (TMDB original language ja and genre 16).
/// A catalog work stores the answer (<c>Work.Anime</c>) and is read through <see cref="WorkKinds"/>; a title search in
/// the anime catalog or a release's site category never changes it.
/// </summary>
public static class AnimeIdentity
{
    private static readonly HashSet<string> AnimeSources = new(StringComparer.OrdinalIgnoreCase)
        { "anilist", "kitsu", "mal", "myanimelist", "anidb", "nyaa", "animetosho", "subsplease" };

    /// <summary>An anime metadata source (or its id, such as an anime addon's "kitsu:123"), or a catalog type of "anime".</summary>
    public static bool IsAnime(string? provider, string? mediaType, string? providerId = null) =>
        IsAnimeSource(provider) || string.Equals(mediaType, "anime", StringComparison.OrdinalIgnoreCase)
        || providerId?.Split(':', 2) is [var prefix, _] && IsAnimeSource(prefix);

    /// <summary>A release from a site's anime category (nyaa "Anime - …", Torznab 5070, an adapter's "anime").</summary>
    public static bool IsAnimeSiteCategory(string? category) =>
        !string.IsNullOrWhiteSpace(category) && (category.Contains("anime", StringComparison.OrdinalIgnoreCase)
            || category.Split(',', StringSplitOptions.TrimEntries).Contains("5070"));

    public static bool IsAnime(MediaMetadata? metadata) =>
        metadata != null && (IsAnime(metadata.Source, metadata.MediaType, metadata.ExternalId)
            || IsGenreSource(metadata.Source) && (HasGenre(metadata.Genres, "Anime") || HasGenre(metadata.Genres, "Animation") && Japanese(metadata)));

    private static bool IsAnimeSource(string? source) => source != null && AnimeSources.Contains(source);

    private static bool IsGenreSource(string? source) =>
        string.Equals(source, "tmdb", StringComparison.OrdinalIgnoreCase) || string.Equals(source, "cinemeta", StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// Made in Japan: original language Japanese, or, when the language is unknown, Japan named first among the origin
    /// countries. A co-production that only lists Japan later (Cinemeta's WALL·E: "United States, Japan") is not.
    /// </summary>
    private static bool Japanese(MediaMetadata metadata) =>
        WorkFormats.Language(metadata.OriginalLanguage) is { } language ? language == "ja"
        : metadata.OriginCountry is [var origin, ..] && origin.Trim() is var first
            && (first.Equals("JP", StringComparison.OrdinalIgnoreCase) || first.Equals("Japan", StringComparison.OrdinalIgnoreCase));

    private static bool HasGenre(IReadOnlyList<string>? genres, string genre) =>
        genres?.Any(g => g.Equals(genre, StringComparison.OrdinalIgnoreCase)) ?? false;
}
