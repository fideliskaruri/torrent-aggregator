using System;

namespace TorrentFlow.Data.Entities;

/// <summary>A signed-in friend's request for a title. The owner decides; approval links it to library rows later.</summary>
public partial class MediaRequest
{
    public string Id { get; set; } = null!;

    public string RequestedByUserId { get; set; } = null!;

    /// <summary>tmdb | anilist | tvmaze | itunes.</summary>
    public string Provider { get; set; } = null!;

    public string? ProviderId { get; set; }

    public string WorkKey { get; set; } = null!;

    /// <summary>movie | tv | anime.</summary>
    public string MediaType { get; set; } = null!;

    public string Title { get; set; } = null!;

    public int? Year { get; set; }

    public string? PosterUrl { get; set; }

    /// <summary>movie | seasons | series.</summary>
    public string Scope { get; set; } = null!;

    /// <summary>Comma-separated season numbers when <see cref="Scope"/> is <c>seasons</c>.</summary>
    public string? Seasons { get; set; }

    public string? Note { get; set; }

    /// <summary>pending | approved | declined | fulfilled | failed | cancelled.</summary>
    public string Status { get; set; } = null!;

    public string? DecisionReason { get; set; }

    public DateTime? DecidedAt { get; set; }

    public DateTime CreatedAt { get; set; }

    public DateTime UpdatedAt { get; set; }

    public string? WatchListItemId { get; set; }

    public string? AcquisitionTargetId { get; set; }

    public virtual User RequestedBy { get; set; } = null!;
}
