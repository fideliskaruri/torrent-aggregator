using System;
using System.Collections.Generic;

namespace TorrentFlow.Data.Entities;

public partial class PlaybackProgress
{
    public string Id { get; set; } = null!;

    public string UserId { get; set; } = null!;

    public string InfoHash { get; set; } = null!;

    public string FilePath { get; set; } = null!;

    public double PositionSec { get; set; }

    public double? DurationSec { get; set; }

    public DateTime? CompletedAt { get; set; }

    public string Title { get; set; } = null!;

    public int? Season { get; set; }

    public int? Episode { get; set; }

    public string? WatchListItemId { get; set; }

    public string? PosterUrl { get; set; }

    public DateTime CreatedAt { get; set; }

    public DateTime UpdatedAt { get; set; }

    public string? WorkId { get; set; }

    public virtual User User { get; set; } = null!;

    public virtual Work? Work { get; set; }
}
