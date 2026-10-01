using System;
using System.Collections.Generic;

namespace TorrentFlow.Data.Entities;

public partial class CatalogEntry
{
    public string Id { get; set; } = null!;

    public string WorkKey { get; set; } = null!;

    public string Title { get; set; } = null!;

    public int? Year { get; set; }

    public string MediaType { get; set; } = null!;

    public string? PosterUrl { get; set; }

    public string? BackdropUrl { get; set; }

    public string? Overview { get; set; }

    public double? Rating { get; set; }

    /// <summary>The provider that supplied <see cref="Rating"/> ("cinemeta", "tmdb", ...), or null when unknown.</summary>
    public string? RatingSource { get; set; }

    /// <summary>The metadata provider that identifies this title ("tmdb", "cinemeta", ...), or null when the chart write could not match one.</summary>
    public string? Provider { get; set; }

    /// <summary>The title's id at <see cref="Provider"/>.</summary>
    public string? ProviderId { get; set; }

    public string Source { get; set; } = null!;

    public int Rank { get; set; }

    public string? SeedTitle { get; set; }

    public int Seeders { get; set; }

    public string? BestRelease { get; set; }

    public DateTime RefreshedAt { get; set; }

    public DateTime CreatedAt { get; set; }

    public DateTime? ReleaseDate { get; set; }

    public string? WorkId { get; set; }

    public virtual Work? Work { get; set; }
}
