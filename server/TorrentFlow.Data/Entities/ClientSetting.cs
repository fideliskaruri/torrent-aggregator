using System;
using System.Collections.Generic;

namespace TorrentFlow.Data.Entities;

public partial class ClientSetting
{
    public string Id { get; set; } = null!;

    public string UserId { get; set; } = null!;

    public string ClientType { get; set; } = null!;

    public string? ExternalClientType { get; set; }

    public string Host { get; set; } = null!;

    public string? Username { get; set; }

    public string? Password { get; set; }

    public string? Category { get; set; }

    public string? SavePath { get; set; }

    public string? BaseDownloadPath { get; set; }

    public long? MaxStorageBytes { get; set; }

    /// <summary>Owner's cap on kept downloads transferring at once; null uses the engine default.</summary>
    public int? MaxActiveDownloads { get; set; }

    /// <summary>Weekly download hours as JSON (DownloadWindows); null or empty = downloads any time.</summary>
    public string? DownloadWindows { get; set; }

    public string? Categories { get; set; }

    public string? PathRules { get; set; }

    public DateTime CreatedAt { get; set; }

    public DateTime UpdatedAt { get; set; }

    public int? PreferredResolution { get; set; }

    public int? AutomationIntervalMinutes { get; set; }

    public string? PreProbeScope { get; set; }

    public string DefaultRetentionPolicy { get; set; } = null!;

    public bool? StorageCapConfigured { get; set; }

    public bool? VerboseDiagnostics { get; set; }

    public virtual User User { get; set; } = null!;
}
