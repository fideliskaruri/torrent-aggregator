using System;
using System.Collections.Generic;

namespace TorrentFlow.Data.Entities;

public partial class Work
{
    public string Id { get; set; } = null!;

    public string WorkKey { get; set; } = null!;

    public string CanonicalTitle { get; set; } = null!;

    public int? Year { get; set; }

    public string MediaType { get; set; } = null!;

    public string? AliasesJson { get; set; }

    public string? Provider { get; set; }

    public string? ProviderId { get; set; }

    public string? PosterUrl { get; set; }

    public DateTime CreatedAt { get; set; }

    public DateTime UpdatedAt { get; set; }

    public virtual ICollection<AcquisitionTarget> AcquisitionTargets { get; set; } = new List<AcquisitionTarget>();

    public virtual ICollection<CatalogEntry> CatalogEntries { get; set; } = new List<CatalogEntry>();

    public virtual ICollection<DownloadHistory> DownloadHistories { get; set; } = new List<DownloadHistory>();

    public virtual ICollection<EngineTorrent> EngineTorrents { get; set; } = new List<EngineTorrent>();

    public virtual ICollection<PlaybackProgress> PlaybackProgresses { get; set; } = new List<PlaybackProgress>();

    public virtual ICollection<WatchListItem> WatchListItems { get; set; } = new List<WatchListItem>();
}
