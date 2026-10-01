using System;
using System.Collections.Generic;

namespace TorrentFlow.Data.Entities;

public partial class GrabJob
{
    public string Id { get; set; } = null!;

    public string UserId { get; set; } = null!;

    public string Title { get; set; } = null!;

    public string Query { get; set; } = null!;

    public string Status { get; set; } = null!;

    public string? Message { get; set; }

    public string? Magnet { get; set; }

    public string? InfoHash { get; set; }

    public string? Source { get; set; }

    public string? SavePath { get; set; }

    public string? Category { get; set; }

    public string? Kind { get; set; }

    public string? ExternalId { get; set; }

    public DateTime CreatedAt { get; set; }

    public DateTime UpdatedAt { get; set; }

    public string? Retention { get; set; }

    /// <summary>The ladder rung that found this release, "kind: query" ("exact: Frieren S01E05").</summary>
    public string? Rung { get; set; }

    /// <summary>The language verdict and its basis ("Japanese audio, English subtitles (name)", or "fallback: ...").</summary>
    public string? Language { get; set; }

    public virtual User User { get; set; } = null!;
}
