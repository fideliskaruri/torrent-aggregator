using System;
using System.Collections.Generic;

namespace TorrentFlow.Data.Entities;

public partial class DownloadHistory
{
    public string Id { get; set; } = null!;

    public string UserId { get; set; } = null!;

    public string Title { get; set; } = null!;

    public string? Magnet { get; set; }

    public string? TorrentUrl { get; set; }

    public string? InfoHash { get; set; }

    public string? Source { get; set; }

    public string Status { get; set; } = null!;

    public string? Message { get; set; }

    public DateTime CreatedAt { get; set; }

    public string? Context { get; set; }

    public string? Category { get; set; }

    public string? SavePath { get; set; }

    public string? ClientType { get; set; }

    public string? SendKind { get; set; }

    public string? Retention { get; set; }

    public string? WorkId { get; set; }

    public virtual User User { get; set; } = null!;

    public virtual Work? Work { get; set; }
}
