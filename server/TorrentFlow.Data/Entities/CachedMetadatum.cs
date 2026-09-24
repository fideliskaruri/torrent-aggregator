using System;
using System.Collections.Generic;

namespace TorrentFlow.Data.Entities;

public partial class CachedMetadatum
{
    public string Id { get; set; } = null!;

    public string CacheKey { get; set; } = null!;

    public string Source { get; set; } = null!;

    public string MediaType { get; set; } = null!;

    public string ExternalId { get; set; } = null!;

    public string Title { get; set; } = null!;

    public string? PosterUrl { get; set; }

    public string? BackdropUrl { get; set; }

    public string? Synopsis { get; set; }

    public double? Rating { get; set; }

    public int? Year { get; set; }

    public string? Genres { get; set; }

    public string? RawJson { get; set; }

    public DateTime ExpiresAt { get; set; }

    public DateTime CreatedAt { get; set; }

    public DateTime UpdatedAt { get; set; }

    public DateTime? ReleaseDate { get; set; }
}
