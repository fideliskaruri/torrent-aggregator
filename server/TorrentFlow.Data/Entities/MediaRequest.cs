using System;

namespace TorrentFlow.Data.Entities;

/// <summary>A signed-in friend's request for a title. The owner decides; approval links it to library rows later.</summary>
public partial class MediaRequest
{
    public string Id { get; set; } = null!;

    public string RequestedByUserId { get; set; } = null!;

    /// <summary>tmdb | anilist | tvmaze | cinemeta | itunes.</summary>
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

    /// <summary>pending | approved | partial | declined | fulfilled | failed | cancelled.</summary>
    public string Status { get; set; } = null!;

    public string? DecisionReason { get; set; }

    public DateTime? DecidedAt { get; set; }

    public DateTime CreatedAt { get; set; }

    public DateTime UpdatedAt { get; set; }

    public string? WatchListItemId { get; set; }

    public string? AcquisitionTargetId { get; set; }

    /// <summary>Comma-separated info hashes the approval grabbed; the request is fulfilled once all complete.</summary>
    public string? GrabbedHashes { get; set; }

    /// <summary>
    /// Per-season high-water mark ("6:4,7:0") written when a season request is fulfilled: once reopened by a newly
    /// aired episode, only episodes above it count, so an episode the owner deleted stays deleted. Null until fulfilled.
    /// </summary>
    public string? FulfilledThrough { get; set; }

    /// <summary>
    /// Per-season, the last episode this request has ever wanted ("6:4"). A wanted row missing at or below it means the
    /// owner removed or stopped looking for that episode, so nothing (approval re-grab, airing check, Retry) adds it back;
    /// only episodes above it are new. Null until the request first queues something.
    /// </summary>
    public string? CoveredThrough { get; set; }

    /// <summary>
    /// The stopped transfers the requester and owner were told about: sorted, comma-separated hashes; null when none. A
    /// hash not in it is news; a set that only shrank is stored without telling anyone again.
    /// </summary>
    public string? StoppedKey { get; set; }

    public virtual User RequestedBy { get; set; } = null!;
}
