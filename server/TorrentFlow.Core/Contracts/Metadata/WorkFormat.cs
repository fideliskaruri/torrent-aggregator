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
/// <para>Anime is null while unknown (a TMDB or Cinemeta work its provider was never asked about) and is never read
/// as "not anime": a grab first asks the provider (bounded), and if the verdict is still unknown the release's own site
/// category decides the folder, exactly as for a send with no catalog work. A known verdict is never overridden.</para>
/// <para>One library per show (<see cref="AnimeVerdict"/>): when a work's provider is read again, its record decides,
/// except that a work that reads as anime now (an anime source, a stored "anime", or the legacy "anime" media type the
/// old title search gave donghua and Japanese co-productions) and already has downloads filed in an anime library
/// ("Anime Series", "Anime Movies") stays anime, and the refresh logs a note saying so. Its next episodes then land beside the
/// earlier ones instead of starting a second copy of the show under TV. Where a download landed never makes a work anime
/// that did not read as anime: WALL·E, filed under Anime Movies by an old name heuristic, stays a film for Movies.</para>
/// </summary>
public static class WorkKinds
{
    /// <summary>
    /// The anime verdict a work keeps when its provider's record is read: the record's own (<paramref name="provider"/>),
    /// or true when the work reads as anime now (<paramref name="current"/>) and its downloads are filed in an anime library.
    /// </summary>
    public static bool AnimeVerdict(bool provider, bool? current, bool filedInAnimeLibrary) =>
        provider || current == true && filedInAnimeLibrary;

    public static bool IsSeries(WorkFormat? format, string? mediaType) =>
        KnownSeries(format, mediaType) ?? string.Equals(mediaType?.Trim(), "anime", StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// Film or series only when the work says so: its format, else a media type that names one. Null while unknown,
    /// including the legacy "anime" type, which says nothing about films or series; a grab then goes by its own request
    /// (no season and episode is a film grab), never "anime means series".
    /// </summary>
    public static bool? KnownSeries(WorkFormat? format, string? mediaType) =>
        format is { } known ? known != WorkFormat.Movie
        : mediaType?.Trim().ToLowerInvariant() switch
        {
            "tv" or "series" or "show" or "tvshow" => true,
            "movie" or "film" => false,
            _ => null,
        };

    /// <summary>True or false when known; null while unknown (never "not anime").</summary>
    public static bool? IsAnime(string? provider, string? providerId, bool? anime, string? mediaType) =>
        AnimeIdentity.IsAnime(provider, null, providerId) ? true
        : anime ?? (string.Equals(mediaType, "anime", StringComparison.OrdinalIgnoreCase) ? true : null);
}