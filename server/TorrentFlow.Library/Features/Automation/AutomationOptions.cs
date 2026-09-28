using System.ComponentModel.DataAnnotations;

namespace TorrentFlow.Library.Features.Automation;

public sealed class AutomationOptions
{
    /// <summary>Applies to every anime acquisition, not only scheduled downloads. Subbed/dual audio is the default.</summary>
    public bool PreferAnimeDub { get; set; }
    [Range(0, 100000)] public int MinimumSeeders { get; set; } = 3;
    [Range(0, 10080)] public int SeederWaitTimeoutMinutes { get; set; } = 360;
    [Range(1, 60)] public int SeederRecheckMinutes { get; set; } = 15;
    [Range(0, 60000)] public int ItemSpacingMilliseconds { get; set; } = 1000;
}
