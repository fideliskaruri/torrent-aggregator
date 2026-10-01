namespace TorrentFlow.Core;

/// <summary>
/// What a download setting means when the owner has not chosen one (the stored column is null or out of range).
/// Every reader of the settings row uses these, so the settings page and the code that acts on it agree.
/// </summary>
public static class SettingsDefaults
{
    public static readonly int[] SelectableResolutions = [480, 720, 1080, 2160];
    public const int Resolution = 1080;

    public static readonly int[] AutomationIntervals = [0, 30, 120, 360];
    public const int AutomationIntervalMinutes = 0;

    /// <summary>The owner's preferred resolution, or the default when unset or not one of the choices.</summary>
    public static int ResolutionOrDefault(int? stored) =>
        stored is { } r && SelectableResolutions.Contains(r) ? r : Resolution;

    public static int AutomationIntervalOrDefault(int? stored) =>
        stored is { } m && AutomationIntervals.Contains(m) ? m : AutomationIntervalMinutes;
}
