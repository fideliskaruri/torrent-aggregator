using System.Text.RegularExpressions;

namespace TorrentFlow.Metadata.Artwork;

/// <summary>What an image is for. The size follows from the role, so a work's poster is the same URL on every page.</summary>
public enum ArtRole { Poster, Backdrop, Thumb, Profile }

/// <summary>The one builder of TMDB image URLs. The base comes from MetadataOptions.TmdbImageBaseUrl.</summary>
public static class TmdbImages
{
    public const string DefaultBase = "https://image.tmdb.org/t/p";

    public static string Size(ArtRole role) => role switch
    {
        ArtRole.Poster => "w500",
        ArtRole.Backdrop => "w1280",
        ArtRole.Thumb => "w300",
        ArtRole.Profile => "w185",
        _ => "original",
    };

    /// <summary>A TMDB file path ("/abc.jpg") as a full URL for the role, or null when there is no path.</summary>
    public static string? Url(string? imageBase, string? path, ArtRole role)
    {
        if (string.IsNullOrWhiteSpace(path)) return null;
        var root = string.IsNullOrWhiteSpace(imageBase) ? DefaultBase : imageBase.TrimEnd('/');
        return $"{root}/{Size(role)}{(path.StartsWith('/') ? path : "/" + path)}";
    }
}

/// <summary>
/// Provider-hosted art (AniList, iTunes, TVMaze) sized for its role where the provider's URL names a size.
/// Anything else, and roles a provider has no size for, pass through unchanged.
/// </summary>
public static partial class ProviderImages
{
    [GeneratedRegex(@"(anilistcdn/media/\w+/cover/)(?:small|medium|large)/")] private static partial Regex AniListCover();
    [GeneratedRegex(@"/\d+x\d+(?:bb)?(\.\w+)$")] private static partial Regex ItunesSize();
    [GeneratedRegex(@"(static\.tvmaze\.com/uploads/images/)(?:medium_portrait|original_untouched)/")] private static partial Regex TvmazeSize();

    public static string? Sized(string? url, ArtRole role)
    {
        if (string.IsNullOrWhiteSpace(url)) return null;
        var thumb = role is ArtRole.Thumb or ArtRole.Profile;
        if (url.Contains("anilistcdn", StringComparison.Ordinal))
            return AniListCover().Replace(url, m => $"{m.Groups[1].Value}{(thumb ? "medium" : "large")}/", 1);
        if (url.Contains("mzstatic.com", StringComparison.Ordinal))
            return ItunesSize().Replace(url, m => $"/{(thumb ? "300x450" : "600x900")}bb{m.Groups[1].Value}", 1);
        if (url.Contains("static.tvmaze.com", StringComparison.Ordinal))
            return TvmazeSize().Replace(url, m => $"{m.Groups[1].Value}{(thumb ? "medium_portrait" : "original_untouched")}/", 1);
        return url;
    }
}