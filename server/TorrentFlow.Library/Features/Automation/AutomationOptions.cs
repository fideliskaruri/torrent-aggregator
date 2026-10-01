using System.ComponentModel.DataAnnotations;

namespace TorrentFlow.Library.Features.Automation;

public sealed class AutomationOptions
{
    [Range(0, 100000)] public int MinimumSeeders { get; set; } = 3;
    [Range(0, 10080)] public int SeederWaitTimeoutMinutes { get; set; } = 360;
    [Range(1, 60)] public int SeederRecheckMinutes { get; set; } = 15;
    [Range(0, 60000)] public int ItemSpacingMilliseconds { get; set; } = 1000;
    /// <summary>Season pack fallback v1 (docs/season-pack-fallback.md). Off until the owner turns it on.</summary>
    public bool SeasonPackFallback { get; set; }
    /// <summary>Real misses an episode needs before a season pack may fill it.</summary>
    [Range(1, 20)] public int SeasonPackMisses { get; set; } = 2;
    /// <summary>How many season pack candidates are inspected (file list fetched) per attempt.</summary>
    [Range(1, 20)] public int SeasonPackProbes { get; set; } = 4;
    /// <summary>Scales the wanted queue retry waits; below 1 only for test runs.</summary>
    [Range(0.001, 10)] public double WantedRetryScale { get; set; } = 1.0;
}
