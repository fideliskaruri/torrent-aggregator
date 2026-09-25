using System.ComponentModel.DataAnnotations;

namespace TorrentFlow.Metadata;

/// <summary>Bound from <c>TorrentFlow:Metadata</c>; the flat env names the TS code reads (TMDB_API_KEY, …) are honoured as fallbacks.</summary>
public sealed class MetadataOptions
{
    public const string SectionName = "TorrentFlow:Metadata";

    /// <summary>TMDB_API_KEY: v3 key or v4 read-access token. Optional.</summary>
    public string? TmdbApiKey { get; set; }

    /// <summary>TMDB_BASE_URL (catalog client).</summary>
    [Url] public string TmdbBaseUrl { get; set; } = "https://api.themoviedb.org/3";

    /// <summary>TMDB_IMAGE_BASE_URL (catalog client).</summary>
    [Url] public string TmdbImageBaseUrl { get; set; } = "https://image.tmdb.org/t/p";

    /// <summary>ARTWORK_TIMEOUT_MS.</summary>
    [Range(1, 600_000)] public int ArtworkTimeoutMs { get; set; } = 5000;

    /// <summary>APIBAY_BASE_URL (catalog top-100 feeds).</summary>
    [Url] public string ApibayBaseUrl { get; set; } = "https://apibay.org";

    /// <summary>CATALOG_TIMER: "off" disables the background catalog refresh.</summary>
    public string? CatalogTimer { get; set; }
}
