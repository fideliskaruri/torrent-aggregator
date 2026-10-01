using System.Text.Json.Serialization;

namespace TorrentFlow.Core.Contracts.Metadata;

/// <summary>What a work is, as its provider tells it. Stored on the work as text; <see cref="WorkKinds.IsSeries"/> decides by it.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<WorkFormat>))]
public enum WorkFormat
{
    Movie,
    Series,
    Special
}

/// <summary>The one mapping from a provider's format or media type, and its language or country, to a work's.</summary>
public static class WorkFormats
{
    /// <summary>AniList by its <c>format</c>; every other provider by its media type (movie or tv). Null when it can't be told.</summary>
    public static WorkFormat? Of(MediaMetadata? metadata) =>
        metadata == null ? null
        : string.Equals(metadata.Source, "anilist", StringComparison.OrdinalIgnoreCase) ? FromAniList(metadata.Format)
        : FromMediaType(metadata.MediaType);

    public static WorkFormat? FromAniList(string? format) => format?.ToUpperInvariant() switch
    {
        "MOVIE" => WorkFormat.Movie,
        "TV" or "TV_SHORT" or "ONA" => WorkFormat.Series,
        "OVA" or "SPECIAL" or "MUSIC" => WorkFormat.Special,
        _ => null
    };

    /// <summary>"movie" or "tv" (TMDB, Cinemeta, TVmaze, a work's own media type); "anime" alone can't tell.</summary>
    public static WorkFormat? FromMediaType(string? mediaType) => mediaType?.ToLowerInvariant() switch
    {
        "movie" => WorkFormat.Movie,
        "tv" or "series" => WorkFormat.Series,
        _ => null
    };

    /// <summary>The ISO 639-1 original language of a provider record, or null.</summary>
    public static string? LanguageOf(MediaMetadata? metadata) => Language(metadata?.OriginalLanguage);

    /// <summary>
    /// A provider's language code as ISO 639-1: two lowercase letters. TMDB's "xx" (no language) is null and its "cn"
    /// (Cantonese) is "zh".
    /// </summary>
    public static string? Language(string? code)
    {
        var c = code?.Trim().ToLowerInvariant();
        if (c is not { Length: 2 } || !c.All(char.IsAsciiLetterLower) || c == "xx") return null;
        return c == "cn" ? "zh" : c;
    }

    /// <summary>AniList's <c>countryOfOrigin</c> as the language its works are made in: JP ja, KR ko, CN/TW zh.</summary>
    public static string? LanguageOfCountry(string? country) => country?.ToUpperInvariant() switch
    {
        "JP" => "ja",
        "KR" => "ko",
        "CN" or "TW" => "zh",
        _ => null
    };
}

/// <summary>
/// The one owner of "is this work a film or a series" and "is it anime". Film or series is the work's stored
/// <see cref="WorkFormat"/> (Movie is a film; Series and Special have episodes), falling back to its media type only
/// while the format is unknown. Anime is the work's own metadata: an anime source (AniList, Kitsu, MAL, AniDB, an anime
/// addon id) is anime outright, otherwise the classification stored from its provider record
/// (<see cref="AnimeIdentity.IsAnime(MediaMetadata?)"/>); a legacy "anime" media type counts only while that is unknown.
/// Anime decides the library folder only; film or series decides the layout.
/// </summary>
public static class WorkKinds
{
    public static bool IsSeries(WorkFormat? format, string? mediaType) =>
        format is { } known ? known != WorkFormat.Movie
        : mediaType?.Trim().ToLowerInvariant() is "tv" or "series" or "show" or "tvshow" or "anime";

    public static bool IsAnime(string? provider, string? providerId, bool? anime, string? mediaType) =>
        AnimeIdentity.IsAnime(provider, null, providerId)
        || (anime ?? string.Equals(mediaType, "anime", StringComparison.OrdinalIgnoreCase));
}