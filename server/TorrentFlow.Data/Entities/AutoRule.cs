using System;
using System.Collections.Generic;

namespace TorrentFlow.Data.Entities;

public partial class AutoRule
{
    public string Id { get; set; } = null!;

    public string UserId { get; set; } = null!;

    public string Name { get; set; } = null!;

    public string Query { get; set; } = null!;

    public string Category { get; set; } = null!;

    public int MinSeeders { get; set; }

    public long? MaxSizeBytes { get; set; }

    public string? Resolution { get; set; }

    public string? Sources { get; set; }

    public bool? Enabled { get; set; }

    public DateTime? LastRunAt { get; set; }

    public string? LastMatchTitle { get; set; }

    public string? LastMatchMagnet { get; set; }

    public int MatchCount { get; set; }

    public DateTime CreatedAt { get; set; }

    public DateTime UpdatedAt { get; set; }

    public virtual User User { get; set; } = null!;
}
