using System;
using System.Collections.Generic;

namespace TorrentFlow.Data.Entities;

public partial class User
{
    public string Id { get; set; } = null!;

    public string? Name { get; set; }

    public string? Email { get; set; }

    public string? Image { get; set; }

    public DateTime CreatedAt { get; set; }

    public DateTime UpdatedAt { get; set; }

    public virtual ICollection<AcquisitionTarget> AcquisitionTargets { get; set; } = new List<AcquisitionTarget>();

    public virtual ICollection<AutoRule> AutoRules { get; set; } = new List<AutoRule>();

    public virtual ClientSetting? ClientSetting { get; set; }

    public virtual ICollection<DownloadHistory> DownloadHistories { get; set; } = new List<DownloadHistory>();

    public virtual ICollection<EngineTorrent> EngineTorrents { get; set; } = new List<EngineTorrent>();

    public virtual ICollection<GrabJob> GrabJobs { get; set; } = new List<GrabJob>();

    public virtual ICollection<PlaybackProgress> PlaybackProgresses { get; set; } = new List<PlaybackProgress>();

    public virtual ICollection<WatchListItem> WatchListItems { get; set; } = new List<WatchListItem>();
}
