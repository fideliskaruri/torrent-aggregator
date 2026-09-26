using System;
using System.Collections.Generic;

namespace TorrentFlow.Data.Entities;

public partial class WatchListItem
{
    public string Id { get; set; } = null!;

    public string UserId { get; set; } = null!;

    public string MediaType { get; set; } = null!;

    public string ExternalId { get; set; } = null!;

    public string Title { get; set; } = null!;

    public string? PosterUrl { get; set; }

    public string? Synopsis { get; set; }

    public double? Rating { get; set; }

    public string Status { get; set; } = null!;

    public bool? Monitored { get; set; }

    public DateTime LastChecked { get; set; }

    public DateTime? NextCheckAt { get; set; }

    public string? NextCheckReason { get; set; }

    public string? LastEpisode { get; set; }

    public int? FromSeason { get; set; }

    public int? FromEpisode { get; set; }

    public int? CursorSeason { get; set; }

    public int? CursorEpisode { get; set; }

    public int CursorMisses { get; set; }

    public string MonitorMode { get; set; } = null!;

    public string? LatestReleaseTitle { get; set; }

    public DateTime? LatestReleaseAt { get; set; }

    public string? LatestReleaseMagnet { get; set; }

    public string? NextEpisodeHint { get; set; }

    public DateTime CreatedAt { get; set; }

    public DateTime UpdatedAt { get; set; }

    public DateTime? SeederWaitSince { get; set; }

    public int? PreferredResolution { get; set; }

    public string? WorkId { get; set; }

    public virtual User User { get; set; } = null!;

    public virtual Work? Work { get; set; }
}
