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
