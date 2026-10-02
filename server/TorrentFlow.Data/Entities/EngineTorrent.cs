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

    /// <summary>
    /// Why <see cref="ForcedAt"/> is set: "now" when the owner pressed Download now, "legacy" for rows forced before
    /// the reason was stored (an old resume). Cleared with ForcedAt.
    /// </summary>
    public string? ForcedReason { get; set; }

    /// <summary>Queue lane rank (TorrentLane.Rank): 0 owner, 1 request, 2 automation. Lower starts first.</summary>
    public int Lane { get; set; }

    /// <summary>JSON array of the torrent file indexes to download. Null means every file (all ordinary transfers).</summary>
    public string? SelectedFilesJson { get; set; }

    /// <summary>
    /// The English check this transfer still owes (docs/release-language.md): the want, the site category and its state,
    /// as JSON. Null for transfers that were never checked (imports, older rows).
    /// </summary>
    public string? LanguageCheckJson { get; set; }

    /// <summary>
    /// When the Library took this finished download into account (added its title, found it already there, or found its
    /// files gone). Null for a download not finished yet, and for one that finished before the Library did this or while
    /// the app was stopping: those are picked up at the next start.
    /// </summary>
    public DateTime? LibraryCheckedAt { get; set; }

    public virtual User User { get; set; } = null!;

    public virtual Work? Work { get; set; }
}
