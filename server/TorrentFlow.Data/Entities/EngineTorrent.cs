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
    /// Where the payload is written until it is promoted (docs/english-gates-plan.md section 1):
    /// <c>&lt;download root&gt;\.staging\&lt;hash&gt;</c> on the same volume as <see cref="SavePath"/>. Null for rows that
    /// write straight into SavePath: <see cref="Legacy"/> rows, imports and recoveries.
    /// </summary>
    public string? StagePath { get; set; }

    /// <summary>
    /// The completion state once the payload is in (EnginePromotion): completed, checking, promoted, held or rejected.
    /// Null while it downloads. Only promoted counts as downloaded (<see cref="IsDownloaded(EngineTorrent)"/>).
    /// </summary>
    public string? Promotion { get; set; }

    /// <summary>Why the promotion gate held or rejected it, in plain words. Null otherwise.</summary>
    public string? PromotionReason { get; set; }

    /// <summary>Who chose the release (EngineProvenance): automatic (the finder, requests, swaps to the best) or hand.</summary>
    public string Provenance { get; set; } = "automatic";

    /// <summary>
    /// Added before staged downloads existed: it keeps writing into <see cref="SavePath"/> (no move mid-download) and still
    /// passes the promotion gate before it counts as downloaded. Rows already finished at the upgrade were promoted as they were.
    /// </summary>
    public bool Legacy { get; set; }

    public virtual User User { get; set; } = null!;

    public virtual Work? Work { get; set; }
}
