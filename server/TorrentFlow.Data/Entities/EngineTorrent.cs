using System;
using System.Collections.Generic;

namespace TorrentFlow.Data.Entities;

public partial class EngineTorrent
{
    public string Id { get; set; } = null!;

    public string UserId { get; set; } = null!;

    public string Hash { get; set; } = null!;

    public string Name { get; set; } = null!;

    public string? Magnet { get; set; }

    public string? SavePath { get; set; }

    public string? Category { get; set; }

    public string Status { get; set; } = null!;

    public double Progress { get; set; }

    public long SizeBytes { get; set; }

    public string? Error { get; set; }

    public string Origin { get; set; } = null!;

    public DateTime LastUsedAt { get; set; }

    public DateTime CreatedAt { get; set; }

    public DateTime UpdatedAt { get; set; }

    public string? TorrentUrl { get; set; }

    public string? VerifiedBitfield { get; set; }

    public string? VerifiedFilesJson { get; set; }

    public DateTime? VerifiedAt { get; set; }

    public string? EvictLease { get; set; }

    public string? EvictFrom { get; set; }

    public string? WorkId { get; set; }

    public string? QueueKey { get; set; }

    public DateTime? ForcedAt { get; set; }

    /// <summary>Queue lane rank (TorrentLane.Rank): 0 owner, 1 request, 2 automation. Lower starts first.</summary>
    public int Lane { get; set; }

    public virtual User User { get; set; } = null!;

    public virtual Work? Work { get; set; }
}
