using System;
using System.Collections.Generic;

namespace TorrentFlow.Data.Entities;

public partial class AcquisitionTarget
{
    public string Id { get; set; } = null!;

    public string UserId { get; set; } = null!;

    public string TargetKey { get; set; } = null!;

    public string WorkKey { get; set; } = null!;

    public string Scope { get; set; } = null!;

    public int? Season { get; set; }

    public int? Episode { get; set; }

    public int? PreferredResolution { get; set; }

    public string Status { get; set; } = null!;

    public double Progress { get; set; }

    public string? InfoHash { get; set; }

    public string? FilePath { get; set; }

    public string? Error { get; set; }

    public DateTime CreatedAt { get; set; }

    public DateTime UpdatedAt { get; set; }

    public string? WorkId { get; set; }

    public virtual User User { get; set; } = null!;

    public virtual Work? Work { get; set; }
}
