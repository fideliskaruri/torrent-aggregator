namespace TorrentFlow.Core.Contracts.Metadata;

/// <summary>
/// The one "is this anime?" rule for catalog works. Every grab (film, season, episode, request, wanted queue, picked
/// release) and the release classifier ask it, so an anime film and an anime series land under anime. A release with
/// no catalog work (search page, automation) also counts nyaa and other anime-site signals in the classifier.
/// </summary>
public static class AnimeIdentity
{
    /// <summary>An AniList identity or a catalog type of "anime".</summary>
    public static bool IsAnime(string? provider, string? mediaType) =>
        string.Equals(provider, "anilist", StringComparison.OrdinalIgnoreCase) || string.Equals(mediaType, "anime", StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// Catalog evidence: AniList or type "anime", an "Anime" genre, or Japanese animation (TMDB: original language ja and
    /// genre 16 "Animation"; Cinemeta: the "Animation" genre made in Japan). Western animation and live-action Japanese
    /// films are not anime.
    /// </summary>
    public static bool IsAnime(MediaMetadata? metadata) =>
        metadata != null && (IsAnime(metadata.Source, metadata.MediaType) || HasGenre(metadata.Genres, "Anime")
            || HasGenre(metadata.Genres, "Animation") && Japanese(metadata));

    private static bool Japanese(MediaMetadata metadata) =>
        string.Equals(metadata.OriginalLanguage, "ja", StringComparison.OrdinalIgnoreCase)
        || (metadata.OriginCountry?.Any(c => c.Equals("JP", StringComparison.OrdinalIgnoreCase) || c.Equals("Japan", StringComparison.OrdinalIgnoreCase)) ?? false);

    private static bool HasGenre(IReadOnlyList<string>? genres, string genre) =>
        genres?.Any(g => g.Equals(genre, StringComparison.OrdinalIgnoreCase)) ?? false;
}
