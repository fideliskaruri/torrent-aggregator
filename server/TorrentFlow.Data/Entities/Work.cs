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

    /// <summary>Unlabelled names from before <see cref="NamesJson"/>; kept for rollback, read by nothing.</summary>
    public string? AliasesJson { get; set; }

    /// <summary>Labelled names; read them through <see cref="ReadNames"/>.</summary>
    public string? NamesJson { get; set; }

    /// <summary>Ids at every provider; read them through <see cref="ReadIds"/>.</summary>
    public string? IdsJson { get; set; }

    public string? Provider { get; set; }

    public string? ProviderId { get; set; }

    public string? PosterUrl { get; set; }

    public DateTime CreatedAt { get; set; }

    public DateTime UpdatedAt { get; set; }

    public virtual ICollection<AcquisitionTarget> AcquisitionTargets { get; set; } = new List<AcquisitionTarget>();

    public virtual ICollection<CatalogEntry> CatalogEntries { get; set; } = new List<CatalogEntry>();

    public virtual ICollection<DownloadHistory> DownloadHistories { get; set; } = new List<DownloadHistory>();

    public virtual ICollection<EngineTorrent> EngineTorrents { get; set; } = new List<EngineTorrent>();

    public virtual ICollection<WatchListItem> WatchListItems { get; set; } = new List<WatchListItem>();
}
